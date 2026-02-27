const TWILIO_BASE_URL = 'https://api.twilio.com/2010-04-01';

function isMissing(name) {
  return !process.env[name] || !String(process.env[name]).trim();
}

function assertTwilioSmsConfigured() {
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'];
  const missing = required.filter((name) => isMissing(name));
  if (missing.length) {
    const error = new Error(`Missing required Twilio SMS environment variable(s): ${missing.join(', ')}`);
    error.code = 'twilio_sms_not_configured';
    throw error;
  }
}

async function sendSms({ to, body }) {
  assertTwilioSmsConfigured();

  if (typeof to !== 'string' || !to.trim()) {
    const error = new Error('Twilio SMS send requires non-empty to');
    error.code = 'invalid_sms_to';
    throw error;
  }

  if (typeof body !== 'string' || !body.trim()) {
    const error = new Error('Twilio SMS send requires non-empty body');
    error.code = 'invalid_sms_body';
    throw error;
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  const encoded = new URLSearchParams({
    To: to.trim(),
    From: from.trim(),
    Body: body.trim()
  });

  const authHeader = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const response = await fetch(`${TWILIO_BASE_URL}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authHeader}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: encoded.toString()
  });

  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }

  if (!response.ok) {
    const error = new Error(payload?.message || 'Twilio SMS API request failed');
    error.code = payload?.code ? `twilio_${payload.code}` : 'twilio_sms_request_failed';
    error.status = response.status;
    error.details = payload;
    throw error;
  }

  return {
    messageSid: payload.sid
  };
}

module.exports = {
  assertTwilioSmsConfigured,
  sendSms
};
