# RSG_AI_Tools — file index

One-line description of every tracked file. **Keep this current**: when you
add, remove, or repurpose a file, update its entry in the same PR.

## Root

| File | Description |
|---|---|
| `CLAUDE.md` | Instructions + conventions for Claude Code sessions; the repo's source of truth for "how we work here" |
| `index.md` | This file |
| `README.md` | ⚠️ Stale (predates the rename; references `index.js` which doesn't exist) — trust CLAUDE.md |
| `QUICKSTART.md` | ⚠️ Stale, same caveat as README |
| `AGENTS.md` | Pointer file for non-Claude agent tooling |
| `INTEGRATION_SUMMARY.md` | Historical notes from the original Fulcrum/QBO integration build |
| `package.json` | npm package `RSG_AI_Tools`; scripts: `test`, `rsg-ai` (agent server), `rsg-ai:deploy` (Fargate), SAM build/deploy/logs |
| `Dockerfile` | Agent API container (node:22-slim, prod deps only, non-root) |
| `.dockerignore` | Keeps node_modules/artifacts/logs/secrets out of the image |
| `template.yaml` | SAM/CloudFormation for the **invoice processor Lambda** (schedule, IAM, Chromium layer) |
| `samconfig.toml` | SAM deploy config for the Lambda stack |
| `.gitignore` | Ignores node_modules, .aws-sam, artifacts/, *.log, *.env, etc. |
| `.refresh-token-prod.txt` | Local scratch copy of a QBO refresh token — **never commit; untracked deliberately** |

## Invoice processor (legacy monolith — still the production Lambda)

| File | Description |
|---|---|
| `V2_emailSender.js` | Lambda handler/orchestrator: QBO OAuth, invoice fetching, shipping validation via Fulcrum, customer routing rules, SES summary emails, DynamoDB run lock, monthly mis-route audit |
| `fulcrumProcessor.js` | Puppeteer browser automation: logs into Fulcrum, processes "NEEDS ACTION" invoices |
| `layers/chromium/nodejs/package.json` | Chromium Lambda-layer manifest |

## Accounting tools + RSG AI agent (`src/`)

| File | Description |
|---|---|
| `src/cli.js` | Local runner: `node src/cli.js <tool> '<json>'` |
| `src/qbo/config.js` | QBO env config; credentials resolve env → SSM (no hardcoded secrets) |
| `src/qbo/client.js` | Read-focused QBO API client; SSM-backed OAuth with refresh-token rotation shared with the Lambda |
| `src/fulcrum/client.js` | Read-only Fulcrum Pro API client (GET + POST `.../list` only — mutations refused in code); key from env/SSM |
| `src/zendesk/client.js` | Zendesk API client (Basic auth, env/SSM); ticket-bundle fetch (sideloaded users/groups/orgs + comments + incidents) and incremental export |
| `src/zendesk/embeddings.js` | Voyage AI embeddings client (`voyage-3-large`, 1024-dim) over fetch; document/query input types |
| `src/zendesk/document.js` | **Pure**: normalize a Zendesk bundle → meta; build the structured header + thread; deterministic chunking |
| `src/zendesk/store.js` | Postgres + pgvector store: `replaceTicket` (transactional delete+insert + cache), cosine `search`, embedding cache, sync cursor |
| `src/zendesk/indexer.js` | Orchestration: `indexTicket` (fetch→build→embed-with-cache→replace) and `runReconcile` (incremental export loop) |
| `src/zendesk/search.js` | `ZendeskSearch` facade wired as `ctx.zendesk`: embeds the query, runs the search, shapes citable hits |
| `src/zendesk/webhookAuth.js` | **Pure** Zendesk webhook HMAC-SHA256 signature verification |
| `src/zendesk/schema.sql` | pgvector DDL: `zendesk_ticket_chunks`, `zendesk_embedding_cache`, `zendesk_sync_state` (owned here, lives in RSG_Website's Postgres) |
| `src/zendesk/migrate.js` | Applies `schema.sql` (`npm run zendesk:migrate`) |
| `src/zendesk/backfill.js` | Initial/catch-up backfill via incremental export (`npm run zendesk:backfill`) |
| `src/lib/allocation.js` | Pure money math: integer-cent largest-remainder allocation, weight strategies |
| `src/lib/csv.js` | Minimal RFC-4180 CSV serializer |
| `src/lib/ssm.js` | Shared secret loader: env override → SSM SecureString (used by qbo/fulcrum/zendesk/voyage) |
| `src/tools/index.js` | Tool registry — every agent capability registers here as `{ definition, run }` |
| `src/tools/accounting/landedCost.js` | `qbo_landed_cost_report`: per-part spend with freight/tariff/fee/tax allocation |
| `src/tools/accounting/cashApplication.js` | `qbo_cash_application_lookup`: how customer payments were applied to AR invoices |
| `src/tools/fulcrum/apiRequest.js` | Fulcrum tool factory: unrestricted explorer + purchasing-scoped + sales-scoped variants |
| `src/tools/zendesk/ticketSearch.js` | `zendesk_ticket_search`: semantic search over vectorized tickets, returns cited deep links |
| `src/tools/system/saveNote.js` | `save_operational_note`: agent appends verified discoveries to its learned knowledge |
| `src/tools/system/logSearch.js` | `rsg_ai_log_search`: searches the backend's CloudWatch logs by chatId/user/type/text (super-admin) |
| `src/server/index.js` | Agent API HTTP server: `POST /api/chat` (SSE), `GET /api/tools`, `/healthz`; bearer auth; audit logging |
| `src/server/agentLoop.js` | The Claude tool-use loop: streaming, tool dispatch, result summarization, artifacts |
| `src/server/systemPrompt.js` | Base prompt + runtime composition of the knowledge files |
| `src/server/log.js` | JSONL audit logger (requestId, chatId, user, timings, usage) |
| `src/server/attachments.js` | Upload normalization: byte-sniffed media types, text decode, Excel→CSV conversion |
| `src/server/permissions.js` | Role→tool access matrix (mirrors RSG_Website `lib/roles.ts` by design) + denial message |
| `src/server/knowledge/accounting.md` | Curated: QBO bookkeeping conventions (part-number prefixes, overhead lines) |
| `src/server/knowledge/fulcrum.md` | Curated: Fulcrum API behavior (list conventions, **sorting ignored**, lookup trails) |
| `src/server/knowledge/zendesk.md` | Curated: how/when to use ticket search, cite deep links, surface linked tickets |
| `src/server/knowledge/learned.md` | Agent-written notes via `save_operational_note`; review via git diff |

## Deployment (`deploy/`)

| File | Description |
|---|---|
| `deploy/ec2/launch.sh` | One-time EC2 provisioning (t4g.nano, IAM, SG, EIP, user-data bootstrap) — **already run**; live instance `i-092a6fc728d363339` |
| `deploy/ec2/update.sh` | Ship current code/config to the host (arm64 build → ECR → SSM restart + health check) |
| `deploy/ec2/shell.sh` | Remote shell via SSM: one-shot commands (agent debugging) or interactive session |
| `deploy/ec2/run.sh` | Runs on the instance: pulls image, injects bearer key from SSM, compose up |
| `deploy/ec2/docker-compose.yml` | Agent container + Caddy (auto-HTTPS) stack definition |
| `deploy/ec2/Caddyfile` | Reverse proxy with Let's Encrypt + SSE streaming |
| `deploy/rsg-ai-service.yaml` | Fargate+ALB CloudFormation — the graduation path if usage outgrows the EC2 box |
| `deploy/deploy.sh` | Fargate deploy script (`npm run rsg-ai:deploy`) |

## Docs & specs

| File | Description |
|---|---|
| `docs/rsg-ai-api.md` | **The contract** between this backend and the RSG_Website chat UI: endpoints, SSE events, uploads, logging, deployment |
| `docs/website-integration-handoff.md` | Handoff brief for the Claude session building the website integration |
| `specs/README.md` | Spec conventions (status, task checkboxes, follow-ups) |
| `specs/001-accounting-tools.md` | QBO landed cost + cash application tools |
| `specs/002-rsg-ai-agent-api.md` | Agent loop, SSE API, audit logging |
| `specs/003-fulcrum-erp-access.md` | Read-only Fulcrum tool for CS/ops |
| `specs/004-agent-knowledge-system.md` | Curated + agent-written operational notes |
| `specs/005-deployment.md` | EC2 (live) + Fargate (graduation) deployment |
| `specs/006-file-uploads.md` | Upload normalization: images/PDF/text/Excel |
| `specs/007-role-scoped-tools.md` | Role-based tool access + purchasing/sales scoped Fulcrum tools |
| `specs/008-chat-debugging-logs.md` | chatId-tagged logs, CloudWatch durability, and the agent's log-search tool |
| `specs/009-zendesk-ticket-search.md` | Vectorize Zendesk tickets (pgvector + Voyage); webhook + reconcile ingestion; semantic search tool |

## Tests

| File | Description |
|---|---|
| `tests/invoiceSender.test.js` | Regression suite protecting the Lambda's routing/summary behavior (HLI ship-to, exclusions, audit emails) |
| `tests/accountingTools.test.js` | Allocation math, overhead classification, part extraction, payment summarization, Fulcrum guard/truncation |
| `tests/agentServer.test.js` | SSE/auth helpers, tool-result summarization, knowledge composition, note saving, log helpers |

## Misc

| File | Description |
|---|---|
| `.vscode/launch.json` | VS Code debug config |
| `artifacts/` (gitignored) | Generated reports/CSVs and verification screenshots — contains financial data, never commit |
