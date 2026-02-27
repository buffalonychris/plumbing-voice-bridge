const assert = require('node:assert/strict');
const sessionStore = require('../src/runtime/sessionStore');
const { transition } = require('../src/runtime/stateMachine');
const { dispatchTool } = require('../src/runtime/toolRouter');
const hubspotClient = require('../src/integrations/hubspotClient');
const calendarClient = require('../src/integrations/calendarClient');
const { buildIdempotencyKey, withIdempotency } = require('../src/governance/withIdempotency');
const { initIdempotency } = require('../src/governance/idempotencyStore');

async function run() {
  await initIdempotency('./.data/idempotency-smoke-pr5.sqlite');
  const callSid = `CA_SMOKE_PR5_${Date.now()}`;
  sessionStore.createSession(callSid, 'MZ_SMOKE', '+15550001111');
  const session = sessionStore.getSession(callSid);
  transition(session, 'CALL_STARTED', 'smoke:start');

  hubspotClient.upsertContact = async () => ({ id: 'contact-smoke' });
  hubspotClient.logEngagement = async () => ({ ok: true });
  hubspotClient.updateDealStage = async () => ({ ok: true });

  calendarClient.proposeSlots = async ({ count }) => {
    const base = Date.parse('2026-01-06T14:00:00.000Z');
    return Array.from({ length: count }).map((_, idx) => {
      const start = new Date(base + idx * 60 * 60 * 1000).toISOString();
      const end = new Date(base + (idx + 1) * 60 * 60 * 1000).toISOString();
      return { startISO: start, endISO: end, label: `Slot ${idx + 1}` };
    });
  };

  calendarClient.bookSlot = async ({ callSid: idpCallSid, slotStartISO, slotEndISO, summary }) => {
    const key = buildIdempotencyKey({
      tenant: 'single',
      callSid: idpCallSid,
      operation: 'calendar_book_event',
      inputs: { slotStartISO, slotEndISO, summary }
    });

    return withIdempotency({
      key,
      loggerContext: { callSid: idpCallSid, operation: 'calendar_book_event' },
      fn: async () => ({
        calendarEventId: `evt_${Date.now()}`,
        htmlLink: 'https://calendar.google.test/event',
        startISO: slotStartISO,
        endISO: slotEndISO
      })
    });
  };

  session.hubspot = {
    crmReady: true,
    contactId: 'contact-smoke',
    dealId: 'deal-smoke'
  };

  let result = await dispatchTool({
    callSid,
    toolName: 'capture_identity',
    payload: { firstname: 'Ada', lastname: 'Lovelace' }
  });
  assert.equal(result.ok, true);

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

  result = await dispatchTool({
    callSid,
    toolName: 'capture_problem',
    payload: { problem_summary: 'Water heater replacement estimate' }
  });
  assert.equal(result.ok, true);

  result = await dispatchTool({ callSid, toolName: 'begin_scheduling', payload: {} });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'SCHEDULING');

  const proposedOne = await dispatchTool({ callSid, toolName: 'propose_slots', payload: { count: 3 } });
  const proposedTwo = await dispatchTool({ callSid, toolName: 'propose_slots', payload: { count: 3 } });
  assert.deepEqual(proposedOne.data.proposedSlots, proposedTwo.data.proposedSlots);

  const booked = await dispatchTool({ callSid, toolName: 'book_estimate', payload: { slotIndex: 0 } });
  assert.equal(booked.ok, true);
  assert.equal(booked.state, 'BOOKED');

  session.state = 'SCHEDULING';
  const replay = await dispatchTool({ callSid, toolName: 'book_estimate', payload: { slotIndex: 0 } });
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.data.booking, booked.data.booking);

  const blockedCallSid = `CA_SMOKE_PR5_BLOCK_${Date.now()}`;
  sessionStore.createSession(blockedCallSid, 'MZ_SMOKE_B', '+15550001112');
  const blockedSession = sessionStore.getSession(blockedCallSid);
  transition(blockedSession, 'CALL_STARTED', 'smoke:start');
  blockedSession.hubspot = { crmReady: false };
  blockedSession.problem = { problem_summary: 'Leak' };
  blockedSession.state = 'SCHEDULING';

  const blocked = await dispatchTool({ callSid: blockedCallSid, toolName: 'book_estimate', payload: { slotStartISO: '2026-01-06T14:00:00.000Z' } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'missing_prerequisites');

  console.log('PR5 booking smoke test passed.');
}

run().catch((error) => {
  console.error('PR5 booking smoke test failed.', error);
  process.exit(1);
});
