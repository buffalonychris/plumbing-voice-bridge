const fs = require('fs');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { validateEnv, validateHubspotEnv, isHubspotEnabled } = require('./config/env');
const {
  DEFAULT_PORT,
  DEFAULT_OPENAI_REALTIME_MODEL,
  DEFAULT_OPENAI_VOICE,
  DEFAULT_OPERATOR_COMPANY_NAME,
  DEFAULT_PROMPT_PATH
} = require('./config/constants');
const logger = require('./monitoring/logger');
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
  logEngagement
} = require('./integrations/hubspotClient');
require('dotenv').config();

try {
  validateHubspotEnv();
} catch (envError) {
  logger.error('[startup] HubSpot configuration invalid.', { error: envError.message });
  process.exit(1);
}

const PORT = Number(process.env.PORT || DEFAULT_PORT);
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || DEFAULT_OPENAI_REALTIME_MODEL;
const OPENAI_VOICE = process.env.OPENAI_VOICE || DEFAULT_OPENAI_VOICE;
const OPERATOR_COMPANY_NAME = process.env.OPERATOR_COMPANY_NAME || DEFAULT_OPERATOR_COMPANY_NAME;
const IDP_ENABLED = String(process.env.IDP_ENABLED || 'true').trim().toLowerCase() === 'true';
const IDP_DB_PATH = process.env.IDP_DB_PATH || './.data/idempotency.sqlite';

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
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'plumbing-voice-bridge' });
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
      }
    });

    openAiSocket.on('close', (code, reasonBuffer) => {
      openAiReady = false;
      logState('OpenAI socket closed.', {
        callSid,
        streamSid,
        code,
        reason: reasonBuffer?.toString() || ''
      });
      if (twilioSocket.readyState === WebSocket.OPEN) {
        twilioSocket.close();
      }
    });

    openAiSocket.on('error', (error) => {
      logger.error('[stream] OpenAI socket error.', { callSid, streamSid, error: error.message });
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
        .catch((error) => {
          logger.error('[hubspot] Unexpected intake failure.', {
            callSid,
            streamSid,
            error: error.message
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
    finalizeCall('twilio_close');
    if (openAiSocket && openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  });

  twilioSocket.on('error', (error) => {
    logger.error('[stream] Twilio socket error.', { callSid, streamSid, error: error.message });
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

  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`[startup] plumbing-voice-bridge listening on 0.0.0.0:${PORT}`);
  });
}

bootstrap();
