const logger = require('../monitoring/logger');
const sessionStore = require('./sessionStore');
const { assertState, canTransition, transition } = require('./stateMachine');
const { hasRequiredFieldsForTransition } = require('./requiredFields');
const hubspotClient = require('../integrations/hubspotClient');
const calendarClient = require('../integrations/calendarClient');
const twilioSms = require('../integrations/twilioSms');
const { buildIdempotencyKey, withIdempotency } = require('../governance/withIdempotency');
const { assertDeploymentAllowed, GATED_TOOLS } = require('../governance/deploymentGate');
const { alertCritical, ALERT_EVENT_TYPES } = require('../monitoring/alerting');

const ALLOWED_TOOLS = Object.freeze([
  'capture_identity',
  'confirm_address',
  'capture_problem',
  'begin_scheduling',
  'propose_slots',
  'book_estimate',
  'request_sms_consent',
  'send_confirmation_sms',
  'escalate_call',
  'finalize_and_log'
]);

function buildError(toolName, code, message, details) {
  return {
    ok: false,
    tool: toolName,
    error: {
      code,
      message,
      ...(details ? { details } : {})
    }
  };
}

function success(toolName, session, data = {}) {
  return {
    ok: true,
    tool: toolName,
    state: session.state,
    data
  };
}

function sanitizePayloadSummary(payload = {}) {
  const summary = {};
  for (const [key, value] of Object.entries(payload)) {
    summary[key] = typeof value;
  }
  return summary;
}

function validateString(payload, key, { optional = false } = {}) {
  const value = payload[key];
  if (value == null && optional) {
    return;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw Object.assign(new Error(`Invalid or missing field: ${key}`), {
      code: 'invalid_payload',
      details: { field: key }
    });
  }
}


const LOCKED_ESTIMATE_SCHEDULED_STAGE_ID = '3233958615';
const LOCKED_SMS_SENT_STAGE_ID = '3233958613';

function hasCrmSchedulingContext(session) {
  return session?.hubspot?.crmReady === true
    && Boolean(session?.hubspot?.contactId)
    && Boolean(session?.hubspot?.dealId);
}

function assertSchedulingPreconditions(session) {
  if (!hasCrmSchedulingContext(session)) {
    throw Object.assign(new Error('Scheduling requires crmReady with contact and deal IDs'), {
      code: 'missing_prerequisites'
    });
  }
}

function assertCrmReadyOrThrow(session) {
  if (session?.hubspot?.crmReady !== true) {
    throw Object.assign(new Error('CRM is not ready for this operation'), {
      code: 'crm_not_ready'
    });
  }
}

function coerceHubspotBoolean(value) {
  if (value === true || value === 'true' || value === 'TRUE') {
    return true;
  }
  if (value === false || value === 'false' || value === 'FALSE') {
    return false;
  }
  return null;
}

function formatBookingLabel(startISO, timeZone) {
  const date = new Date(startISO);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

function shortErrorMessage(error) {
  return String(error?.message || 'unknown').replace(/\s+/g, ' ').slice(0, 140);
}

async function readConsentState(session) {
  const sessionConsent = session?.contactConsent;
  if (sessionConsent && typeof sessionConsent.consent === 'boolean') {
    return {
      consent: sessionConsent.consent,
      consentTsISO: sessionConsent.consentTsISO || null,
      source: 'session'
    };
  }

  const contactId = session?.hubspot?.contactId;
  if (!contactId) {
    return { consent: null, consentTsISO: null, source: 'none' };
  }

  const contact = await hubspotClient.getContactById(contactId);
  const consent = coerceHubspotBoolean(contact?.properties?.sms_customer_consent);
  const consentTsISO = contact?.properties?.sms_customer_consent_ts || null;

  return {
    consent,
    consentTsISO,
    source: 'hubspot',
    phone: contact?.properties?.phone || null
  };
}

function findSelectedSlot(payload, proposedSlots) {
  if (payload.slotStartISO) {
    const match = proposedSlots.find((slot) => slot.startISO === payload.slotStartISO);
    if (!match) {
      throw Object.assign(new Error('Selected slot does not exist in proposed slots'), {
        code: 'invalid_payload',
        details: { field: 'slotStartISO' }
      });
    }
    return match;
  }

  if (payload.slotIndex != null) {
    if (!Number.isInteger(payload.slotIndex) || payload.slotIndex < 0 || payload.slotIndex >= proposedSlots.length) {
      throw Object.assign(new Error('slotIndex is out of range'), {
        code: 'invalid_payload',
        details: { field: 'slotIndex' }
      });
    }

    return proposedSlots[payload.slotIndex];
  }

  throw Object.assign(new Error('book_estimate requires slotStartISO or slotIndex'), {
    code: 'invalid_payload',
    details: { field: 'slotStartISO|slotIndex' }
  });
}

function assertRequiredForTransition(session, nextState) {
  const requiredCheck = hasRequiredFieldsForTransition(session, nextState);
  if (!requiredCheck.ok) {
    throw Object.assign(new Error('Required fields missing for transition'), {
      code: 'missing_required_fields',
      details: requiredCheck
    });
  }
}


function assertAllowedState(session, allowedStates) {
  try {
    assertState(session, allowedStates);
  } catch (error) {
    throw Object.assign(new Error(error.message), {
      code: 'illegal_state',
      details: {
        state: session?.state || null,
        allowedStates
      }
    });
  }
}

function assertTransitionAllowed(session, nextState) {
  if (!canTransition(session.state, nextState)) {
    throw Object.assign(new Error(`Illegal transition ${session.state} -> ${nextState}`), {
      code: 'illegal_state',
      details: { from: session.state, to: nextState }
    });
  }
}

async function maybeUpsertContact(callSid, session, props) {
  if (session?.hubspot?.crmReady !== true) {
    return;
  }

  await hubspotClient.upsertContact(props, { callSid });
}

async function maybeLogEngagement(callSid, session, noteBody) {
  if (session?.hubspot?.crmReady !== true) {
    return;
  }

  const { contactId, dealId } = session.hubspot || {};
  if (!contactId || !dealId) {
    throw Object.assign(new Error('HubSpot IDs missing'), {
      code: 'missing_hubspot_ids',
      details: { contactId: Boolean(contactId), dealId: Boolean(dealId) }
    });
  }

  await hubspotClient.logEngagement(dealId, contactId, { callSid, noteBody });
}

async function handleCaptureIdentity({ callSid, session, payload }) {
  assertAllowedState(session, ['CALL_STARTED']);
  validateString(payload, 'firstname');
  validateString(payload, 'lastname');
  validateString(payload, 'phone', { optional: true });

  session.contact = {
    firstname: payload.firstname.trim(),
    lastname: payload.lastname.trim(),
    ...(payload.phone ? { phone: payload.phone.trim() } : {})
  };

  assertRequiredForTransition(session, 'IDENTITY_CHECKED');
  assertTransitionAllowed(session, 'IDENTITY_CHECKED');
  transition(session, 'IDENTITY_CHECKED', 'tool:capture_identity');

  await maybeUpsertContact(callSid, session, session.contact);

  return success('capture_identity', session, {
    contactCaptured: true
  });
}

async function handleConfirmAddress({ callSid, session, payload }) {
  assertAllowedState(session, ['IDENTITY_CHECKED']);
  validateString(payload, 'service_street_1');
  validateString(payload, 'service_city');
  validateString(payload, 'service_state');
  validateString(payload, 'service_postal_code');

  session.address = {
    service_street_1: payload.service_street_1.trim(),
    service_city: payload.service_city.trim(),
    service_state: payload.service_state.trim(),
    service_postal_code: payload.service_postal_code.trim()
  };

  assertRequiredForTransition(session, 'ADDRESS_CONFIRMED');
  assertTransitionAllowed(session, 'ADDRESS_CONFIRMED');
  transition(session, 'ADDRESS_CONFIRMED', 'tool:confirm_address');

  await maybeUpsertContact(callSid, session, session.address);

  return success('confirm_address', session, {
    addressConfirmed: true
  });
}

async function handleCaptureProblem({ callSid, session, payload }) {
  assertAllowedState(session, ['ADDRESS_CONFIRMED']);
  validateString(payload, 'problem_summary');

  session.problem = {
    problem_summary: payload.problem_summary.trim()
  };

  assertRequiredForTransition(session, 'PROBLEM_CAPTURED');
  assertTransitionAllowed(session, 'PROBLEM_CAPTURED');
  transition(session, 'PROBLEM_CAPTURED', 'tool:capture_problem');

  const noteBody = `Problem captured: ${session.problem.problem_summary}`;
  await maybeLogEngagement(callSid, session, noteBody);

  return success('capture_problem', session, {
    problemCaptured: true
  });
}

async function handleBeginScheduling({ session }) {
  assertAllowedState(session, ['PROBLEM_CAPTURED']);

  assertSchedulingPreconditions(session);

  assertRequiredForTransition(session, 'SCHEDULING');
  assertTransitionAllowed(session, 'SCHEDULING');
  transition(session, 'SCHEDULING', 'tool:begin_scheduling');

  return success('begin_scheduling', session, {
    next: 'propose_slots',
    window: 'next_business_hours'
  });
}


async function handleProposeSlots({ session, payload }) {
  assertAllowedState(session, ['SCHEDULING']);
  assertSchedulingPreconditions(session);

  const requestedCount = payload.count == null ? 3 : Number(payload.count);
  if (!Number.isInteger(requestedCount) || requestedCount <= 0) {
    throw Object.assign(new Error('count must be a positive integer'), {
      code: 'invalid_payload',
      details: { field: 'count' }
    });
  }

  const count = Math.min(requestedCount, 5);
  const nowISO = new Date().toISOString();
  const proposedSlots = await calendarClient.proposeSlots({ count, nowISO });

  session.scheduling = {
    proposedSlots,
    proposedAtISO: nowISO,
    serviceRadius: payload.serviceRadius || null
  };

  return success('propose_slots', session, {
    proposedSlots
  });
}

async function handleBookEstimate({ callSid, session, payload }) {
  assertAllowedState(session, ['SCHEDULING']);
  assertSchedulingPreconditions(session);

  const proposedSlots = session?.scheduling?.proposedSlots || [];
  if (!Array.isArray(proposedSlots) || proposedSlots.length === 0) {
    throw Object.assign(new Error('No proposed slots available to book'), {
      code: 'missing_prerequisites',
      details: { field: 'scheduling.proposedSlots' }
    });
  }

  const problemSummary = session?.problem?.problem_summary;
  if (!problemSummary) {
    throw Object.assign(new Error('problem_summary is required before booking'), {
      code: 'missing_prerequisites',
      details: { field: 'problem.problem_summary' }
    });
  }

  const selectedSlot = findSelectedSlot(payload, proposedSlots);

  try {
    const booking = await calendarClient.bookSlot({
      callSid,
      slotStartISO: selectedSlot.startISO,
      slotEndISO: selectedSlot.endISO,
      summary: `Plumbing Estimate - ${session.contact?.firstname || 'Customer'} ${session.contact?.lastname || ''}`.trim(),
      description: `Problem summary: ${problemSummary}`,
      attendees: [{ phone: session.callerPhone }]
    });

    session.booking = booking;

    await hubspotClient.updateDealStage({
      dealId: session.hubspot.dealId,
      pipelineId: hubspotClient.LOCKED_PIPELINE_ID,
      dealstage: LOCKED_ESTIMATE_SCHEDULED_STAGE_ID,
      callSid
    });

    const noteBody = `Estimate booked for ${booking.startISO} to ${booking.endISO}. Calendar event: ${booking.calendarEventId}. Link: ${booking.htmlLink || 'n/a'}`;
    await hubspotClient.logEngagement(session.hubspot.dealId, session.hubspot.contactId, {
      callSid,
      noteBody
    });

    assertTransitionAllowed(session, 'BOOKED');
    transition(session, 'BOOKED', 'tool:book_estimate');

    return success('book_estimate', session, {
      booking
    });
  } catch (error) {
    logger.error('[tools] book_estimate failed.', {
      callSid,
      streamSid: session.streamSid,
      tool: 'book_estimate',
      message: error.message
    });

    await alertCritical(ALERT_EVENT_TYPES.CALENDAR_BOOKING_FAILURE, {
      callSid,
      streamSid: session.streamSid,
      source: 'toolRouter.handleBookEstimate',
      message: error.message,
      errorCode: error.code || 'calendar_booking_failed'
    });

    if (session?.hubspot?.crmReady === true && session?.hubspot?.dealId && session?.hubspot?.contactId) {
      await hubspotClient.logEngagement(session.hubspot.dealId, session.hubspot.contactId, {
        callSid,
        noteBody: `Calendar booking failed: ${error.message.slice(0, 160)}`
      });
    }

    return buildError('book_estimate', 'calendar_booking_failed', 'Failed to book estimate slot', {
      message: error.message
    });
  }
}

async function handleRequestSmsConsent({ callSid, session, payload }) {
  assertAllowedState(session, ['BOOKED']);

  if (typeof payload.consent !== 'boolean') {
    throw Object.assign(new Error('request_sms_consent requires boolean consent'), {
      code: 'invalid_payload',
      details: { field: 'consent' }
    });
  }

  assertCrmReadyOrThrow(session);

  if (payload.consent === true) {
    const consentTsISO = new Date().toISOString();
    await hubspotClient.updateContactConsent({
      contactId: session.hubspot.contactId,
      consent: true,
      consentTsISO,
      callSid
    });

    session.contactConsent = {
      consent: true,
      consentTsISO
    };

    return success('request_sms_consent', session, { consent: true, consentTsISO });
  }

  session.contactConsent = {
    consent: false,
    consentTsISO: null
  };

  await maybeLogEngagement(callSid, session, 'Customer declined SMS consent.');

  return success('request_sms_consent', session, { consent: false, consentTsISO: null });
}

async function handleSendConfirmationSms({ callSid, session }) {
  assertAllowedState(session, ['BOOKED']);
  assertCrmReadyOrThrow(session);

  const { contactId, dealId } = session.hubspot || {};
  if (!contactId || !dealId) {
    throw Object.assign(new Error('HubSpot IDs missing'), {
      code: 'missing_hubspot_ids',
      details: { contactId: Boolean(contactId), dealId: Boolean(dealId) }
    });
  }

  const booking = session.booking;
  if (!booking?.startISO || !booking?.endISO) {
    throw Object.assign(new Error('Booking with start/end is required before confirmation SMS'), {
      code: 'missing_prerequisites',
      details: { field: 'booking.startISO|booking.endISO' }
    });
  }

  let consentState = await readConsentState(session);
  if (consentState.source === 'session') {
    consentState = await readConsentState({ hubspot: { contactId } });
  }

  if (consentState.consent !== true) {
    return buildError('send_confirmation_sms', 'sms_consent_required', 'SMS consent is required before sending confirmation SMS');
  }

  if (!consentState.consentTsISO) {
    return buildError('send_confirmation_sms', 'sms_consent_ts_missing', 'SMS consent timestamp is required before sending confirmation SMS');
  }

  const contactPhone = session?.contact?.phone || consentState.phone;
  if (!contactPhone) {
    throw Object.assign(new Error('Contact phone is required for confirmation SMS'), {
      code: 'missing_prerequisites',
      details: { field: 'contact.phone' }
    });
  }

  const timeZone = process.env.BUSINESS_TIMEZONE || 'America/New_York';
  const localDateTimeLabel = formatBookingLabel(booking.startISO, timeZone);
  const body = `Your estimate is scheduled for ${localDateTimeLabel} (${timeZone}). Reply YES to confirm or call us if you need to reschedule.`;

  const idempotencyKey = buildIdempotencyKey({
    tenant: 'single',
    callSid,
    operation: 'twilio_send_sms',
    inputs: {
      to: contactPhone,
      bodyTemplateIdOrBody: body,
      dealId
    }
  });

  try {
    twilioSms.assertTwilioSmsConfigured();
    const smsResult = await withIdempotency({
      key: idempotencyKey,
      loggerContext: { callSid, operation: 'twilio_send_sms' },
      fn: async () => twilioSms.sendSms({ to: contactPhone, body })
    });

    assertRequiredForTransition({ ...session, contactConsent: { consent: true, consentTsISO: consentState.consentTsISO } }, 'CONFIRMED_SMS_SENT');
    assertTransitionAllowed(session, 'CONFIRMED_SMS_SENT');
    transition(session, 'CONFIRMED_SMS_SENT', 'tool:send_confirmation_sms');

    await hubspotClient.updateDealStage({
      dealId,
      pipelineId: hubspotClient.LOCKED_PIPELINE_ID,
      dealstage: LOCKED_SMS_SENT_STAGE_ID,
      callSid
    });

    await maybeLogEngagement(callSid, session, `SMS sent (${smsResult.messageSid}) for booked time ${localDateTimeLabel}.`);

    return success('send_confirmation_sms', session, {
      messageSid: smsResult.messageSid,
      to: contactPhone,
      bodyPreview: body.slice(0, 120)
    });
  } catch (error) {
    await maybeLogEngagement(callSid, session, `SMS send failed: ${shortErrorMessage(error)}`);
    await alertCritical(ALERT_EVENT_TYPES.TWILIO_STREAM_FAILURE, {
      callSid,
      streamSid: session.streamSid,
      source: 'toolRouter.handleSendConfirmationSms',
      message: error.message,
      errorCode: error.code || 'sms_send_failed'
    });
    return buildError('send_confirmation_sms', 'sms_send_failed', 'Failed to send confirmation SMS', { message: error.message });
  }
}

async function handleFinalizeAndLog({ callSid, session }) {
  assertAllowedState(session, ['PROBLEM_CAPTURED', 'SCHEDULING', 'BOOKED', 'CONFIRMED_SMS_SENT', 'ESCALATED']);

  if (session?.hubspot?.crmReady === true) {
    const { contactId, dealId } = session.hubspot || {};
    if (!contactId || !dealId) {
      throw Object.assign(new Error('HubSpot IDs missing'), {
        code: 'missing_hubspot_ids',
        details: { contactId: Boolean(contactId), dealId: Boolean(dealId) }
      });
    }

    await hubspotClient.logEngagement(dealId, contactId, {
      callSid,
      noteBody: 'Call ended. Summary pending. TranscriptRef pending.'
    });
  }

  assertTransitionAllowed(session, 'LOGGED_TO_HUBSPOT');
  transition(session, 'LOGGED_TO_HUBSPOT', 'tool:finalize_and_log');
  assertTransitionAllowed(session, 'CALL_ENDED');
  transition(session, 'CALL_ENDED', 'tool:finalize_and_log');

  sessionStore.endSession(callSid, 'finalized');

  return success('finalize_and_log', session, {
    ended: true
  });
}

const handlers = {
  capture_identity: handleCaptureIdentity,
  confirm_address: handleConfirmAddress,
  capture_problem: handleCaptureProblem,
  begin_scheduling: handleBeginScheduling,
  propose_slots: handleProposeSlots,
  book_estimate: handleBookEstimate,
  request_sms_consent: handleRequestSmsConsent,
  send_confirmation_sms: handleSendConfirmationSms,
  finalize_and_log: handleFinalizeAndLog
};

function isHubspotEnabled() {
  return String(process.env.HUBSPOT_ENABLED || '').trim().toLowerCase() === 'true';
}

async function enforceDeploymentGate({ callSid, toolName, session }) {
  if (!GATED_TOOLS.includes(toolName)) {
    return null;
  }

  if (!isHubspotEnabled() || session?.hubspot?.crmReady !== true) {
    return buildError(toolName, 'crm_not_ready', 'CRM is not ready for this operation');
  }

  const companyId = process.env.HUBSPOT_COMPANY_ID;
  const company = await hubspotClient.getCompanyById(companyId);
  const deploymentStatus = company?.properties?.deployment_status || null;
  const callerPhoneE164 = session?.callerPhoneE164 || session?.contact?.phone || session?.callerPhone;
  const gate = assertDeploymentAllowed({
    session,
    toolName,
    callerPhoneE164,
    deploymentStatus
  });

  if (gate.allowed) {
    return null;
  }

  return buildError(toolName, gate.code || 'deployment_unknown', 'Deployment status does not allow this tool', {
    deployment_status: deploymentStatus,
    reason: gate.reason
  });
}


async function dispatchTool({ callSid, toolName, payload }) {
  try {
    sessionStore.touchSession(callSid);
    const session = sessionStore.getSession(callSid);

    if (!session) {
      return buildError(toolName, 'session_not_found', 'Session not found for callSid');
    }

    logger.info('[tools] Dispatch.', {
      callSid,
      streamSid: session.streamSid,
      toolName,
      state: session.state,
      payloadSummary: sanitizePayloadSummary(payload)
    });

    if (!ALLOWED_TOOLS.includes(toolName)) {
      return buildError(toolName, 'invalid_tool', 'Tool is not allowed');
    }

    const handler = handlers[toolName];
    if (!handler) {
      return buildError(toolName, 'not_implemented', 'Tool handler not implemented');
    }

    const deploymentGateError = await enforceDeploymentGate({ callSid, toolName, session });
    if (deploymentGateError) {
      return deploymentGateError;
    }

    return await handler({
      callSid,
      session,
      payload: payload || {}
    });
  } catch (error) {
    const alertEventTypeByTool = {
      book_estimate: ALERT_EVENT_TYPES.CALENDAR_BOOKING_FAILURE,
      send_confirmation_sms: ALERT_EVENT_TYPES.TWILIO_STREAM_FAILURE,
      capture_identity: ALERT_EVENT_TYPES.HUBSPOT_WRITE_FAILURE,
      confirm_address: ALERT_EVENT_TYPES.HUBSPOT_WRITE_FAILURE,
      capture_problem: ALERT_EVENT_TYPES.HUBSPOT_WRITE_FAILURE,
      request_sms_consent: ALERT_EVENT_TYPES.HUBSPOT_WRITE_FAILURE,
      finalize_and_log: ALERT_EVENT_TYPES.HUBSPOT_WRITE_FAILURE
    };

    const alertEventType = alertEventTypeByTool[toolName];
    if (alertEventType) {
      await alertCritical(alertEventType, {
        callSid,
        streamSid: sessionStore.getSession(callSid)?.streamSid || 'unknown-stream',
        source: 'toolRouter.dispatchTool',
        message: error.message,
        errorCode: error.code || 'tool_error',
        toolName
      });
    }

    return buildError(toolName, error.code || 'tool_error', error.message, error.details);
  }
}

module.exports = {
  ALLOWED_TOOLS,
  dispatchTool
};
