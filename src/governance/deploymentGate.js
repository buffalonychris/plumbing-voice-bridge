const GATED_TOOLS = Object.freeze([
  'begin_scheduling',
  'propose_slots',
  'book_estimate',
  'request_sms_consent',
  'send_confirmation_sms'
]);

const FALLBACK_TESTERS = Object.freeze([
  '+17162508937',
  '+17165471378'
]);

function normalizeE164(phone) {
  if (phone == null) {
    return phone;
  }

  const raw = String(phone).trim();
  if (!raw) {
    return raw;
  }

  const stripped = raw.replace(/[\s\-()]/g, '');
  if (stripped.startsWith('+') && /^\+\d{7,15}$/.test(stripped)) {
    return stripped;
  }

  return stripped;
}

function getTesterAllowlist() {
  const allowlist = new Set();
  const fromEnv = String(process.env.TEST_CALLER_ALLOWLIST || '')
    .split(',')
    .map((value) => normalizeE164(value))
    .filter(Boolean);

  for (const phone of [...FALLBACK_TESTERS, ...fromEnv]) {
    allowlist.add(normalizeE164(phone));
  }

  return allowlist;
}

function isTesterCaller(phoneE164) {
  const normalized = normalizeE164(phoneE164);
  if (!normalized) {
    return false;
  }

  return getTesterAllowlist().has(normalized);
}

function classifyDeploymentStatus(statusInternalName) {
  const status = String(statusInternalName || '').trim().toLowerCase();

  if (status === 'live') {
    return 'open';
  }

  if (['not_deployed', 'provisioning', 'awaiting_forwarding'].includes(status)) {
    return 'test_only';
  }

  if (['suspended', 'cancelled'].includes(status)) {
    return 'blocked';
  }

  return 'unknown';
}

function assertDeploymentAllowed({ session, toolName, callerPhoneE164, deploymentStatus }) {
  if (!GATED_TOOLS.includes(toolName)) {
    return { allowed: true, reason: 'not_gated' };
  }

  const classification = classifyDeploymentStatus(deploymentStatus);
  const isTester = isTesterCaller(callerPhoneE164);
  let allowed = false;
  let reason = 'deployment_unknown';
  let code = 'deployment_unknown';

  if (classification === 'open') {
    allowed = true;
    reason = 'status_open';
    code = null;
  } else if (classification === 'test_only') {
    allowed = isTester;
    reason = isTester ? 'status_test_only_tester' : 'deployment_test_only';
    code = isTester ? null : 'deployment_test_only';
  } else if (classification === 'blocked') {
    allowed = false;
    reason = 'deployment_blocked';
    code = 'deployment_blocked';
  }

  session.deployment = {
    status: deploymentStatus || null,
    classification,
    allowed,
    reason,
    isTester
  };

  return {
    allowed,
    reason,
    code,
    classification,
    isTester
  };
}

module.exports = {
  GATED_TOOLS,
  normalizeE164,
  getTesterAllowlist,
  isTesterCaller,
  classifyDeploymentStatus,
  assertDeploymentAllowed
};
