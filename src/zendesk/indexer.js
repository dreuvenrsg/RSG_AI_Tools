// Ticket indexing orchestration: fetch a ticket bundle, build its document,
// embed only the chunks whose text changed (the rest hit the embedding cache),
// and replace the ticket's rows transactionally. Also the incremental-export
// reconciliation loop that backfills and catches anything the webhook missed.
//
// indexTicket/runReconcile take their clients as args so they're easy to drive
// from the webhook route, the reconcile timer, and the backfill script alike.
import crypto from "node:crypto";
import { normalizeTicket, chunkDocument } from "./document.js";
import * as store from "./store.js";

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Index (or re-index) a single ticket. By default skips work when the stored
 * copy is already at or past Zendesk's updated_at (so duplicate/late webhook
 * fires are no-ops); pass force:true to rebuild regardless.
 * @returns {{ ticketId, chunks, embedded, cached, skipped }}
 */
export async function indexTicket(id, { zendesk, embeddings, force = false } = {}) {
  const bundle = await zendesk.getTicketBundle(id);
  const meta = normalizeTicket(bundle);

  if (!force) {
    const stored = await store.getTicketUpdatedAt(meta.id);
    if (stored && meta.updatedAt && new Date(meta.updatedAt) <= new Date(stored)) {
      return { ticketId: meta.id, chunks: 0, embedded: 0, cached: 0, skipped: true };
    }
  }

  const chunks = chunkDocument(meta).map((c) => ({ ...c, sha: sha256(c.text) }));
  const cached = await store.getCachedEmbeddings(chunks.map((c) => c.sha));
  const misses = chunks.filter((c) => !cached.has(c.sha));
  if (misses.length) {
    const vectors = await embeddings.embedDocuments(misses.map((c) => c.text));
    misses.forEach((c, i) => cached.set(c.sha, vectors[i]));
  }
  const withEmbeddings = chunks.map((c) => ({ ...c, embedding: cached.get(c.sha) }));
  await store.replaceTicket(meta, withEmbeddings, { model: embeddings.model });

  return { ticketId: meta.id, chunks: chunks.length, embedded: misses.length, cached: chunks.length - misses.length, skipped: false };
}

/** Run `fn` over items with at most `limit` in flight at once. */
async function mapWithConcurrency(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/**
 * Walk the Incremental Ticket Export from the stored cursor (or `since`),
 * indexing each changed ticket and advancing the cursor by end_time. Bounded by
 * maxTickets to keep a single run sane. Tickets within a page are indexed with
 * bounded concurrency (each ticket is independent — its own transaction); 429s
 * self-throttle via the Zendesk client's retry/backoff.
 */
export async function runReconcile({ zendesk, embeddings, since = null, maxTickets = 5000, concurrency = 1, onProgress = () => {} } = {}) {
  let cursor = since != null ? Math.floor(since) : await store.getCursor();
  if (cursor == null) cursor = Math.floor(Date.now() / 1000) - 30 * 24 * 3600; // first run: last 30 days
  let processed = 0;
  let pages = 0;

  while (processed < maxTickets) {
    const { tickets, endTime, hasMore } = await zendesk.incrementalTickets(cursor);
    const batch = tickets.slice(0, Math.max(0, maxTickets - processed));
    await mapWithConcurrency(batch, concurrency, async (t) => {
      try {
        const r = await indexTicket(t.id, { zendesk, embeddings });
        onProgress({ ticketId: t.id, ...r });
      } catch (err) {
        onProgress({ ticketId: t.id, error: err.message });
      }
    });
    processed += batch.length;
    pages++;
    if (endTime != null) {
      cursor = endTime;
      await store.setCursor(cursor);
    }
    // Incremental export returns end_of_stream when caught up; also guard the
    // documented "same start_time echoed back" terminal case.
    if (!hasMore || !tickets.length || processed >= maxTickets) break;
  }
  return { processed, pages, cursor };
}
