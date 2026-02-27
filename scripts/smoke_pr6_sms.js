const assert = require('node:assert/strict');
const sessionStore = require('../src/runtime/sessionStore');
const { transition } = require('../src/runtime/stateMachine');
const { dispatchTool } = require('../src/runtime/toolRouter');
const hubspotClient = require('../src/integrations/hubspotClient');
const twilioSms = require('../src/integrations/twilioSms');
const { initIdempotency } = require('../src/governance/idempotencyStore');
const { buildIdempotencyKey, withIdempotency } = require('../src/governance/withIdempotency');

async function run() {
  await initIdempotency('./.data/idempotency-smoke-pr6.sqlite');

  const callSid = `CA_SMOKE_PR6_${Date.now()}`;
  sessionStore.createSession(callSid, 'MZ_SMOKE', '+15550001111');
  const session = sessionStore.getSession(callSid);
  transition(session, 'CALL_STARTED', 'smoke:start');

  session.hubspot = {
    crmReady: true,
    contactId: 'contact-pr6',
    dealId: 'deal-pr6'
  };
  session.state = 'BOOKED';
  session.booking = {
    startISO: '2026-02-01T15:00:00.000Z',
    endISO: '2026-02-01T16:00:00.000Z'
  };
  session.contact = {
    phone: '+15551234567'
  };

  hubspotClient.logEngagement = async () => ({ ok: true });

  let stageUpdateCount = 0;
  hubspotClient.updateDealStage = async ({ dealId, pipelineId, dealstage, callSid: idpCallSid }) => {
    const key = buildIdempotencyKey({
      tenant: 'single',
      callSid: idpCallSid,
      operation: 'hubspot_update_deal_stage',
      inputs: { dealId, pipelineId, dealstage }
    });

    return withIdempotency({
      key,
      loggerContext: { callSid: idpCallSid, operation: 'hubspot_update_deal_stage' },
      fn: async () => {
        stageUpdateCount += 1;
        return { ok: true };
      }
    });
  };

  let consentStoreCount = 0;
  hubspotClient.updateContactConsent = async ({ consent, consentTsISO }) => {
    consentStoreCount += 1;
    assert.equal(consent, true);
    assert.ok(consentTsISO);
    return { ok: true };
  };

  hubspotClient.getContactById = async () => ({
    id: 'contact-pr6',
    properties: {
      phone: '+15551234567',
      sms_customer_consent: session.contactConsent?.consent === true ? 'true' : 'false',
      sms_customer_consent_ts: session.contactConsent?.consentTsISO || null
    }
  });

  let sendCount = 0;
  twilioSms.assertTwilioSmsConfigured = () => {};
  twilioSms.sendSms = async () => {
    sendCount += 1;
    return { messageSid: 'SM_PR6_FIXED' };
  };

  const blocked = await dispatchTool({
    callSid,
    toolName: 'send_confirmation_sms',
    payload: {}
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'sms_consent_required');
  assert.equal(sendCount, 0);

  const consented = await dispatchTool({
    callSid,
    toolName: 'request_sms_consent',
    payload: { consent: true }
  });
  assert.equal(consented.ok, true);
  assert.equal(consented.data.consent, true);
  assert.ok(consented.data.consentTsISO);
  assert.equal(consentStoreCount, 1);

  const sent = await dispatchTool({
    callSid,
    toolName: 'send_confirmation_sms',
    payload: {}
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.state, 'CONFIRMED_SMS_SENT');
  assert.equal(sent.data.messageSid, 'SM_PR6_FIXED');
  assert.equal(stageUpdateCount, 1);
  assert.equal(sendCount, 1);

  session.state = 'BOOKED';
  const replay = await dispatchTool({
    callSid,
    toolName: 'send_confirmation_sms',
    payload: {}
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.data.messageSid, 'SM_PR6_FIXED');
  assert.equal(sendCount, 1);
  assert.equal(stageUpdateCount, 1);

  console.log('PR6 SMS smoke test passed.');
}

run().catch((error) => {
  console.error('PR6 SMS smoke test failed.', error);
  process.exit(1);
});
