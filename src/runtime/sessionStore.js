const logger = require('../monitoring/logger');

const sessions = new Map();
const DEFAULT_TTL_MINUTES = 30;
const JANITOR_INTERVAL_MS = 60 * 1000;
let janitorHandle;

function getTtlMinutes() {
  const raw = Number(process.env.SESSION_TTL_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TTL_MINUTES;
  }
  return raw;
}

function nowIso() {
  return new Date().toISOString();
}

function createSession(callSid, streamSid, callerPhone) {
  const now = nowIso();
  const session = {
    callSid,
    streamSid,
    callerPhone,
    state: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    auditLog: []
  };

  sessions.set(callSid, session);
  return session;
}

function getSession(callSid) {
  return sessions.get(callSid);
}

function updateSession(callSid, patch) {
  const session = sessions.get(callSid);
  if (!session) {
    return null;
  }

  const next = {
    ...session,
    ...patch,
    updatedAt: nowIso()
  };
  sessions.set(callSid, next);
  return next;
}

function touchSession(callSid) {
  const session = sessions.get(callSid);
  if (!session) {
    return null;
  }

  const now = nowIso();
  session.lastSeenAt = now;
  session.updatedAt = now;
  return session;
}

function endSession(callSid, reason) {
  const session = sessions.get(callSid);
  if (!session) {
    return null;
  }

  sessions.delete(callSid);
  logger.info('[session] Session ended.', {
    callSid: session.callSid,
    streamSid: session.streamSid,
    reason: reason || 'ended'
  });
  return session;
}

function cleanupExpiredSessions() {
  const nowMs = Date.now();
  const ttlMinutes = getTtlMinutes();
  const ttlMs = ttlMinutes * 60 * 1000;

  for (const [callSid, session] of sessions.entries()) {
    const lastSeenMs = Date.parse(session.lastSeenAt);
    if (Number.isNaN(lastSeenMs)) {
      continue;
    }

    if (nowMs - lastSeenMs > ttlMs) {
      sessions.delete(callSid);
      logger.info('[session] Session expired.', {
        callSid: session.callSid,
        streamSid: session.streamSid,
        lastSeenAt: session.lastSeenAt,
        ttlMinutes,
        reason: 'ttl_expired'
      });
    }
  }
}

function startSessionJanitor() {
  if (janitorHandle) {
    return janitorHandle;
  }

  janitorHandle = setInterval(cleanupExpiredSessions, JANITOR_INTERVAL_MS);
  if (typeof janitorHandle.unref === 'function') {
    janitorHandle.unref();
  }
  logger.info('[session] Janitor started.', {
    intervalSeconds: JANITOR_INTERVAL_MS / 1000,
    ttlMinutes: getTtlMinutes()
  });
  return janitorHandle;
}

module.exports = {
  createSession,
  getSession,
  updateSession,
  touchSession,
  endSession,
  cleanupExpiredSessions,
  startSessionJanitor
};
