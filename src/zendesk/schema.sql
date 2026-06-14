-- Zendesk ticket vectorization tables (pgvector), applied via `npm run zendesk:migrate`.
-- These live in RSG_Website's existing Vercel/Neon Postgres but are OWNED here:
-- RSG_AI_Tools manages them with this file; the website's Drizzle schema never
-- touches the zendesk_* tables, so the two repos don't clash.
--
-- NOTE: vector(1024) must match VOYAGE_DIM in embeddings.js. Changing the
-- embedding dimension requires altering the column + rebuilding the index.

create extension if not exists vector;

-- One row per ticket CHUNK. Re-indexing a ticket deletes all its rows and
-- re-inserts the current chunk set (see store.replaceTicket), so there is never
-- more than one representation of a ticket — no "before/after a new comment"
-- duplicates accumulate. chunk_id is deterministic ("{ticket_id}:{chunk_index}").
create table if not exists zendesk_ticket_chunks (
  chunk_id           text primary key,
  ticket_id          bigint not null,
  chunk_index        integer not null,
  subject            text,
  status             text,
  priority           text,
  type               text,
  channel            text,
  tags               text[] not null default '{}',
  requester          text,
  org                text,
  assignee           text,
  group_name         text,
  created_at         timestamptz,
  updated_at         timestamptz,            -- the ticket's Zendesk updated_at
  url                text,
  problem_id         bigint,
  followup_source_id bigint,
  followup_ids       bigint[] not null default '{}',
  incident_ids       bigint[] not null default '{}',
  text_content       text not null,
  text_sha256        text not null,
  embedding          vector(1024),
  indexed_at         timestamptz not null default now()
);

create index if not exists idx_zendesk_chunks_ticket    on zendesk_ticket_chunks (ticket_id);
create index if not exists idx_zendesk_chunks_embedding on zendesk_ticket_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists idx_zendesk_chunks_status    on zendesk_ticket_chunks (status);
create index if not exists idx_zendesk_chunks_tags      on zendesk_ticket_chunks using gin (tags);
create index if not exists idx_zendesk_chunks_updated   on zendesk_ticket_chunks (updated_at);

-- Embedding cache keyed by chunk text hash. Re-indexing a ticket that only
-- gained one comment re-embeds just the changed tail chunk; the rest fill from
-- here for free. Survives row replacement (never deleted by replaceTicket).
create table if not exists zendesk_embedding_cache (
  text_sha256 text primary key,
  embedding   vector(1024) not null,
  model       text not null,
  created_at  timestamptz not null default now()
);

-- Single-row cursor for the incremental export reconciliation/backfill.
create table if not exists zendesk_sync_state (
  id             integer primary key default 1,
  cursor_seconds bigint,
  updated_at     timestamptz not null default now()
);
insert into zendesk_sync_state (id, cursor_seconds) values (1, null) on conflict (id) do nothing;
