// Postgres + pgvector storage for Zendesk ticket chunks. Connection string is
// RSG_Website's Vercel/Neon DATABASE_URL (env override → SSM). Pattern follows
// PlanFinder's pg + pgvector store.
//
// Serverless-Postgres note: Neon's pooled (PgBouncer transaction-mode) endpoint
// does not retain session-level `SET hnsw.ef_search`, so search() sets it with
// SET LOCAL inside its own transaction rather than on connect.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadSecret } from "../lib/ssm.js";
import { EMBED_DIM } from "./embeddings.js";

export const DATABASE_URL_PARAM = "/rsg-ai/prod/database-url";
const HNSW_EF_SEARCH = 100;
const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");

let poolPromise = null;
export async function getPool() {
  return (poolPromise ??= (async () => {
    const url = await loadSecret(DATABASE_URL_PARAM, { env: "DATABASE_URL" });
    const local = /localhost|127\.0\.0\.1/.test(url);
    // Keep the pool small — Neon has a low connection ceiling.
    const pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 4),
      ssl: local ? undefined : { rejectUnauthorized: false },
    });
    // Neon drops idle connections on autosuspend / compute restarts (e.g. plan
    // changes). pg.Pool emits 'error' on idle clients then; without a handler
    // Node treats it as uncaught and crashes the process. Log + let the pool
    // evict the dead client — the next query lazily reconnects.
    pool.on("error", (err) => console.error("[zendesk] pg pool idle-client error (recoverable):", err.message));
    return pool;
  })());
}

/** Apply schema.sql (idempotent). */
export async function migrate() {
  const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
  const pool = await getPool();
  await pool.query(sql);
}

/** pgvector array literal: [0.1,0.2,...] */
function vectorLiteral(arr) {
  return `[${arr.join(",")}]`;
}

/** The ticket's stored updated_at (ISO string) or null if not indexed. */
export async function getTicketUpdatedAt(ticketId) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `select max(updated_at) as updated_at from zendesk_ticket_chunks where ticket_id = $1`,
    [ticketId]
  );
  return rows[0]?.updated_at || null;
}

/** Cached embeddings for a set of text hashes → Map(sha → number[]). */
export async function getCachedEmbeddings(hashes) {
  const out = new Map();
  if (!hashes.length) return out;
  const pool = await getPool();
  const { rows } = await pool.query(
    `select text_sha256, embedding::text as embedding from zendesk_embedding_cache where text_sha256 = any($1)`,
    [hashes]
  );
  for (const r of rows) out.set(r.text_sha256, JSON.parse(r.embedding));
  return out;
}

/**
 * Replace ALL chunks for a ticket in one transaction (delete + insert) and warm
 * the embedding cache. This is the dedup guarantee: a ticket's prior rows are
 * gone before the current ones land.
 * @param meta normalized ticket meta (document.normalizeTicket)
 * @param chunks [{ chunkId, chunkIndex, text, sha, embedding }]
 */
export async function replaceTicket(meta, chunks, { model }) {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from zendesk_ticket_chunks where ticket_id = $1`, [meta.id]);
    for (const c of chunks) {
      await client.query(
        `insert into zendesk_ticket_chunks
           (chunk_id, ticket_id, chunk_index, subject, status, priority, type, channel, tags,
            requester, org, assignee, group_name, created_at, updated_at, url,
            problem_id, followup_source_id, followup_ids, incident_ids,
            text_content, text_sha256, embedding)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::vector)`,
        [
          c.chunkId, meta.id, c.chunkIndex, meta.subject, meta.status, meta.priority, meta.type, meta.channel, meta.tags,
          meta.requester, meta.org, meta.assignee, meta.group, meta.createdAt, meta.updatedAt, meta.url,
          meta.problemId, meta.followupSourceId, meta.followupIds, meta.incidentIds,
          c.text, c.sha, vectorLiteral(c.embedding),
        ]
      );
      await client.query(
        `insert into zendesk_embedding_cache (text_sha256, embedding, model)
         values ($1, $2::vector, $3) on conflict (text_sha256) do nothing`,
        [c.sha, vectorLiteral(c.embedding), model]
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Vector search with optional structured filters. Pulls the top candidate
 * chunks by cosine distance (HNSW), then dedupes to the best chunk per ticket.
 * filters: { status, tags[], dateFrom, dateTo, requester }
 */
export async function search(queryEmbedding, filters = {}, limit = 8) {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local hnsw.ef_search = ${HNSW_EF_SEARCH}`);

    const where = ["embedding is not null"];
    const params = [vectorLiteral(queryEmbedding)];
    if (filters.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
    if (filters.tags?.length) { params.push(filters.tags); where.push(`tags && $${params.length}`); }
    if (filters.dateFrom) { params.push(filters.dateFrom); where.push(`updated_at >= $${params.length}`); }
    if (filters.dateTo) { params.push(filters.dateTo); where.push(`updated_at <= $${params.length}`); }
    if (filters.requester) { params.push(`%${filters.requester}%`); where.push(`(requester ilike $${params.length} or org ilike $${params.length})`); }

    // Over-fetch candidates so the per-ticket dedupe still yields `limit` tickets.
    const candidates = Math.max(limit * 8, 60);
    const { rows } = await client.query(
      `select ticket_id, subject, status, priority, type, tags, requester, org, assignee, group_name,
              created_at, updated_at, url, problem_id, followup_source_id, followup_ids, incident_ids,
              text_content, (embedding <=> $1) as distance
         from zendesk_ticket_chunks
        where ${where.join(" and ")}
        order by embedding <=> $1
        limit ${candidates}`,
      params
    );
    await client.query("commit");

    const bestByTicket = new Map();
    for (const r of rows) {
      if (!bestByTicket.has(r.ticket_id)) bestByTicket.set(r.ticket_id, r);
    }
    return [...bestByTicket.values()].slice(0, limit);
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function getCursor() {
  const pool = await getPool();
  const { rows } = await pool.query(`select cursor_seconds from zendesk_sync_state where id = 1`);
  return rows[0]?.cursor_seconds != null ? Number(rows[0].cursor_seconds) : null;
}

export async function setCursor(seconds) {
  const pool = await getPool();
  await pool.query(
    `update zendesk_sync_state set cursor_seconds = $1, updated_at = now() where id = 1`,
    [Math.floor(seconds)]
  );
}

/** Used by verification/tests: how many chunk rows a ticket currently has. */
export async function countChunks(ticketId) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `select count(*)::int as n from zendesk_ticket_chunks where ticket_id = $1`,
    [ticketId]
  );
  return rows[0].n;
}

export { EMBED_DIM };
