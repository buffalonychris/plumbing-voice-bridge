const fs = require('fs');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { validateEnv } = require('./config/env');
const {
  DEFAULT_PORT,
  DEFAULT_OPENAI_REALTIME_MODEL,
  DEFAULT_OPENAI_VOICE,
  DEFAULT_OPERATOR_COMPANY_NAME,
  DEFAULT_PROMPT_PATH
} = require('./config/constants');
const logger = require('./monitoring/logger');
require('dotenv').config();

const PORT = Number(process.env.PORT || DEFAULT_PORT);
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || DEFAULT_OPENAI_REALTIME_MODEL;
const OPENAI_VOICE = process.env.OPENAI_VOICE || DEFAULT_OPENAI_VOICE;
const OPERATOR_COMPANY_NAME = process.env.OPERATOR_COMPANY_NAME || DEFAULT_OPERATOR_COMPANY_NAME;

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

    if (msg.event === 'start') {
      callSid = msg.start?.callSid || callSid;
      streamSid = msg.start?.streamSid || streamSid;
      twilioStreamStarted = true;
      logState('Twilio stream started.', { callSid, streamSid });

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
      closeBoth('twilio_stop');
    }
  });

  twilioSocket.on('close', () => {
    logState('Twilio socket closed.', { callSid, streamSid });
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

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`[startup] plumbing-voice-bridge listening on 0.0.0.0:${PORT}`);
});
