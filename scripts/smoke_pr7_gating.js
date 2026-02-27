const deploymentGate = require('../src/governance/deploymentGate');
const sessionStore = require('../src/runtime/sessionStore');
const hubspotClient = require('../src/integrations/hubspotClient');
const { dispatchTool } = require('../src/runtime/toolRouter');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function testAssertDeploymentAllowed() {
  const gatedTool = 'begin_scheduling';

  const testerSession = {};
  const testerAllowed = deploymentGate.assertDeploymentAllowed({
    session: testerSession,
    toolName: gatedTool,
    callerPhoneE164: '+17162508937',
    deploymentStatus: 'provisioning'
  });
  assert(testerAllowed.allowed === true, 'allowlisted tester should be allowed in provisioning');

  const nonTesterSession = {};
  const nonTesterDenied = deploymentGate.assertDeploymentAllowed({
    session: nonTesterSession,
    toolName: gatedTool,
    callerPhoneE164: '+17165551212',
    deploymentStatus: 'provisioning'
  });
  assert(nonTesterDenied.allowed === false, 'non-allowlisted caller should be denied in provisioning');
  assert(nonTesterDenied.code === 'deployment_test_only', 'expected deployment_test_only code');

  const liveSession = {};
  const liveAllowed = deploymentGate.assertDeploymentAllowed({
    session: liveSession,
    toolName: gatedTool,
    callerPhoneE164: '+17165551212',
    deploymentStatus: 'live'
  });
  assert(liveAllowed.allowed === true, 'any caller should be allowed in live');

  const suspendedSession = {};
  const suspendedDenied = deploymentGate.assertDeploymentAllowed({
    session: suspendedSession,
    toolName: gatedTool,
    callerPhoneE164: '+17162508937',
    deploymentStatus: 'suspended'
  });
  assert(suspendedDenied.allowed === false, 'any caller should be denied in suspended');
  assert(suspendedDenied.code === 'deployment_blocked', 'expected deployment_blocked code');
}

async function testToolRouterPath() {
  process.env.HUBSPOT_ENABLED = 'true';
  process.env.HUBSPOT_COMPANY_ID = '304267668200';

  const originalGetCompanyById = hubspotClient.getCompanyById;
  hubspotClient.getCompanyById = async () => ({
    id: process.env.HUBSPOT_COMPANY_ID,
    properties: { deployment_status: 'provisioning' }
  });

  const callSid = 'CA_SMOKE_PR7';
  const streamSid = 'MZ_SMOKE_PR7';
  const session = sessionStore.createSession(callSid, streamSid, '+17165551212');
  session.state = 'PROBLEM_CAPTURED';
  session.hubspot = { crmReady: true, contactId: '123', dealId: '456' };

  const denied = await dispatchTool({ callSid, toolName: 'begin_scheduling', payload: {} });
  assert(denied.ok === false, 'dispatch should deny non-allowlisted caller in provisioning');
  assert(denied.error.code === 'deployment_test_only', 'toolRouter should return deployment_test_only');

  sessionStore.endSession(callSid, 'smoke_done');
  hubspotClient.getCompanyById = originalGetCompanyById;
}

async function main() {
  testAssertDeploymentAllowed();
  await testToolRouterPath();
  console.log('smoke_pr7_gating: ok');
}

main().catch((error) => {
  console.error('smoke_pr7_gating: failed', error);
  process.exit(1);
});
