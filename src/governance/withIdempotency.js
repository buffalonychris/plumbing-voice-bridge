const crypto = require('crypto');
const logger = require('../monitoring/logger');
const { getIdempotency, setIdempotency } = require('./idempotencyStore');

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        const normalizedValue = value[key];
        if (normalizedValue !== undefined) {
          acc[key] = canonicalize(normalizedValue);
        }
        return acc;
      }, {});
  }

  return value;
}

function stableHashOfInputs(inputs) {
  const canonical = canonicalize(inputs || {});
  const serialized = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function buildIdempotencyKey({ tenant, callSid, operation, inputs }) {
  const hash = stableHashOfInputs(inputs);
  return `${tenant}:${callSid}:${operation}:${hash}`;
}

async function withIdempotency({ key, fn, loggerContext = {} }) {
  const idpEnabled = String(process.env.IDP_ENABLED || 'true').trim().toLowerCase() === 'true';
  if (!idpEnabled) {
    logger.warn('[idempotency] bypassed because IDP_ENABLED=false', loggerContext);
    return fn();
  }

  const hit = await getIdempotency(key);
  if (hit) {
    logger.info('[idempotency] idempotency_hit', {
      key,
      ...loggerContext
    });
    return hit;
  }

  const result = await fn();
  await setIdempotency(key, result);

  logger.info('[idempotency] idempotency_set', {
    key,
    ...loggerContext
  });

  return result;
}

module.exports = {
  stableHashOfInputs,
  buildIdempotencyKey,
  withIdempotency
};
