# Zendesk Ticket Search — Operations Runbook

Operational inventory + runbook for the Zendesk semantic-search feature
(spec `009-zendesk-ticket-search.md`, code in `src/zendesk/`). This exists so the
feature can be maintained, reconfigured, or torn down later without spelunking.
**If you change any of the external resources below, update this file.**

Region for all AWS resources: **us-west-1**. Zendesk subdomain: **rsgsecurity**.

---

## What runs where

| Piece | Location |
|---|---|
| Search tool `zendesk_ticket_search` | RSG AI agent (EC2 host `i-092a6fc728d363339`, `rsg-ai.rsgsecurity.com`); deployed via `deploy/ec2/update.sh` |
| Real-time indexing webhook | `POST /api/zendesk/webhook` on the same EC2 server (HMAC-verified, bearer-exempt) |
| Reconcile safety-net timer | In-process on the EC2 server (`startReconcileLoop`, every `ZENDESK_RECONCILE_MINUTES`, default 15) |
| Vectors / data | Postgres + pgvector — **shared RSG_Website Neon DB** (see below) |
| Embeddings | OpenAI `text-embedding-3-small`, **1536 dims** (must match `vector(1536)` in `schema.sql`) |

## External resources created (the cleanup checklist)

1. **SSM parameters** (`/rsg-ai/prod/`, SecureString, us-west-1):
   - `database-url` — Neon pooled connection string. **Shared with RSG_Website** —
     do NOT delete on teardown; it's the website's DB too.
   - `openai-api-key` — OpenAI embeddings key (sourced from `ticket-agent/.env`).
   - `zendesk-token`, `zendesk-email` — Zendesk Basic-auth creds (also used by RSG_Website).
   - `zendesk-webhook-secret` — HMAC signing secret of the indexing webhook below.
   - (subdomain `rsgsecurity` is non-secret; env overrides `ZENDESK_*` match RSG_Website.)
   - IAM: the EC2 instance role + Fargate task role already grant `ssm:GetParameter`
     on `/rsg-ai/prod/*`, so no IAM change was needed.

2. **Zendesk webhook** — id `01KV267BCJPYC111T7DX60CZQJ`, name
   "RSG AI - Ticket Vector Indexing", endpoint
   `https://rsg-ai.rsgsecurity.com/api/zendesk/webhook`. Signing secret is in
   `/rsg-ai/prod/zendesk-webhook-secret`. **Separate** from the ticket-agent's
   PO/Sales webhooks (those point at `…/ingest` on po-processor-prod).

3. **Zendesk trigger** — id `52578245738131`, name "RSG AI - Ticket Vector
   Indexing", fires the webhook above on ticket Create/Change with body
   `{ "ticket_id": "{{ticket.id}}" }`. Read-only (never modifies the ticket, so
   no trigger loop).

4. **Postgres tables** (in RSG_Website's Neon DB — Vercel project
   `v0-rsgsecuritynewwebflow`, integration `rsg-security-database-00713`, Neon
   project `noisy-unit-99793834`, endpoint `ep-little-math-a4g7mzdm`):
   `zendesk_ticket_chunks`, `zendesk_embedding_cache`, `zendesk_sync_state`.
   Owned here via `src/zendesk/schema.sql` (NOT in the website's Drizzle schema).
   The Neon plan was upgraded to lift the original **512 MB** free-tier storage
   cap (`neon.max_cluster_size`); compute ~64 GB RAM. Footprint: ~413 MB for 12
   months @ 1536 dims; full ~34k history ≈ ~1 GB.

5. **GitHub:** `dreuvenrsg/CSDroid` archived (its code relocated to
   `RSG_AI_Tools/ticket-agent/`). Unrelated to search, recorded here for context.

## Commands (runbook)

```bash
# Schema (idempotent). Use the DIRECT/unpooled connection for DDL.
DATABASE_URL=<unpooled> npm run zendesk:migrate

# Backfill. Arg = start Unix seconds; 0 = full history, omit = last 30 days.
npm run zendesk:backfill 0                 # full history
ZENDESK_BACKFILL_CONCURRENCY=6 npm run zendesk:backfill 1749874798   # since a timestamp
# Env: ZENDESK_BACKFILL_CONCURRENCY (default 8), ZENDESK_BACKFILL_MAX

# Re-index specific tickets (fill gaps) — args or piped ids:
node src/zendesk/reindex.js 31781 31776
cat ids.txt | node src/zendesk/reindex.js  # ZENDESK_REINDEX_CONCURRENCY (default 8)

# Search from the CLI (uses the same SSM creds):
node src/cli.js zendesk_ticket_search '{"query":"mircom rma","limit":5}'

# Deploy the server (search + webhook + reconcile timer):
bash deploy/ec2/update.sh

# Disable the in-server reconcile timer: set ZENDESK_SYNC_ENABLED=false on the host.
```

Inspect current state (size/counts) — connect with the SSM `database-url`:
```sql
select count(*) chunks, count(distinct ticket_id) tickets from zendesk_ticket_chunks;
select pg_size_pretty(pg_database_size(current_database()));
select cursor_seconds from zendesk_sync_state;        -- reconcile cursor
```

## Change scenarios

- **Move vectors off the shared website DB** (recommended if it ever competes for
  resources): create a dedicated Postgres, point `/rsg-ai/prod/database-url` at
  it, `zendesk:migrate`, `zendesk:backfill 0`, redeploy, then `drop table
  zendesk_ticket_chunks, zendesk_embedding_cache, zendesk_sync_state` on the old DB.
- **Change embedding model/dimension:** edit `src/zendesk/embeddings.js`
  (`OPENAI_EMBED_MODEL` / `OPENAI_EMBED_DIM`) AND `vector(N)` in `schema.sql`, then
  re-migrate (drop/recreate the column) and **full** re-backfill. Dimension must match.
- **Narrow who can search:** change `zendesk_ticket_search` from `ALL` in
  `src/server/permissions.js`, redeploy.
- **Reduce storage:** shrink dims (e.g. 768/512 via `dimensions`), and/or
  `truncate zendesk_embedding_cache` (regenerable; only speeds re-indexing).

## Full teardown

1. Zendesk: deactivate/delete trigger `52578245738131`, then delete webhook
   `01KV267BCJPYC111T7DX60CZQJ`.
2. DB: `drop table zendesk_ticket_chunks, zendesk_embedding_cache, zendesk_sync_state;`
3. SSM: delete `openai-api-key`, `zendesk-webhook-secret` (keep `database-url`,
   `zendesk-token`, `zendesk-email` — shared with RSG_Website).
4. Code: remove `zendesk_ticket_search` from `src/tools/index.js` +
   `src/server/permissions.js`, the webhook route + reconcile loop in
   `src/server/index.js`, `ctx.zendesk` wiring, and `src/zendesk/`; redeploy.

## Gotchas

- Pooled Neon (PgBouncer) doesn't keep session `SET hnsw.ef_search` — search sets
  it with `SET LOCAL` in a txn (`store.search`). Use the **unpooled** URL for migrations.
- `pg.Pool` would crash the process on a dropped idle connection (Neon
  autosuspend/restart); `store.getPool` installs a pool `error` handler so it
  recovers. Don't remove it.
- The backfill shares Zendesk's account-wide API rate limit with the **live
  ticket-agent (PO processing)** — high concurrency can cause mutual 429s
  (both retry/back off). The reconcile walk skips unchanged tickets without
  fetching, which keeps steady-state load minimal.
