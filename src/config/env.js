function isTrue(raw) {
  return String(raw || '').trim().toLowerCase() === 'true';
}

function isMissing(name) {
  return !process.env[name] || !String(process.env[name]).trim();
}

function validateHubspotEnv() {
  if (isTrue(process.env.HUBSPOT_ENABLED) && isMissing('HUBSPOT_ACCESS_TOKEN')) {
    throw new Error('Missing required environment variable(s): HUBSPOT_ACCESS_TOKEN');
  }
}

function validateEnv(requiredVars = ['OPENAI_API_KEY']) {
  const missing = requiredVars.filter((name) => isMissing(name));

  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  validateHubspotEnv();
}

function isHubspotEnabled() {
  return isTrue(process.env.HUBSPOT_ENABLED);
}

module.exports = {
  validateEnv,
  validateHubspotEnv,
  isHubspotEnabled
};
