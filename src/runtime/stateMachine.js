const logger = require('../monitoring/logger');

const STATES = Object.freeze([
  'CALL_STARTED',
  'IDENTITY_CHECKED',
  'ADDRESS_CONFIRMED',
  'PROBLEM_CAPTURED',
  'SCHEDULING',
  'BOOKED',
  'CONFIRMED_SMS_SENT',
  'LOGGED_TO_HUBSPOT',
  'ESCALATED',
  'CALL_ENDED'
]);

function canTransition(from, to) {
  if (!STATES.includes(to)) {
    return false;
  }

  if (from == null) {
    return to === 'CALL_STARTED';
  }

  if (!STATES.includes(from) || from === to || from === 'CALL_ENDED') {
    return false;
  }

  if (to === 'CALL_ENDED') {
    return true;
  }

  if (to === 'LOGGED_TO_HUBSPOT') {
    return ['PROBLEM_CAPTURED', 'SCHEDULING', 'BOOKED', 'CONFIRMED_SMS_SENT', 'ESCALATED'].includes(from);
  }

  const fromIndex = STATES.indexOf(from);
  const toIndex = STATES.indexOf(to);
  return toIndex === fromIndex + 1;
}

function assertState(session, allowedStates) {
  if (!session || !allowedStates.includes(session.state)) {
    throw new Error(`Invalid session state. Expected one of: ${allowedStates.join(', ')}`);
  }
}

function transition(session, nextState, reason) {
  if (!session) {
    throw new Error('Session is required for transition.');
  }

  const previousState = session.state;
  if (!canTransition(previousState, nextState)) {
    throw new Error(`Invalid transition ${previousState || 'null'} -> ${nextState}`);
  }

  const ts = new Date().toISOString();
  session.state = nextState;
  session.updatedAt = ts;
  session.lastSeenAt = ts;
  session.auditLog.push({
    ts,
    callSid: session.callSid,
    previousState,
    nextState,
    reason
  });

  logger.info('[state] Transition applied.', {
    callSid: session.callSid,
    previousState,
    nextState,
    reason,
    streamSid: session.streamSid
  });

  return session;
}

module.exports = {
  STATES,
  canTransition,
  assertState,
  transition
};
