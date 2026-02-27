function validateEnv(requiredVars = ['OPENAI_API_KEY']) {
  const missing = requiredVars.filter((name) => !process.env[name] || !String(process.env[name]).trim());

  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
}

module.exports = {
  validateEnv
};
