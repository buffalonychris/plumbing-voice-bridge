const { getIdempotency, setIdempotency } = require('../governance/idempotencyStore');
const { stableHashOfInputs } = require('../governance/withIdempotency');
const logger = require('./logger');

const EMAIL_API_URL = 'https://api.resend.com/emails';

const ALERT_EVENT_TYPES = Object.freeze({
  HUBSPOT_WRITE_FAILURE: 'hubspot_write_failure',
  CALENDAR_BOOKING_FAILURE: 'calendar_booking_failure',
  TWILIO_STREAM_FAILURE: 'twilio_stream_failure',
  OPENAI_SESSION_FAILURE: 'openai_session_failure',
  OAUTH_REFRESH_FAILURE: 'oauth_refresh_failure'
});

function trimEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function buildNormalizedPayload(eventType, context = {}) {
  const callSid = String(context.callSid || 'unknown-call').trim() || 'unknown-call';
  const streamSid = String(context.streamSid || 'unknown-stream').trim() || 'unknown-stream';
  const message = String(context.message || '').trim() || 'Unknown failure';
  const source = String(context.source || 'plumbing-voice-bridge').trim();

  return {
    eventType,
    callSid,
    streamSid,
    source,
    message,
    errorCode: context.errorCode || null,
    status: context.status || null,
    timestamp: new Date().toISOString(),
    context: context && typeof context === 'object' ? context : {}
  };
}

function buildIdempotencyKey(payload) {
  const contextHash = stableHashOfInputs(payload.context || {});
  return `alert:${payload.eventType}:${payload.callSid}:${contextHash}`;
}

async function sendOwnerSms(payload) {
  const to = trimEnv('OWNER_ALERT_PHONE_E164');
  if (!to) {
    logger.warn('[alerting] OWNER_ALERT_PHONE_E164 not configured. Skipping SMS alert.', {
      eventType: payload.eventType,
      callSid: payload.callSid
    });
    return { skipped: true, reason: 'missing_owner_phone' };
  }

  const accountSid = trimEnv('TWILIO_ACCOUNT_SID');
  const authToken = trimEnv('TWILIO_AUTH_TOKEN');
  const from = trimEnv('TWILIO_ALERT_FROM_NUMBER') || trimEnv('TWILIO_FROM_NUMBER');

  if (!accountSid || !authToken || !from) {
    logger.warn('[alerting] Twilio alert SMS config missing. Skipping SMS alert.', {
      eventType: payload.eventType,
      callSid: payload.callSid,
      hasAccountSid: Boolean(accountSid),
      hasAuthToken: Boolean(authToken),
      hasFrom: Boolean(from)
    });
    return { skipped: true, reason: 'missing_twilio_alert_config' };
  }

  const body = `[ALERT:${payload.eventType}] callSid=${payload.callSid} streamSid=${payload.streamSid} msg=${payload.message.slice(0, 120)}`;

  const authHeader = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const encoded = new URLSearchParams({ To: to, From: from, Body: body });

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authHeader}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: encoded.toString()
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Alert SMS send failed (${response.status}): ${raw.slice(0, 250)}`);
  }

  let json;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = {};
  }

  return { messageSid: json.sid || null };
}

async function sendOwnerEmail(payload) {
  const to = trimEnv('OWNER_ALERT_EMAIL');
  if (!to) {
    logger.warn('[alerting] OWNER_ALERT_EMAIL not configured. Skipping email alert.', {
      eventType: payload.eventType,
      callSid: payload.callSid
    });
    return { skipped: true, reason: 'missing_owner_email' };
  }

  const apiKey = trimEnv('EMAIL_PROVIDER_API_KEY');
  if (!apiKey) {
    logger.warn('[alerting] EMAIL_PROVIDER_API_KEY not configured. Skipping email alert.', {
      eventType: payload.eventType,
      callSid: payload.callSid
    });
    return { skipped: true, reason: 'missing_email_provider_key' };
  }

  const response = await fetch(EMAIL_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'alerts@plumbing-voice-bridge.local',
      to: [to],
      subject: `[Critical Alert] ${payload.eventType} (${payload.callSid})`,
      text: [
        `eventType: ${payload.eventType}`,
        `callSid: ${payload.callSid}`,
        `streamSid: ${payload.streamSid}`,
        `source: ${payload.source}`,
        `message: ${payload.message}`,
        `errorCode: ${payload.errorCode || ''}`,
        `status: ${payload.status || ''}`,
        `timestamp: ${payload.timestamp}`,
        '',
        `context: ${JSON.stringify(payload.context)}`
      ].join('\n')
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Alert email send failed (${response.status}): ${raw.slice(0, 250)}`);
  }

  let json;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = {};
  }

  return { emailId: json.id || null };
}

async function alertCritical(eventType, context = {}) {
  if (!Object.values(ALERT_EVENT_TYPES).includes(eventType)) {
    throw new Error(`Unknown alert eventType: ${eventType}`);
  }

  const payload = buildNormalizedPayload(eventType, context);
  const idempotencyKey = buildIdempotencyKey(payload);

  const existing = await getIdempotency(idempotencyKey);
  if (existing) {
    logger.info('[alerting] idempotency_hit', {
      eventType: payload.eventType,
      callSid: payload.callSid,
      idempotencyKey
    });
    return {
      ok: true,
      deduped: true,
      eventType: payload.eventType,
      idempotencyKey,
      result: existing
    };
  }

  let smsResult;
  let emailResult;
  try {
    smsResult = await sendOwnerSms(payload);
    emailResult = await sendOwnerEmail(payload);
  } catch (error) {
    logger.error('[alerting] alert_send_failed', {
      eventType: payload.eventType,
      callSid: payload.callSid,
      idempotencyKey,
      message: error.message
    });

    return {
      ok: false,
      deduped: false,
      eventType: payload.eventType,
      idempotencyKey,
      error: error.message
    };
  }

  const result = {
    sent: true,
    eventType: payload.eventType,
    callSid: payload.callSid,
    streamSid: payload.streamSid,
    sms: smsResult,
    email: emailResult,
    sentAt: new Date().toISOString()
  };

  await setIdempotency(idempotencyKey, result);
  logger.info('[alerting] alert_sent', {
    eventType: payload.eventType,
    callSid: payload.callSid,
    idempotencyKey
  });

  return {
    ok: true,
    deduped: false,
    eventType: payload.eventType,
    idempotencyKey,
    result
  };
}

module.exports = {
  ALERT_EVENT_TYPES,
  alertCritical,
  buildNormalizedPayload
};
