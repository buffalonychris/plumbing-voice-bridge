function isTrue(raw) {
  return String(raw || '').trim().toLowerCase() === 'true';
}

function isMissing(name) {
  return !process.env[name] || !String(process.env[name]).trim();
}

function validateHubspotEnv() {
  if (!isTrue(process.env.HUBSPOT_ENABLED)) {
    return;
  }

  const missing = [];
  if (isMissing('HUBSPOT_ACCESS_TOKEN')) {
    missing.push('HUBSPOT_ACCESS_TOKEN');
  }
  if (isMissing('HUBSPOT_COMPANY_ID')) {
    missing.push('HUBSPOT_COMPANY_ID');
  }

  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
}

function validateStripeEnv() {
  if (isTrue(process.env.STRIPE_ENABLED) && isMissing('STRIPE_WEBHOOK_SECRET')) {
    throw new Error('Missing required environment variable(s): STRIPE_WEBHOOK_SECRET');
  }
}

function validateEnv(requiredVars = ['OPENAI_API_KEY']) {
  const missing = requiredVars.filter((name) => isMissing(name));

  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  validateHubspotEnv();
  validateStripeEnv();
}

function isHubspotEnabled() {
  return isTrue(process.env.HUBSPOT_ENABLED);
}

module.exports = {
  validateEnv,
  validateHubspotEnv,
  validateStripeEnv,
  isHubspotEnabled
};
