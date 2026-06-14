# 009 — Zendesk ticket semantic search

**Status:** in progress (2026-06-13)

## Problem / Goal

CS and finance staff need answers buried in Zendesk tickets, but Zendesk's
search is keyword-only and its UI hides ticket relationships (a closed thread
linked to a follow-up; a problem/incident chain). We want RSG AI to answer
natural-language questions over ticket history and cite the supporting tickets
with deep links. Constraints called out:

- **No version sprawl** — when a ticket changes, its vector representation is
  *replaced*, never appended; we never accumulate "thread before/after comment N".
- **Trigger off ticket updates** in near-real-time, with a safety net.
- **Encode all ticket properties** (tags, status, priority, type, requester/org,
  assignee/group, dates, linked/problem/follow-up ids) for semantic + filtered search.
- All admin roles for now (one-line change to narrow).
- Its own folder, respecting repo organization.

## Approach

- **Storage: Postgres + pgvector** via the `pg` driver, reusing PlanFinder's
  pattern. Tables live in **RSG_Website's existing Vercel/Neon Postgres** (the DB
  already shared with the agent via `rsg_ai_conversation`); RSG_AI_Tools owns its
  `zendesk_*` tables via `src/zendesk/schema.sql` so the website's Drizzle schema
  never clashes. Connection string is `DATABASE_URL` (SSM `/rsg-ai/prod/database-url`).
- **Embeddings: Voyage AI** (`voyage-3-large`, 1024-dim) over `fetch` — the
  Anthropic SDK has no embeddings endpoint. Key in SSM `/rsg-ai/prod/voyage-api-key`.
- **Dedup/versioning.** Unit of indexing is one ticket → N chunks with
  deterministic ids `{ticketId}:{chunkIndex}`. `store.replaceTicket` deletes all
  of a ticket's rows and re-inserts the current set in one transaction, so exactly
  one representation exists. An `embedding_cache` keyed by chunk text SHA-256 means
  an update re-embeds only the changed chunk; the rest fill from cache for free.
- **Document.** Each chunk embeds a structured header (status, priority, type,
  tags, requester/org, assignee/group, dates, linked tickets) + the comment thread
  (public *and* internal notes). The same fields are stored as columns for filtered
  search. `problem_id`, follow-up source (`via.source.rel == "follow_up"`), and
  `/incidents` are captured and rendered so the agent can surface the chains
  Zendesk's UI hides.
- **Ingestion.** Real-time via a new `POST /api/zendesk/webhook` route
  (HMAC-verified, bearer-exempt) that re-indexes the ticket and acks fast. Safety
  net via `runReconcile()` — an Incremental Export cursor loop — run on a timer in
  the server (`startReconcileLoop`) and once for the initial backfill
  (`npm run zendesk:backfill`).
- **Search.** `zendesk_ticket_search` tool embeds the query, runs cosine ANN with
  optional structured filters (status/tags/date/requester), dedupes to best chunk
  per ticket, and returns hits with deep links + linked-ticket refs. The agent
  writes the cited prose. Wired into ctx as `ctx.zendesk` (a `ZendeskSearch`),
  resolved lazily and tolerant of missing config (null → tool reports unavailable).

## Tasks

- [x] `src/zendesk/`: client, embeddings (Voyage), document (pure), store (pg +
      pgvector), indexer (indexTicket + runReconcile), search facade, schema.sql,
      webhookAuth (HMAC), migrate + backfill scripts; `src/lib/ssm.js` helper
- [x] `zendesk_ticket_search` tool + register in `src/tools/index.js`
- [x] Permission `zendesk_ticket_search: ALL` in `src/server/permissions.js`
- [x] Server: `ctx.zendesk`, `POST /api/zendesk/webhook`, `startReconcileLoop`
- [x] CLI: `zendesk` ctx for `node src/cli.js zendesk_ticket_search`
- [x] `pg` dependency; `zendesk:migrate` / `zendesk:backfill` scripts
- [x] Knowledge file `src/server/knowledge/zendesk.md`
- [x] Tests `tests/zendeskTools.test.js` (normalize, header, chunk/dedup, HMAC,
      payload parse, hit shaping, registration + permissions); updated tool count
- [x] Docs: this spec, CLAUDE.md, index.md, docs/rsg-ai-api.md
- [ ] Provision SSM params + apply schema + initial backfill (ops; see Verification)
- [ ] Configure the Zendesk webhook/trigger to POST `/api/zendesk/webhook` (ops)

## Verification

Unit (done): `npm test` — 63 passing, including determinism + the
replace-not-append rebuild semantics, HMAC verify, and the permission matrix.

End-to-end (requires live secrets, to run during rollout):
- `DATABASE_URL=… npm run zendesk:migrate` → extension + HNSW index present.
- `npm run zendesk:backfill` over a slice → rows with non-null embeddings; cache populated.
- Re-index a ticket after adding a comment → `store.countChunks` reflects only the
  current set, `updated_at` advanced, no stale rows; Voyage called only for the
  changed chunk.
- POST a signed sample payload to `/api/zendesk/webhook` → ticket re-indexed;
  bad/absent signature → 401.
- `node src/cli.js zendesk_ticket_search '{"query":"mircom rma"}'` → relevant
  tickets, similarity order, working `agent/tickets/{id}` links, linked refs.
- Chat as an admin role → cited answer; tool hidden from invalid roles.

## Follow-ups

- [ ] Website could read `zendesk_ticket_chunks` directly to add semantic search
      to its own ticket UI (vectors live in its DB) — no new service needed.
- [ ] Rotate the hardcoded token in `zendesk-extension/background-new.js` (old
      repo, exposed) and align on the website's `ZENDESK_TOKEN`.
- [ ] Hybrid (dense + lexical) re-ranking if pure-vector recall proves weak
      (PlanFinder `retrieve.ts` RRF pattern).
- [ ] Consider moving ingestion to a dedicated Lambda if the t4g.nano struggles
      with reconcile load.
