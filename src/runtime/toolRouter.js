const logger = require('../monitoring/logger');
const sessionStore = require('./sessionStore');
const { assertState, canTransition, transition } = require('./stateMachine');
const { hasRequiredFieldsForTransition } = require('./requiredFields');
const hubspotClient = require('../integrations/hubspotClient');

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

  const hasHubspotContext = session?.hubspot?.crmReady === true
    && Boolean(session?.hubspot?.contactId)
    && Boolean(session?.hubspot?.dealId);
  if (!hasHubspotContext) {
    throw Object.assign(new Error('Scheduling requires crmReady with contact and deal IDs'), {
      code: 'missing_prerequisites'
    });
  }

  assertRequiredForTransition(session, 'SCHEDULING');
  assertTransitionAllowed(session, 'SCHEDULING');
  transition(session, 'SCHEDULING', 'tool:begin_scheduling');

  return success('begin_scheduling', session, {
    next: 'propose_slots',
    window: 'next_business_hours'
  });
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
  finalize_and_log: handleFinalizeAndLog
};

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

    return await handler({
      callSid,
      session,
      payload: payload || {}
    });
  } catch (error) {
    return buildError(toolName, error.code || 'tool_error', error.message, error.details);
  }
}

module.exports = {
  ALLOWED_TOOLS,
  dispatchTool
};
