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
export async function indexTicket(id, { zendesk, voyage, force = false } = {}) {
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
    const vectors = await voyage.embedDocuments(misses.map((c) => c.text));
    misses.forEach((c, i) => cached.set(c.sha, vectors[i]));
  }
  const withEmbeddings = chunks.map((c) => ({ ...c, embedding: cached.get(c.sha) }));
  await store.replaceTicket(meta, withEmbeddings, { model: voyage.model });

  return { ticketId: meta.id, chunks: chunks.length, embedded: misses.length, cached: chunks.length - misses.length, skipped: false };
}

/**
 * Walk the Incremental Ticket Export from the stored cursor (or `since`),
 * indexing each changed ticket and advancing the cursor by end_time. Bounded by
 * maxTickets to keep a single run sane.
 */
export async function runReconcile({ zendesk, voyage, since = null, maxTickets = 5000, onProgress = () => {} } = {}) {
  let cursor = since != null ? Math.floor(since) : await store.getCursor();
  if (cursor == null) cursor = Math.floor(Date.now() / 1000) - 30 * 24 * 3600; // first run: last 30 days
  let processed = 0;
  let pages = 0;

  while (processed < maxTickets) {
    const { tickets, endTime, hasMore } = await zendesk.incrementalTickets(cursor);
    for (const t of tickets) {
      try {
        const r = await indexTicket(t.id, { zendesk, voyage });
        onProgress({ ticketId: t.id, ...r });
      } catch (err) {
        onProgress({ ticketId: t.id, error: err.message });
      }
      processed++;
      if (processed >= maxTickets) break;
    }
    pages++;
    if (endTime != null) {
      cursor = endTime;
      await store.setCursor(cursor);
    }
    // Incremental export returns end_of_stream when caught up; also guard the
    // documented "same start_time echoed back" terminal case.
    if (!hasMore || !tickets.length) break;
  }
  return { processed, pages, cursor };
}
