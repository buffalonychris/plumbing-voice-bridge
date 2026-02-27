const fs = require('fs');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const crypto = require('crypto');
const { validateEnv, validateHubspotEnv, validateStripeEnv, isHubspotEnabled } = require('./config/env');
const {
  DEFAULT_PORT,
  DEFAULT_OPENAI_REALTIME_MODEL,
  DEFAULT_OPENAI_VOICE,
  DEFAULT_OPERATOR_COMPANY_NAME,
  DEFAULT_PROMPT_PATH
} = require('./config/constants');
const logger = require('./monitoring/logger');
const { alertCritical, ALERT_EVENT_TYPES } = require('./monitoring/alerting');
const { initIdempotency } = require('./governance/idempotencyStore');
const {
  createSession,
  getSession,
  updateSession,
  touchSession,
  endSession,
  startSessionJanitor
} = require('./runtime/sessionStore');
const { transition } = require('./runtime/stateMachine');
const {
  upsertContact,
  createDeal,
  associateDealToContact,
  logEngagement,
  getCompanyById,
  updateCompanyDeploymentStatus
} = require('./integrations/hubspotClient');
const { dispatchTool } = require('./runtime/toolRouter');
require('dotenv').config();

try {
  validateHubspotEnv();
  validateStripeEnv();
} catch (envError) {
  logger.error('[startup] Configuration invalid.', { error: envError.message });
  process.exit(1);
}

const PORT = Number(process.env.PORT || DEFAULT_PORT);
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || DEFAULT_OPENAI_REALTIME_MODEL;
const OPENAI_VOICE = process.env.OPENAI_VOICE || DEFAULT_OPENAI_VOICE;
const OPERATOR_COMPANY_NAME = process.env.OPERATOR_COMPANY_NAME || DEFAULT_OPERATOR_COMPANY_NAME;
const IDP_ENABLED = String(process.env.IDP_ENABLED || 'true').trim().toLowerCase() === 'true';
const IDP_DB_PATH = process.env.IDP_DB_PATH || './.data/idempotency.sqlite';
const STRIPE_ENABLED = String(process.env.STRIPE_ENABLED || 'false').trim().toLowerCase() === 'true';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS || 300);
let stripe = null;
if (STRIPE_ENABLED) {
  try {
    const Stripe = require('stripe');
    stripe = new Stripe(process.env.STRIPE_API_KEY || 'sk_local_unused', { apiVersion: '2024-06-20' });
  } catch (_error) {
    stripe = null;
  }
}

function loadSystemPrompt() {
  if (process.env.OPERATOR_SYSTEM_PROMPT && process.env.OPERATOR_SYSTEM_PROMPT.trim()) {
    return process.env.OPERATOR_SYSTEM_PROMPT.trim();
  }

  try {
    return fs.readFileSync(DEFAULT_PROMPT_PATH, 'utf8').trim();
  } catch (error) {
    logger.error('[startup] Failed to load default prompt file.', { error: error.message });
    return `You are ${OPERATOR_COMPANY_NAME}, a plumbing call operator. Collect caller name, service address, issue description, and urgency.`;
  }
}

const SYSTEM_PROMPT = loadSystemPrompt();

const app = express();

function parseStripeSignature(signatureHeader) {
  const parts = String(signatureHeader || '').split(',');
  const parsed = {};

  for (const part of parts) {
    const [k, v] = part.split('=');
    if (k && v) {
      parsed[k.trim()] = v.trim();
    }
  }

  return {
    timestamp: parsed.t,
    signature: parsed.v1
  };
}

function verifyStripeWebhookSignature(rawBodyBuffer, signatureHeader, secret, toleranceSeconds) {
  const { timestamp, signature } = parseStripeSignature(signatureHeader);
  if (!timestamp || !signature) {
    throw new Error('Invalid Stripe signature header');
  }

  const signedPayload = `${timestamp}.${rawBodyBuffer.toString('utf8')}`;
  const expectedSignature = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const providedBuffer = Buffer.from(signature, 'hex');

  if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    throw new Error('Stripe signature mismatch');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const age = Math.abs(nowSeconds - Number(timestamp));
  if (Number.isFinite(toleranceSeconds) && age > toleranceSeconds) {
    throw new Error('Stripe signature timestamp outside tolerance');
  }
}

app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!STRIPE_ENABLED) {
    return res.status(404).json({ ok: false });
  }

  try {
    const signature = req.headers['stripe-signature'];
    let event;

    if (stripe) {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET,
        Number.isFinite(STRIPE_WEBHOOK_TOLERANCE_SECONDS) ? STRIPE_WEBHOOK_TOLERANCE_SECONDS : 300
      );
    } else {
      verifyStripeWebhookSignature(req.body, signature, STRIPE_WEBHOOK_SECRET, Number.isFinite(STRIPE_WEBHOOK_TOLERANCE_SECONDS) ? STRIPE_WEBHOOK_TOLERANCE_SECONDS : 300);
      event = JSON.parse(req.body.toString('utf8'));
    }

    const companyId = process.env.HUBSPOT_COMPANY_ID;
    const callSid = `stripe-${event.id || 'unknown'}`;

    if (event.type === 'checkout.session.completed') {
      await updateCompanyDeploymentStatus({ companyId, deployment_status: 'live', callSid, reason: 'stripe_checkout_completed' });
    }

    if (event.type === 'invoice.paid') {
      await updateCompanyDeploymentStatus({ companyId, deployment_status: 'live', callSid, reason: 'stripe_invoice_paid' });
    }

    if (event.type === 'invoice.payment_failed') {
      await updateCompanyDeploymentStatus({ companyId, deployment_status: 'suspended', callSid, reason: 'stripe_invoice_payment_failed' });
    }

    if (event.type === 'customer.subscription.deleted') {
      await updateCompanyDeploymentStatus({ companyId, deployment_status: 'cancelled', callSid, reason: 'stripe_subscription_deleted' });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    logger.error('[stripe] Webhook handling failed.', { message: error.message });
    return res.status(400).json({ ok: false });
  }
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'plumbing-voice-bridge' });
});

app.post('/internal/tools/:callSid', async (req, res) => {
  const toolingEnabled = String(process.env.INTERNAL_TOOLING_ENABLED || '').trim().toLowerCase() === 'true';
  if (!toolingEnabled) {
    return res.status(404).json({ ok: false });
  }

  const { callSid } = req.params;
  const { toolName, payload } = req.body || {};
  const result = await dispatchTool({ callSid, toolName, payload });
  return res.status(result.ok ? 200 : 400).json(result);
});

app.post('/twilio/voice', (req, res) => {
  try {
    validateEnv();
  } catch (envError) {
    logger.error('[twilio/voice] OPENAI_API_KEY is missing; refusing call setup.', { error: envError.message });
    return res.status(500).type('text/plain').send('Server misconfiguration');
  }

  const callSid = req.body.CallSid || 'unknown-call';
  const host = req.get('x-forwarded-host') || req.get('host');
  const streamUrl = `wss://${host}/twilio/stream`;

  logger.info('[twilio/voice] Building TwiML response.', { callSid, streamUrl });

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${streamUrl}" />
  </Start>
  <Say>Thanks for calling. One moment.</Say>
  <Pause length="600" />
</Response>`;

  res.status(200).type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wsServer = new WebSocket.Server({ noServer: true });

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function createOpenAiSocket() {
  const openAiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;

  return new WebSocket(openAiUrl, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });
}

function logState(message, state = {}) {
  logger.info(`[stream] ${message}`, state);
}

async function initializeIdempotency() {
  if (!IDP_ENABLED) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('[startup] IDP_ENABLED=false. External writes will proceed without idempotency.');
      return;
    }

    throw new Error('IDP_ENABLED=false is not allowed in production.');
  }

  const result = await initIdempotency(IDP_DB_PATH);
  logger.info('[startup] Idempotency store initialized.', { dbPath: result.dbPath });
}

async function logStartupDeploymentStatus() {
  if (!isHubspotEnabled()) {
    return;
  }

  try {
    const companyId = process.env.HUBSPOT_COMPANY_ID;
    const company = await getCompanyById(companyId);
    logger.info('[startup] HubSpot deployment status fetched.', {
      companyId,
      deployment_status: company?.properties?.deployment_status || null
    });
  } catch (error) {
    logger.error('[startup] Failed to fetch HubSpot deployment status.', {
      message: error.message,
      code: error.code,
      status: error.status
    });
  }
}


async function runHubspotIntake({ callSid, streamSid, callerPhone }) {
  if (!isHubspotEnabled()) {
    return { crmReady: false, reason: 'hubspot_disabled' };
  }

  if (!callerPhone) {
    return { crmReady: false, reason: 'missing_phone' };
  }

  try {
    const { id: contactId } = await upsertContact({ phone: callerPhone }, { callSid });
    const { id: dealId } = await createDeal({ contactId, callSid });
    await associateDealToContact(dealId, contactId, { callSid });
    await logEngagement(dealId, contactId, { callSid });

    return {
      crmReady: true,
      contactId,
      dealId
    };
  } catch (error) {
    logger.error('[hubspot] Intake failed on stream start.', {
      callSid,
      streamSid,
      status: error.status,
      errorCode: error.code,
      message: error.message,
      details: error.details
    });

    await alertCritical(ALERT_EVENT_TYPES.HUBSPOT_WRITE_FAILURE, {
      callSid,
      streamSid,
      source: 'server.runHubspotIntake',
      message: error.message,
      status: error.status || null,
      errorCode: error.code || 'hubspot_intake_failed'
    });

    return {
      crmReady: false,
      reason: 'hubspot_error',
      errorCode: error.code || 'hubspot_error',
      message: error.message
    };
  }
}

wsServer.on('connection', (twilioSocket, req) => {
  try {
    validateEnv();
  } catch (envError) {
    logger.error('[stream] OPENAI_API_KEY missing; closing Twilio stream socket.', { error: envError.message });
    twilioSocket.close(1011, 'Server misconfiguration');
    return;
  }

  const remoteAddress = req.socket.remoteAddress;
  let callSid = 'unknown-call';
  let streamSid = 'unknown-stream';
  let openAiSocket;
  let openAiReady = false;
  let agentSpeaking = false;
  let twilioStreamStarted = false;
  let sessionUpdateSent = false;
  let initialResponseCreateSent = false;
  let callFinalized = false;

  const setAgentSpeaking = (nextState, reason) => {
    if (agentSpeaking === nextState) {
      return;
    }

    agentSpeaking = nextState;
    logState('agentSpeaking transition.', {
      callSid,
      streamSid,
      agentSpeaking,
      reason
    });
  };

  logState('Twilio stream connected.', { remoteAddress });

  const closeBoth = (reason) => {
    logState('Closing stream pair.', { callSid, streamSid, reason });
    if (twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.close();
    }
    if (openAiSocket && openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  };

  const finalizeCall = (reason) => {
    if (callFinalized || callSid === 'unknown-call') {
      return;
    }

    const session = getSession(callSid);
    if (session && session.state !== 'CALL_ENDED') {
      try {
        transition(session, 'CALL_ENDED', reason);
      } catch (error) {
        logger.error('[state] Failed to transition to CALL_ENDED.', {
          callSid,
          streamSid,
          reason,
          error: error.message
        });
      }
    }

    endSession(callSid, reason);
    callFinalized = true;
  };

  const initializeOpenAi = () => {
    openAiSocket = createOpenAiSocket();

    const maybeSendInitialResponseCreate = () => {
      if (initialResponseCreateSent || !twilioStreamStarted || !sessionUpdateSent) {
        return;
      }

      if (!openAiSocket || openAiSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      openAiSocket.send(JSON.stringify({ type: 'response.create' }));
      initialResponseCreateSent = true;
      logger.info('[openai] response.create sent', { callSid, streamSid });
    };

    openAiSocket.on('open', () => {
      openAiReady = true;
      logState('Connected to OpenAI Realtime.', { callSid, streamSid, model: OPENAI_REALTIME_MODEL });

      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          instructions: SYSTEM_PROMPT,
          voice: OPENAI_VOICE,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          turn_detection: {
            type: 'server_vad'
          }
        }
      };

      openAiSocket.send(JSON.stringify(sessionUpdate));
      sessionUpdateSent = true;
      maybeSendInitialResponseCreate();
    });

    openAiSocket.on('message', (raw) => {
      const msg = safeJsonParse(raw);
      if (!msg) {
        return;
      }

      if (msg.type === 'response.done' || msg.type === 'response.completed') {
        setAgentSpeaking(false, msg.type);
      }

      if (msg.type === 'response.audio.delta' && msg.delta && twilioSocket.readyState === WebSocket.OPEN) {
        setAgentSpeaking(true, msg.type);
        const media = {
          event: 'media',
          streamSid,
          media: {
            payload: msg.delta
          }
        };
        twilioSocket.send(JSON.stringify(media));
      }

      if (msg.type === 'error') {
        const openAiErrorCode = msg.error?.code;

        if (openAiErrorCode === 'response_cancel_not_active') {
          logState('Ignoring non-fatal OpenAI cancel error.', {
            callSid,
            streamSid,
            code: openAiErrorCode,
            error: msg.error
          });
          return;
        }

        logger.error('[stream] OpenAI Realtime error.', {
          callSid,
          streamSid,
          error: msg.error || msg
        });
        alertCritical(ALERT_EVENT_TYPES.OPENAI_SESSION_FAILURE, {
          callSid,
          streamSid,
          source: 'server.openAiSocket.message',
          message: msg.error?.message || 'OpenAI realtime error message',
          errorCode: msg.error?.code || 'openai_realtime_error',
          details: msg.error || msg
        }).catch((alertError) => {
          logger.error('[alerting] Failed to send OpenAI message alert.', { callSid, streamSid, error: alertError.message });
        });
      }
    });

    openAiSocket.on('close', (code, reasonBuffer) => {
      openAiReady = false;
      const closeReason = reasonBuffer?.toString() || '';
      logState('OpenAI socket closed.', {
        callSid,
        streamSid,
        code,
        reason: closeReason
      });
      alertCritical(ALERT_EVENT_TYPES.OPENAI_SESSION_FAILURE, {
        callSid,
        streamSid,
        source: 'server.openAiSocket.close',
        message: `OpenAI socket closed (${code})`,
        errorCode: 'openai_socket_closed',
        status: code,
        reason: closeReason
      }).catch((alertError) => {
        logger.error('[alerting] Failed to send OpenAI close alert.', { callSid, streamSid, error: alertError.message });
      });
      if (twilioSocket.readyState === WebSocket.OPEN) {
        twilioSocket.close();
      }
    });

    openAiSocket.on('error', (error) => {
      logger.error('[stream] OpenAI socket error.', { callSid, streamSid, error: error.message });
      alertCritical(ALERT_EVENT_TYPES.OPENAI_SESSION_FAILURE, {
        callSid,
        streamSid,
        source: 'server.openAiSocket.error',
        message: error.message,
        errorCode: error.code || 'openai_socket_error'
      }).catch((alertError) => {
        logger.error('[alerting] Failed to send OpenAI error alert.', { callSid, streamSid, error: alertError.message });
      });
      closeBoth('openai_error');
    });
  };

  initializeOpenAi();

  twilioSocket.on('message', (raw) => {
    const msg = safeJsonParse(raw);
    if (!msg) {
      return;
    }

    if (callSid !== 'unknown-call') {
      touchSession(callSid);
    }

    if (msg.event === 'start') {
      callSid = msg.start?.callSid || callSid;
      streamSid = msg.start?.streamSid || streamSid;
      twilioStreamStarted = true;
      logState('Twilio stream started.', { callSid, streamSid });

      const callerPhone = msg.start?.customParameters?.From || msg.start?.from;
      const session = createSession(callSid, streamSid, callerPhone);
      transition(session, 'CALL_STARTED', 'twilio_stream_start');

      runHubspotIntake({ callSid, streamSid, callerPhone })
        .then((hubspot) => {
          updateSession(callSid, { hubspot });
        })
        .catch(async (error) => {
          logger.error('[hubspot] Unexpected intake failure.', {
            callSid,
            streamSid,
            error: error.message
          });
          await alertCritical(ALERT_EVENT_TYPES.HUBSPOT_WRITE_FAILURE, {
            callSid,
            streamSid,
            source: 'server.twilioSocket.start',
            message: error.message,
            errorCode: error.code || 'hubspot_intake_unexpected'
          });
          updateSession(callSid, {
            hubspot: {
              crmReady: false,
              reason: 'hubspot_error',
              errorCode: error.code || 'hubspot_error',
              message: error.message
            }
          });
        });

      if (openAiReady && sessionUpdateSent && !initialResponseCreateSent && openAiSocket?.readyState === WebSocket.OPEN) {
        openAiSocket.send(JSON.stringify({ type: 'response.create' }));
        initialResponseCreateSent = true;
        logger.info('[openai] response.create sent', { callSid, streamSid });
      }
      return;
    }

    if (msg.event === 'media') {
      if (!openAiReady || !openAiSocket || openAiSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (agentSpeaking) {
        openAiSocket.send(JSON.stringify({ type: 'response.cancel' }));
        twilioSocket.send(JSON.stringify({ event: 'clear', streamSid }));
        setAgentSpeaking(false, 'caller_interrupt');
        logState('Caller interrupted agent speech. Sent cancel/clear.', { callSid, streamSid });
      } else {
        logState('Caller media received while agent not speaking. Skipping cancel/clear.', {
          callSid,
          streamSid
        });
      }

      openAiSocket.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: msg.media.payload
      }));
      return;
    }

    if (msg.event === 'stop') {
      logState('Twilio stream stop received.', { callSid, streamSid });
      finalizeCall('twilio_stop');
      closeBoth('twilio_stop');
    }
  });

  twilioSocket.on('close', () => {
    logState('Twilio socket closed.', { callSid, streamSid });
    alertCritical(ALERT_EVENT_TYPES.TWILIO_STREAM_FAILURE, {
      callSid,
      streamSid,
      source: 'server.twilioSocket.close',
      message: 'Twilio socket closed',
      errorCode: 'twilio_socket_closed'
    }).catch((alertError) => {
      logger.error('[alerting] Failed to send Twilio close alert.', { callSid, streamSid, error: alertError.message });
    });
    finalizeCall('twilio_close');
    if (openAiSocket && openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  });

  twilioSocket.on('error', (error) => {
    logger.error('[stream] Twilio socket error.', { callSid, streamSid, error: error.message });
    alertCritical(ALERT_EVENT_TYPES.TWILIO_STREAM_FAILURE, {
      callSid,
      streamSid,
      source: 'server.twilioSocket.error',
      message: error.message,
      errorCode: error.code || 'twilio_socket_error'
    }).catch((alertError) => {
      logger.error('[alerting] Failed to send Twilio error alert.', { callSid, streamSid, error: alertError.message });
    });
    closeBoth('twilio_error');
  });
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/twilio/stream') {
    wsServer.handleUpgrade(req, socket, head, (websocket) => {
      wsServer.emit('connection', websocket, req);
    });
    return;
  }

  socket.destroy();
});

async function bootstrap() {
  try {
    await initializeIdempotency();
  } catch (error) {
    logger.error('[startup] Idempotency initialization failed.', {
      error: error.message,
      dbPath: IDP_DB_PATH
    });

    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
      return;
    }

    logger.warn('[startup] Continuing in non-production despite idempotency init failure.', {
      error: error.message
    });
  }

  startSessionJanitor();
  await logStartupDeploymentStatus();

  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`[startup] plumbing-voice-bridge listening on 0.0.0.0:${PORT}`);
  });
}

bootstrap();
