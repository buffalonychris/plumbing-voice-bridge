const assert = require('node:assert/strict');
const sessionStore = require('../src/runtime/sessionStore');
const { transition } = require('../src/runtime/stateMachine');
const { dispatchTool } = require('../src/runtime/toolRouter');
const hubspotClient = require('../src/integrations/hubspotClient');

async function run() {
  const callSid = `CA_SMOKE_${Date.now()}`;
  sessionStore.createSession(callSid, 'MZ_SMOKE', '+15550001111');
  const session = sessionStore.getSession(callSid);
  transition(session, 'CALL_STARTED', 'smoke:start');


  hubspotClient.upsertContact = async () => ({ id: 'contact-smoke' });
  hubspotClient.logEngagement = async () => ({ ok: true });

  session.hubspot = {
    crmReady: true,
    contactId: 'contact-smoke',
    dealId: 'deal-smoke'
  };

  let result = await dispatchTool({
    callSid,
    toolName: 'capture_identity',
    payload: {
      firstname: 'Ada',
      lastname: 'Lovelace',
      phone: '+15551234567'
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'IDENTITY_CHECKED');

  result = await dispatchTool({
    callSid,
    toolName: 'confirm_address',
    payload: {
      service_street_1: '123 Main St',
      service_city: 'Austin',
      service_state: 'TX',
      service_postal_code: '78701'
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'ADDRESS_CONFIRMED');

  result = await dispatchTool({
    callSid,
    toolName: 'capture_problem',
    payload: {
      problem_summary: 'Kitchen sink leak under cabinet'
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'PROBLEM_CAPTURED');

  result = await dispatchTool({
    callSid,
    toolName: 'begin_scheduling',
    payload: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'SCHEDULING');
  assert.deepEqual(result.data, { next: 'propose_slots', window: 'next_business_hours' });

  const illegal = await dispatchTool({
    callSid,
    toolName: 'capture_identity',
    payload: {
      firstname: 'Ada',
      lastname: 'Lovelace'
    }
  });
  assert.equal(illegal.ok, false);
  assert.equal(illegal.error.code, 'illegal_state');

  result = await dispatchTool({
    callSid,
    toolName: 'finalize_and_log',
    payload: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.ended, true);

  assert.equal(sessionStore.getSession(callSid), undefined);

  console.log('PR4 tool smoke test passed.');
}

run().catch((error) => {
  console.error('PR4 tool smoke test failed.', error);
  process.exit(1);
});
