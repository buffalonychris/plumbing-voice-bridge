# Plumbing Voice Bridge (Twilio Media Streams ↔ OpenAI Realtime)

Minimal production-grade voice bridge service for Phase 1 validation of a plumbing missed-call AI operator.

## What this service does

- Exposes `POST /twilio/voice` for Twilio Voice webhooks and returns TwiML.
- Exposes `WS /twilio/stream` for Twilio Media Streams.
- Opens a second WebSocket to OpenAI Realtime and relays audio both directions.
- Exposes `GET /health` for health checks.

## Endpoints

1. `POST /twilio/voice`
2. `WS /twilio/stream`
3. `GET /health`

## Environment variables

Copy `.env.example` to `.env` and fill values:

- `OPENAI_API_KEY` (**required for proxy startup behavior on Twilio voice + stream routes**)
- `OPENAI_REALTIME_MODEL` (default: `gpt-4o-realtime-preview-2024-12-17`)
- `OPENAI_VOICE` (default: `alloy`)
- `OPERATOR_COMPANY_NAME` (default: `Call Operator Pro Plumbing`)
- `OPERATOR_SYSTEM_PROMPT` (optional override; defaults to `prompts/plumbing_operator_system_prompt.txt`)
- `SESSION_TTL_MINUTES` (default: `30`)
- `HUBSPOT_ENABLED` (default: `false`; set to `true` to enable CRM intake on Twilio stream start)
- `HUBSPOT_ACCESS_TOKEN` (required only when `HUBSPOT_ENABLED=true`)
- `IDP_ENABLED` (default: `true`; in non-production you can set `false` to bypass idempotency with a warning log)
- `IDP_DB_PATH` (default local: `./.data/idempotency.sqlite`; Fly recommended: `/data/idempotency.sqlite`)
- `PORT` (default: `8080`)
- `INTERNAL_TOOLING_ENABLED` (default: `false`; when `true`, enables internal deterministic tool testing route `POST /internal/tools/:callSid`)


### Idempotency persistence (SQLite)

HubSpot write operations are protected by a persistent idempotency layer using Node's built-in `node:sqlite` module (no extra npm dependency added). The idempotency key format is:

```text
{tenant}:{callSid}:{operation}:{stableHashOfInputs}
```

For Phase 1, `tenant` is fixed to `single` and idempotency is enabled by default.

## Local proxy requirements

At minimum, set `OPENAI_API_KEY` before exercising `POST /twilio/voice` or `WS /twilio/stream`.
The service can still boot and respond to `GET /health` without it, but voice/stream proxying will refuse requests until it is set.

## Local run

```bash
npm install
npm start
```

Service binds to `0.0.0.0:${PORT:-8080}`.

### HubSpot toggle behavior

- Keep `HUBSPOT_ENABLED=false` locally to disable CRM intake and preserve relay-only behavior.
- Set `HUBSPOT_ENABLED=true` and provide `HUBSPOT_ACCESS_TOKEN` to run HubSpot intake on Twilio stream start.

Manual test:

1. Start service with `HUBSPOT_ENABLED=false`; place a call and confirm Twilio ↔ OpenAI relay still works.
2. Restart with `HUBSPOT_ENABLED=true` plus valid `HUBSPOT_ACCESS_TOKEN`; place a call and observe HubSpot intake logs on stream start.


### Local idempotency smoke test

1. Start the service with `HUBSPOT_ENABLED=true`, valid `HUBSPOT_ACCESS_TOKEN`, and `IDP_DB_PATH=./.data/idempotency.sqlite`.
2. Trigger the same intake flow twice using the same `callSid` payload through the stream-start path.
3. Confirm logs show `idempotency_set` on first write and `idempotency_hit` on replay.
4. Verify no duplicate deal creation occurs in HubSpot for the replayed call.

### Minimal local checks

Health check:

```bash
curl -i http://localhost:8080/health
```

Twilio webhook check:

```bash
curl -i -X POST http://localhost:8080/twilio/voice \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'CallSid=CA1234567890'
```

Expected: XML TwiML including `<Start><Stream url="wss://.../twilio/stream"/></Start>`.

### WebSocket testing note

`/twilio/stream` is driven by Twilio Media Streams during live calls. Local manual WS tests are optional and intentionally minimal in this Phase 1 bridge.


## Internal deterministic tooling (PR4)

Enable internal tooling endpoint locally:

```bash
export INTERNAL_TOOLING_ENABLED=true
```

This enables:

- `POST /internal/tools/:callSid`

Request body:

```json
{ "toolName": "capture_identity", "payload": { ... } }
```

Example sequence (other tools are not implemented yet and return `not_implemented`):

```bash
# 1) capture_identity
curl -s -X POST http://localhost:8080/internal/tools/CA123 \
  -H 'Content-Type: application/json' \
  -d '{"toolName":"capture_identity","payload":{"firstname":"Ada","lastname":"Lovelace","phone":"+15551234567"}}'

# 2) confirm_address
curl -s -X POST http://localhost:8080/internal/tools/CA123 \
  -H 'Content-Type: application/json' \
  -d '{"toolName":"confirm_address","payload":{"service_street_1":"123 Main St","service_city":"Austin","service_state":"TX","service_postal_code":"78701"}}'

# 3) capture_problem
curl -s -X POST http://localhost:8080/internal/tools/CA123 \
  -H 'Content-Type: application/json' \
  -d '{"toolName":"capture_problem","payload":{"problem_summary":"Kitchen sink leak under cabinet"}}'

# 4) begin_scheduling
curl -s -X POST http://localhost:8080/internal/tools/CA123 \
  -H 'Content-Type: application/json' \
  -d '{"toolName":"begin_scheduling","payload":{}}'

# 5) finalize_and_log
curl -s -X POST http://localhost:8080/internal/tools/CA123 \
  -H 'Content-Type: application/json' \
  -d '{"toolName":"finalize_and_log","payload":{}}'
```

For a local non-HTTP smoke check, run:

```bash
node scripts/smoke_pr4_tools.js
```

## Twilio setup

In Twilio Console:

1. Go to **Phone Numbers** → **Manage** → **Active numbers**.
2. Select your number.
3. In **Voice & Fax** under **A call comes in**:
   - Choose **Webhook**
   - Method: **HTTP POST**
   - URL: `https://<your-app>.fly.dev/twilio/voice`

## Fly.io deployment

### 1) Launch app (first time)

```bash
fly launch --no-deploy
```

If prompted, keep internal port as `8080`.

### 2) Set secret

```bash
fly secrets set OPENAI_API_KEY=your_real_key_here
```

(Optional) set other vars:

```bash
fly secrets set OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview-2024-12-17
fly secrets set OPENAI_VOICE=alloy
fly secrets set OPERATOR_COMPANY_NAME='Call Operator Pro Plumbing'
```

### 3) Deploy

```bash
fly deploy
```

### 4) Configure Twilio webhook URL

Use:

```text
https://<app>.fly.dev/twilio/voice
```


### Fly.io volume note for idempotency DB

Mount a Fly volume at `/data` and set:

```bash
fly secrets set IDP_DB_PATH=/data/idempotency.sqlite
```

This keeps idempotency records durable across restarts and deploys.

## Troubleshooting logs

- **Twilio logs**: Twilio Console → **Monitor** → **Logs** → **Calls** (inspect webhook errors and call events).
- **Fly logs**:

```bash
fly logs
```

Look for stream lifecycle logs including `callSid`, `streamSid`, and connection state transitions.

- **Non-fatal cancel race (`response_cancel_not_active`)**: During caller interruptions, OpenAI Realtime can occasionally return `error.code="response_cancel_not_active"` if a cancel arrives after speech has already ended. The bridge now treats this as non-fatal, logs it, and keeps both sockets open. Interruption cancel/clear is now idempotent: it is only sent while `agentSpeaking=true`, and skipped when the agent is already silent.

## Notes on audio format

Twilio Media Streams sends 8k μ-law (`g711_ulaw`) audio payloads. This bridge configures OpenAI Realtime session input and output audio format as `g711_ulaw`, so no explicit transcoding pipeline is required in Phase 1.

## Session TTL testing

The in-memory session store expires inactive calls based on `lastSeenAt` using `SESSION_TTL_MINUTES`. A janitor checks every 60 seconds.

Manual test:

1. Start service with a short TTL, for example `SESSION_TTL_MINUTES=1`.
2. Place a call and confirm normal stream logs (`start`, media relay, and close path).
3. Leave a session inactive longer than the TTL.
4. Check logs for expiration with `reason="ttl_expired"` and fields `callSid`, `streamSid`, `lastSeenAt`, and `ttlMinutes`.

## Proxy behavior compatibility

`POST /twilio/voice` response shape and the Twilio ↔ OpenAI relay flow remain unchanged. The new state/session modules only add lifecycle bookkeeping and structured transition/session logs.
