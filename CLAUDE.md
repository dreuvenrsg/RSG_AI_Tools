# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**RSG_AI_Tools** (formerly InvoiceSender) is the backend for RSG AI — the company's internal AI assistant — plus the invoice automation it grew out of. It has two halves:

1. **Invoice processor** — an AWS Lambda (SAM) automation that processes invoices in two stages on a daily schedule (5:00 PM `America/Los_Angeles`), described below.
2. **Accounting tools + RSG AI agent API** — a modular QBO analysis tool layer and the agent backend for the team-facing chat interface (see "Accounting Tools (`src/`)" below).

The invoice processor is effectively a two-file application plus SAM infra.

1. **Fulcrum stage** (`fulcrumProcessor.js`) — Puppeteer browser automation that logs into Fulcrum, finds "NEEDS ACTION" invoices, and creates/issues them per business rules.
2. **QBO stage** (`V2_emailSender.js`) — also the Lambda handler/orchestrator. Refreshes the QBO OAuth token, fetches unissued invoices, validates shipping status via the Fulcrum API, updates PO numbers, and emails the sendable ones to customers. Finishes by sending an SES summary email of both stages.

The deployed Lambda handler is `V2_emailSender.handler`.

## Source of Truth & Entrypoint

- **Treat the code as source of truth over the docs.** `README.md` and `QUICKSTART.md` are stale — they reference `index.js`, which does not exist.
- The real local entrypoint is `V2_emailSender.js`.
- `package.json` scripts `test-local` (`node index.js`) and `invoke-local` (uses `events/invoke.json`) are **broken** — neither `index.js` nor `events/` exists. Don't rely on them.

## Commands

```bash
npm install

# Run the full pipeline locally (visible browser). This is the real local entrypoint:
node V2_emailSender.js

# Unit/regression tests (Node's built-in test runner):
npm test                              # node --test tests/*.test.js
node --test tests/invoiceSender.test.js   # run a single test file

# SAM build / deploy / ops:
npm run build      # sam build
npm run deploy     # sam build && sam deploy (stack: rsg-invoice-processor, us-west-1)
npm run logs       # tail CloudWatch logs for RSGInvoiceProcessor
npm run info       # describe the CloudFormation stack
```

Before marking a code change complete: run `npm test`; run `npm run build` for SAM/packaging changes; run `node V2_emailSender.js` for local behavior when credentials are available. If a change touches Fulcrum browser automation, note whether interactive local verification was performed.

## Accounting Tools (`src/`)

A standalone, modular tool layer (separate from the invoice-sender monolith) exposing QBO accounting analyses as Anthropic tool-use definitions, intended to back a future admin-only "RSG AI". It does NOT import `V2_emailSender.js`.

```bash
node src/cli.js list                                          # list tools
node src/cli.js qbo_landed_cost_report '{"months":12}'        # CSV lands in artifacts/
node src/cli.js qbo_cash_application_lookup '{"customer":"MIRCOM INC."}'
```

- `src/qbo/` — read-focused QBO client. Client id/secret come from env or SSM (`/qbo-invoice-sender/prod/client-id`, `.../client-secret`); the refresh token is the **same SSM parameter the Lambda uses**, and rotation is written back, so the two stay in sync.
- `src/zendesk/` — **Zendesk ticket vectorization + semantic search.** Tickets are embedded (OpenAI `text-embedding-3-small`, 1536-dim) into Postgres/pgvector and searched by the `zendesk_ticket_search` tool. **The vectors live in RSG_Website's existing Vercel/Neon Postgres** (`DATABASE_URL`, SSM `/rsg-ai/prod/database-url`); RSG_AI_Tools owns its `zendesk_*` tables via `src/zendesk/schema.sql` (apply with `npm run zendesk:migrate`) so the website's Drizzle schema never clashes. **Dedup is the key invariant:** indexing is per-ticket — `store.replaceTicket` deletes a ticket's rows and re-inserts the current chunk set in one transaction, so there's exactly one representation; an `embedding_cache` keyed by chunk text-hash means an update only re-embeds the changed chunk. Each chunk embeds a structured header (status/tags/priority/requester/linked-ticket ids) + the full thread (public **and** internal notes), with those fields also stored as columns for filtered search; `problem_id`/follow-up/incident links are captured so the agent surfaces chains Zendesk's UI hides. Ingestion: real-time via `POST /api/zendesk/webhook` (HMAC-verified, bearer-exempt — secret in SSM `/rsg-ai/prod/zendesk-webhook-secret`) plus a `runReconcile()` incremental-export safety net (timer in the server via `startReconcileLoop`; initial load via `npm run zendesk:backfill`). Zendesk auth (`/rsg-ai/prod/zendesk-token`, `.../zendesk-email`; subdomain `rsgsecurity`) mirrors RSG_Website's `ZENDESK_*` env names. `document.js` and `webhookAuth.js` are pure (tested in `tests/zendeskTools.test.js`).
- `src/tools/` — one module per tool exporting `{ definition, run }`, organized by domain: `accounting/` (QBO analyses), `fulcrum/` (ERP access for CS/ops — `fulcrum_api_request` is a generic read-only API tool; the read-only guard lives in `src/fulcrum/client.js`, key in SSM `/rsg-ai/prod/fulcrum-api-key`), `zendesk/` (`zendesk_ticket_search`, all admin roles), and `system/` (agent self-management: saving learned notes; `rsg_ai_log_search` lets the agent search its own CloudWatch logs for debugging, super-admin only). Register new tools in `src/tools/index.js`; tool ctx is `{ qbo, fulcrum, zendesk }` (`ctx.zendesk` resolves lazily and is null when Postgres/OpenAI aren't configured). Keep business math in pure exported functions covered by `tests/accountingTools.test.js`.
- `src/server/` — the **RSG AI agent API** (`npm run rsg-ai`): a Claude tool-use agent loop (`agentLoop.js`, default model `claude-opus-4-8`, override with `RSG_AI_MODEL`) behind an SSE HTTP API (`index.js`). The website chat interface lives in a separate repo and talks to this — the contract is `docs/rsg-ai-api.md`; keep that doc updated when the API changes. Auth: `RSG_AI_API_KEY` bearer secret. Anthropic key: `ANTHROPIC_API_KEY` env or SSM `/rsg-ai/prod/anthropic-api-key`. Domain knowledge for the agent lives in `src/server/knowledge/*.md` (curated: `accounting.md`, `fulcrum.md`; agent-written via the save_operational_note tool: `learned.md`) — these are folded into the system prompt (`src/server/systemPrompt.js`) at runtime, so teaching the agent is a markdown edit. Review/prune `learned.md` periodically and promote stable notes into the curated files. Server tests: `tests/agentServer.test.js`. Deploys separately from the Lambda to a tiny EC2 host (t4g.nano + Caddy auto-HTTPS, `rsg-ai.rsgsecurity.com`): `deploy/ec2/update.sh` ships code, `deploy/ec2/shell.sh '<cmd>'` runs remote debugging commands via SSM (no SSH). Container logs stream to CloudWatch group `/rsg-ai/prod` (90-day retention); chat/tool-call records are JSONL tagged with the website's `chatId`, so one conversation greps out of the group. Fargate alternative kept in `deploy/rsg-ai-service.yaml` (`npm run rsg-ai:deploy`).
- **Data conventions that shape any AP analysis:** bills book nearly everything to the single QBO item "COGS Purchasing"; real part numbers are `PART-NUMBER: description` prefixes in line Descriptions, and freight/tariff/tax charges also appear as description-only lines. Most tariff/freight spend sits on bills with no part lines (broker/carrier bills) and lands in the report's `unallocatedOverhead` bucket.

## ticket-agent/ (Zendesk customer-service subsystem)

`ticket-agent/` is a **self-contained TypeScript subproject** (own `package.json`, `tsconfig.json`, `serverless.yml`) relocated from the former `CSDroid` repo. It handles RSG's Zendesk Support tickets and deploys as **its own Serverless/Lambda stack** — it does NOT touch the root JS chat server or the SAM/EC2 deploys. Treat it as a separate app that happens to live in this repo; run its commands from inside the folder (`cd ticket-agent`). Detailed docs are folder-local (`ticket-agent/README.md`, `ticket-agent/SPECS/`, `AGENTS.md`, `LEARNINGS.md`) and `specs/010-customer-service-ticket-agent.md` is the top-level overview.

- **What it is:** an agent-first ticket processor. A Claude (Opus 4.8, modular via `CSDROID_AGENT_MODEL`) tool-use agent classifies each ticket into a taxonomy, decides one explicit **nextAction** (`draft_reply` | `no_response_needed` | `escalate`), and drafts replies. The deterministic PO pipeline (PDF→OpenAI→Fulcrum) is unchanged and invoked via the `run_po_pipeline` tool.
- **Safety invariant (do not weaken):** the agent NEVER messages a customer — every reply is a private internal note, enforced by `assertPrivateComment` in `ticket-agent/src/zendesk.ts`. A dry-run kill-switch (`CSDROID_DRY_RUN`) suppresses all Zendesk writes for backtesting; classification-only mode (`CSDROID_CLASSIFY_ONLY`, set by `test:eval`) skips the PO pipeline's GPT-5 extraction.
- **Verify:** `cd ticket-agent && npm install && npm run build && npm run test:safety && npm run test:eval -- all` (100% on the golden set, dry-run).
- **Deferred:** it still ships its own ported Fulcrum client / agent loop / Zendesk access (duplicates of this repo's `src/`). Converging onto the shared JS primitives + SSM loader is a follow-up (`specs/010`), not done yet.

## Architecture & Non-Obvious Details

### Single-run lock (DynamoDB)
A distributed lock prevents concurrent/overlapping runs. The handler acquires a lock in `RSGInvoiceProcessorLocks` (conditional `PutItem`, TTL-expiring) before processing and deletes it after. Configured via `INVOICE_PROCESSOR_LOCK_TABLE` / `INVOICE_PROCESSOR_LOCK_NAME` env vars (set in `template.yaml`). If the table env var is unset (e.g. some local runs), it logs a warning and continues without the guard. See the lock helpers near the bottom of `V2_emailSender.js` (~line 2136+).

### Parallel QBO sending
QBO invoices are sent in small parallel batches with deliberate rate limiting (`BATCH_SIZE = 3`, ~200ms between batches) to stay under QBO API limits (~line 1781+). Metrics land in `results.parallelProcessingMetrics` and are reported in the summary email.

### Customer filtering: three categories
Sending decisions are not a simple include/exclude. The summary email and `candidatePolicySummary` distinguish:
- **explicitlyExcludedCustomers** — deliberately never sent (e.g. Siemens/Honeywell).
- **allowlistMissCustomers** — not on the included allowlist, so skipped (distinct from explicit exclusion).
- **sendableCustomers** — pass the allowlist and have a valid recipient email.

The allowlist arrays live in `V2_emailSender.js` (~line 137+) and are case-insensitive. Recipient routing has special cases (e.g. HLI ship-to routing, default to customer primary email) — these are protected by the test suite, so preserve their behavior.

### Configuration
`const activeConfig = config.production;` (~line 466) switches between sandbox and production config blocks.

### Testable exports
`V2_emailSender.js` exports `buildFulcrumRunOptions`, `buildInvocationLockMetadata`, `buildSummaryEmailContent`, `customerModule`, and `utils`; `fulcrumProcessor.js` exports `isCreateDetailTimeoutError`. The regression suite (`tests/invoiceSender.test.js`) exercises these to protect: excluded-customer visibility in summary emails, HLI ship-to routing, and default primary-email recipient selection. When changing send/routing/summary logic, extend these tests and keep them green.

## OAuth Token Management

QBO refresh tokens live in SSM at `/qbo-invoice-sender/prod/refresh-token` (and `.../sandbox/...`). The system loads the refresh token from SSM (falling back to the hardcoded value in `config.production.REFRESH_TOKEN`), exchanges it for an access token, and writes the rotated refresh token back to SSM. Keep SSM and the code config in sync.

On `invalid_grant` / "invalid refresh token":
1. `aws ssm get-parameter --name "/qbo-invoice-sender/prod/refresh-token" --with-decryption --region us-west-1`
2. If stale, mint a new one via the QuickBooks OAuth playground (client_id is in CLAUDE.md history / the connect URL).
3. Update both SSM (`aws ssm put-parameter ... --type SecureString --overwrite`) and `REFRESH_TOKEN` in `V2_emailSender.js`, then redeploy.

When touching auth/token handling, move toward env vars or SSM rather than adding new hardcoded secrets.

## Infrastructure (template.yaml)

- **Runtime:** Node.js 22 (`nodejs22.x`), x86_64. **Region:** `us-west-1`. Stack `rsg-invoice-processor`, function `RSGInvoiceProcessor`.
- **Memory 3008 MB, timeout 900s, 2048 MB ephemeral storage** — required for headless Chromium. Don't lower these unless explicitly asked.
- **Chromium** comes from a public Lambda layer ARN (`ChromiumLayerArn`, currently `...us-west-1:764866452798:layer:chrome-aws-lambda:63`). Update the ARN if the deploy region changes.
- IAM grants: SSM Get/Put on `/qbo-invoice-sender/*`, SES SendEmail, DynamoDB Put/DeleteItem on the lock table, CloudWatch Logs.
- Schedule: `ScheduleV2` cron `0 17 * * ? *` in `America/Los_Angeles`.

## Repo Conventions (mandatory upkeep)

These are part of every change, not optional extras:

1. **CLAUDE.md stays current.** Any major change (new feature, new tool, infra
   change, renamed concept) updates the relevant section of this file in the
   same PR.
2. **Specs for major features.** Every major rollout has a numbered spec in
   `specs/` (format in `specs/README.md`): problem, approach, a task breakdown
   with checkboxes, verification, and follow-ups. Check tasks off as they
   complete; record deferred work as unchecked follow-ups.
3. **`index.md` stays current.** One-line description per tracked file; update
   it whenever files are added, removed, or repurposed.
4. **Comment for readability.** New modules get a header comment saying what
   they are and why; non-obvious constraints get inline comments. Match the
   existing comment density in `src/`.
5. **Project invariants — respect these:**
   - Agent capabilities are `{ definition, run }` modules under a domain folder
     in `src/tools/`, registered in `src/tools/index.js`. Business math lives
     in pure exported functions with unit tests.
   - `src/` never imports the monolith (`V2_emailSender.js`/`fulcrumProcessor.js`),
     and vice versa.
   - Secrets live in SSM (env override allowed) — never hardcode new ones.
   - Fulcrum access is read-only, enforced in `src/fulcrum/client.js` — never
     weaken the guard or route mutations around it.
   - Agent domain knowledge is markdown in `src/server/knowledge/`, not prose
     in code. `learned.md` is agent-written; prune/promote via review.
   - `docs/rsg-ai-api.md` is the website contract — any API change updates it
     in the same PR.
   - Money math uses integer cents (`src/lib/allocation.js`).
   - Zendesk indexing keeps **one representation per ticket**: re-indexing
     replaces a ticket's rows in a transaction (`src/zendesk/store.js`
     `replaceTicket`) — never append per-update, or duplicate ticket states
     will accumulate. The embedding dimension in `schema.sql` must match
     `EMBED_DIM` in `src/zendesk/embeddings.js`.

## Working Rules

- Prefer small, targeted edits. Map of where things live:
  - QBO behavior / business rules / email reporting → `V2_emailSender.js`
  - Fulcrum selectors, waits, pagination, invoice creation → `fulcrumProcessor.js`
  - Runtime, schedule, IAM, layer, memory → `template.yaml`
- Never edit `.aws-sam/` or `node_modules/`.
- Keep credentials out of commits/diffs. Be careful around `.env`, `.refresh-token-prod.txt`, and any tokens already hardcoded in `V2_emailSender.js`.
- **When changing invoice send flows, validate not just that a send was *attempted* but *where* it went** — verify against real observable outputs (QBO results, SES payloads, Fulcrum state, logs) rather than only that a function was called.

## Troubleshooting

- **"Chromium not found" in Lambda** — verify the layer ARN matches the deploy region in `template.yaml`.
- **"NEEDS ACTION button not found"** — Fulcrum UI likely changed; update the selector in `fulcrumProcessor.js` and/or increase timeouts (`timeouts` config block).
- **Pagination loops** — `fulcrumProcessor.js` has a 20-page safety limit; check that the "NEEDS ACTION" filter stays active across page changes (see `checkNextPage()`).
- **Function timeout** — normal for large batches (100+ invoices); watch `npm run logs` for progress.
