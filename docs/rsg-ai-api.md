# RSG AI Agent API

HTTP contract between the **RSG AI backend** (this repo, `src/server/`) and the
**website chat interface** (separate repo). The backend owns all Claude and
QuickBooks access; the interface owns user auth, conversation storage, and UI.

```
interface backend  ──Bearer secret──▶  RSG AI agent API  ──▶  Claude API
        ▲                                   │
   browser (your admin UI)                  └──▶  QuickBooks Online (via SSM creds)
```

Call the agent API **server-to-server** from the interface backend. Do not ship
the bearer secret to the browser.

## Running it

```bash
RSG_AI_API_KEY=<shared secret> ANTHROPIC_API_KEY=<anthropic key> npm run rsg-ai
# listens on :8787 (PORT to override); needs AWS creds with SSM read access
```

| Env var | Required | Meaning |
|---|---|---|
| `RSG_AI_API_KEY` | yes | Shared bearer secret the interface backend sends |
| `ANTHROPIC_API_KEY` | yes* | Claude API key. *Falls back to SSM `/rsg-ai/prod/anthropic-api-key` (SecureString) if unset |
| `RSG_AI_MODEL` | no | `claude-opus-4-8` (default) |
| `PORT` | no | Default `8787` |
| `RSG_AI_CORS_ORIGIN` | no | Dev only — allows direct browser calls from one origin |
| `RSG_AI_LOG_FILE` | no | Mirror the JSONL request log to a file (stdout always gets it) |
| AWS credentials | yes | SSM read for QBO creds (`/qbo-invoice-sender/prod/*`), region `us-west-1` |

**Zendesk ticket search (optional)** — enables `zendesk_ticket_search` and the
`/api/zendesk/webhook` ingestion. Each value falls back to SSM under
`/rsg-ai/prod/` if the env var is unset; if none are configured, the tool simply
reports itself unavailable and the rest of the agent is unaffected.

| Env var | SSM fallback | Meaning |
|---|---|---|
| `DATABASE_URL` | `/rsg-ai/prod/database-url` | Postgres/pgvector (RSG_Website's Vercel/Neon DB) |
| `VOYAGE_API_KEY` | `/rsg-ai/prod/voyage-api-key` | Voyage embeddings key (`voyage-3-large`, 1024-dim) |
| `ZENDESK_TOKEN` / `ZENDESK_EMAIL` | `/rsg-ai/prod/zendesk-token`, `.../zendesk-email` | Zendesk API Basic auth (subdomain `rsgsecurity`) |
| `ZENDESK_WEBHOOK_SECRET` | `/rsg-ai/prod/zendesk-webhook-secret` | HMAC secret for `/api/zendesk/webhook` |
| `ZENDESK_RECONCILE_MINUTES` | — | Reconcile interval (default 15); `ZENDESK_SYNC_ENABLED=false` disables the timer |

Schema lives in `src/zendesk/schema.sql` — apply once with `npm run zendesk:migrate`,
seed with `npm run zendesk:backfill`.

## Endpoints

All endpoints except `/healthz` require `Authorization: Bearer <RSG_AI_API_KEY>`.

### `GET /healthz`
`{ "ok": true, "model": "claude-opus-4-8" }` — no auth.

### `GET /api/tools`
`{ "tools": [{ name, description, input_schema }, ...] }` — the agent's tool
list, useful for an "what can I ask?" UI.

### `POST /api/chat` → SSE stream

Request body:

```jsonc
{
  "messages": [ /* Anthropic MessageParam[] — see below */ ],
  "user": "sheffner@rsgsecurity.com",  // REQUIRED in practice: the authenticated admin's email, for audit logging
  "role": "quality_control",           // REQUIRED: the user's admin role (website lib/roles.ts value) — gates tool access
  "chatId": "cnv_8f3a…",               // REQUIRED in practice: the interface's conversation id — tags every backend log line (tool calls included) for debugging
  "model": "claude-opus-4-8"           // optional per-request override
}
```

`messages` is the full conversation so far, ending with the new user turn. The
backend is **stateless** — the interface stores conversations and replays them.
Messages use the standard Anthropic content-block format:

```jsonc
// plain text turn
{ "role": "user", "content": "What did we pay per part for zinc alloy last quarter?" }

// turn with an uploaded document (remittance PDF etc.)
{ "role": "user", "content": [
  { "type": "document",
    "source": { "type": "base64", "media_type": "application/pdf", "data": "<base64>" },
    "title": "JCI remittance 6-9-26" },
  { "type": "text", "text": "Check this remittance was applied correctly." }
]}
```

Max request size 30 MB. Send every upload as a standard base64 block with the
file's MIME type — the backend normalizes before Claude sees it:

| Upload | Send as | Backend behavior |
|---|---|---|
| PDF | `document`, `application/pdf` | Native passthrough |
| PNG / JPG / GIF / WebP | `image` | Native; wrong/mislabeled media types auto-corrected by byte sniffing |
| CSV / TXT / MD / JSON | `document`, `text/*` base64 | Decoded to text documents |
| Excel `.xlsx` | `document`, xlsx MIME type | Converted server-side to per-sheet CSV text (capped with truncation note) |
| Legacy `.xls` | same | Best-effort; unparseable files become an in-chat note asking for `.xlsx` |

Conversion failures never 500 — they degrade to notes the agent relays.

### Response: Server-Sent Events

Each event is `event: <type>` + `data: <JSON>` (the JSON repeats `type`).
Event order: zero or more `text` / `tool_use` / `tool_result` / `artifact`
interleaved, then `done`, then exactly one `turn_complete`.

| `type` | Payload | UI treatment |
|---|---|---|
| `request_accepted` | `{ requestId, chatId }` | First event; keep the requestId for support/debugging (chatId echoes what you sent) |
| `text` | `{ text }` | Append delta to the assistant bubble |
| `tool_use` | `{ name, input }` | Show "Running landed cost report…" status chip |
| `tool_result` | `{ name, ok, error? }` | Resolve the status chip |
| `artifact` | `{ name, contentType, content }` | Offer as a download (e.g. report CSV); content is the raw text |
| `done` | `{ stopReason, usage }` | Final token usage for the turn |
| `turn_complete` | `{ requestId, chatId, newMessages, stopReason, usage }` | **Append `newMessages` to your stored conversation** and send the whole thing back on the next user turn (they contain the tool_use/tool_result blocks the model needs for context) |
| `error` | `{ error }` | Show error state; stream ends |

### Example

```bash
curl -N http://localhost:8787/api/chat \
  -H "Authorization: Bearer $RSG_AI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"How was the MIRCOM payment ref F9170 applied?"}]}'
```

### `POST /api/zendesk/webhook`

**Not called by the website** — this is the ingestion hook for Zendesk itself.
Authenticated by Zendesk's HMAC signature (headers `X-Zendesk-Webhook-Signature`
+ `X-Zendesk-Webhook-Signature-Timestamp`, secret in SSM
`/rsg-ai/prod/zendesk-webhook-secret`), **not** the bearer key, so it sits before
the bearer gate. Configure a Zendesk webhook/trigger on ticket create/update to
POST a body carrying the ticket id (`{"ticket_id":"{{ticket.id}}"}` works; the
handler also reads `id` / `ticket.id` / `detail.id`). It verifies the signature,
acks `{ ok: true, ticketId }` immediately, then re-indexes the ticket in the
background (replacing its vector rows — no duplication). Bad/absent signature →
401; missing ticket id → 400.

## Roles & tool access

`role` (body field or `X-RSG-Role` header) must be one of the website's
`lib/roles.ts` values — the list is mirrored (deliberately hardcoded) in
`src/server/permissions.js`. Missing/unknown roles get a normal assistant
message telling the user to speak with their manager (stopReason
`permission_denied`) — never an HTTP error. Disallowed tools are invisible to
the model and re-checked at dispatch.

| Tool | super_admin | finance / finance_manager | quality_control | customer_service |
|---|:-:|:-:|:-:|:-:|
| `qbo_landed_cost_report` | ✓ | ✓ | | |
| `qbo_cash_application_lookup` | ✓ | ✓ | | |
| `fulcrum_purchasing_request` | ✓ | ✓ | ✓ | |
| `fulcrum_sales_request` | ✓ | ✓ | | ✓ |
| `fulcrum_api_request` (unrestricted) | ✓ | ✓ | | |
| `zendesk_ticket_search` | ✓ | ✓ | ✓ | ✓ |
| `save_operational_note` | ✓ | ✓ | ✓ | ✓ |
| `rsg_ai_log_search` (backend logs) | ✓ | | | |

`GET /api/tools?role=<role>` returns the filtered list for a role.

## Current tools

Organized by domain under `src/tools/`:

**accounting/**
- `qbo_landed_cost_report` — per-part purchasing spend with freight/tariff/fee/tax
  allocation; emits the full table as a CSV `artifact`.
- `qbo_cash_application_lookup` — how customer payments were applied to AR
  invoices (by customer, ref number, amount, date range, or invoice number).

**fulcrum/** (read-only at the client layer: GET + POST `.../list` only;
key from SSM `/rsg-ai/prod/fulcrum-api-key` or `FULCRUM_API_KEY` env)
- `fulcrum_purchasing_request` — purchasing/receiving/quality scope: POs and
  line items, receiving receipts (packing slips: received dates/quantities),
  vendors, items/materials, inventory, CAPAs.
- `fulcrum_sales_request` — sales/CS scope: sales orders and line items,
  quotes, customers, shipments/tracking, Fulcrum invoices, production jobs.
- `fulcrum_api_request` — the unrestricted explorer (admins only).

**zendesk/** (semantic search over vectorized tickets — Postgres/pgvector +
Voyage embeddings; see `src/zendesk/` and spec 009)
- `zendesk_ticket_search` — natural-language search over ticket history (full
  thread incl. internal notes, tags, status, requester, linked tickets), with
  optional status/tags/date/requester filters. Returns cited Zendesk deep links
  and linked-ticket ids. All admin roles. Tickets are kept current by the
  `/api/zendesk/webhook` hook plus a periodic incremental-export reconciliation.

**system/**
- `save_operational_note` — the agent's self-improvement loop: durable
  discoveries (API quirks, data conventions) are appended to
  `src/server/knowledge/learned.md` and folded into its system prompt on
  every subsequent turn.
- `rsg_ai_log_search` — searches the backend's own CloudWatch logs
  (`/rsg-ai/prod`) by chatId, requestId, user, record type, or free text, so
  the agent can investigate failed conversations and recent errors on request.
  Super-admin only (logs contain every user's questions). Also runnable
  locally: `node src/cli.js rsg_ai_log_search '{"chatId":"…"}'`.

New tools added to `src/tools/index.js` appear automatically — no interface
changes needed beyond whatever you render from `/api/tools`.

## Teaching the agent (operational knowledge)

The agent's system prompt is composed at runtime from `src/server/knowledge/*.md`:
`accounting.md` and `fulcrum.md` are human-curated (edit + PR to teach it
something), `learned.md` is agent-written. Review agent notes via git diff and
promote stable ones into the curated files. `RSG_AI_LEARNED_NOTES_FILE` can
point the learned notes at durable storage in deployments.

## Notes for the interface repo

- Conversation persistence, user login/roles, and rate limiting are yours.
- One agent turn can take 10–90s (QBO pagination over thousands of bills);
  keep the SSE connection open and show tool status chips for feedback.
- The model is instructed to ask a clarifying question when a request is
  ambiguous — render that as a normal assistant message.

## Logging & audit

Every chat turn emits JSON lines to stdout (and `RSG_AI_LOG_FILE` if set),
correlated by `requestId` (one turn) and `chatId` (the whole conversation):

- `chat_request` — ts, requestId, **chatId**, **user**, model, message count, the question (truncated)
- `tool_call` / `tool_result` — every tool invocation with inputs (truncated) and outcome, tagged with chatId
- `chat_response` — duration, stop reason, token usage, response text (truncated)
- `request_error` — failures, with path and message

The interface MUST send the authenticated admin's identity per request (body
`user` field, or `X-RSG-User` header) — otherwise logs show `user: "unknown"` —
and SHOULD send its conversation id (body `chatId` field, or `X-RSG-Chat-Id`
header) so all turns and tool calls of one chat can be pulled from the logs
together; without it, `chatId` logs as `null` and turns can only be
correlated one requestId at a time.

In production the container's stdout streams to CloudWatch Logs — group
`/rsg-ai/prod` (us-west-1, 90-day retention), stream `rsg-ai-rsg-ai-1` — so
logs survive deploys. Pull one conversation:

```bash
aws logs filter-log-events --log-group-name /rsg-ai/prod --region us-west-1 \
  --filter-pattern '"<chatId>"' --query 'events[].message' --output text
```

or query by field in CloudWatch Logs Insights (the records are JSON):
`fields ts, type, tool, user | filter chatId = "<chatId>"`.
`docker logs rsg-ai-rsg-ai-1` on the box still works (dual-logging cache)
but only holds the current container's history.

## Integrating with RSG_Website (Next.js App Router + better-auth)

Keep the agent API private; the website talks to it only through a
server-side route handler that (1) verifies the better-auth session and
`role === "admin"`, (2) injects the bearer secret, (3) forwards the user's
email, and (4) relays the SSE stream. Sketch (`app/api/rsg-ai/chat/route.ts`):

```ts
import { auth } from "@/lib/auth"; // adjust to the project's better-auth server instance
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user || session.user.role !== "admin") {
    return new Response("Forbidden", { status: 403 });
  }
  const body = await req.json(); // include chatId (your conversation id) so backend logs are tagged per-chat
  const upstream = await fetch(`${process.env.RSG_AI_URL}/api/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RSG_AI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...body, user: session.user.email }),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
```

Website env: `RSG_AI_URL` (e.g. `http://localhost:8787` in dev) and
`RSG_AI_API_KEY` (server-side only — never `NEXT_PUBLIC_`). The admin chat
page consumes the proxied SSE stream per the event table above, stores the
conversation (append `turn_complete.newMessages`), and offers `artifact`
events as downloads. Conversation persistence and any per-user rate limiting
belong to the website.

## Deployment

The agent API ships as its own service — it is NOT bundled into the website's
Vercel deploy.

**Production host (current): tiny EC2** — t4g.nano + Elastic IP in us-west-1
(~$5/mo), agent container + Caddy (automatic Let's Encrypt HTTPS) via
docker compose. Scripts in `deploy/ec2/`:

```bash
bash deploy/ec2/launch.sh    # one-time provisioning (already run)
bash deploy/ec2/update.sh    # ship current code: build arm64 -> ECR -> restart on host
bash deploy/ec2/shell.sh 'docker logs --tail 100 rsg-ai-rsg-ai-1'   # remote debugging
bash deploy/ec2/shell.sh     # interactive shell (needs session-manager-plugin)
```

- Live instance: `i-092a6fc728d363339`, Elastic IP `52.52.177.16`,
  domain `rsg-ai.rsgsecurity.com` (A record -> the EIP; Caddy issues the cert).
- Shell access is SSM Session Manager (no SSH keys, no port 22, IAM-audited).
  One-shot mode needs nothing extra — ideal for Claude sessions debugging the box.
- The production bearer key is auto-generated at SSM `/rsg-ai/prod/api-key`:

```bash
aws ssm get-parameter --name /rsg-ai/prod/api-key --with-decryption \
  --region us-west-1 --query Parameter.Value --output text
```

Vercel env: `RSG_AI_URL=https://rsg-ai.rsgsecurity.com`, `RSG_AI_API_KEY=<value above>`.
The audit JSONL is the agent container's stdout, shipped to CloudWatch Logs
group `/rsg-ai/prod` (see "Logging & audit" above); `docker logs rsg-ai-rsg-ai-1`
on the box shows the current container's slice of it.

**Graduation path: ECS Fargate + ALB** (~$35/mo, zero-ops) — template kept at
`deploy/rsg-ai-service.yaml`, deployed with `npm run rsg-ai:deploy`, for when
usage outgrows the single box.
