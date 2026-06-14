#!/usr/bin/env node
// Re-index specific Zendesk tickets by id — for backfilling gaps (e.g. tickets
// that failed mid-backfill) without re-scanning the whole incremental export.
//   node src/zendesk/reindex.js 31781 31776 31780
//   cat ids.txt | node src/zendesk/reindex.js
// Honors ZENDESK_REINDEX_CONCURRENCY (default 8). Forces re-index regardless of
// stored updated_at, so it also works to refresh already-indexed tickets.
import fs from "node:fs";
import { ZendeskClient } from "./client.js";
import { EmbeddingsClient } from "./embeddings.js";
import { indexTicket } from "./indexer.js";
import { getPool } from "./store.js";

async function mapWithConcurrency(items, limit, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    })
  );
}

async function main() {
  const args = process.argv.slice(2);
  const raw = args.length ? args.join(" ") : fs.readFileSync(0, "utf8");
  const ids = [...new Set(raw.split(/\s+/).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) {
    console.error("No ticket ids given (pass as args or pipe them in).");
    process.exit(1);
  }
  const concurrency = Number(process.env.ZENDESK_REINDEX_CONCURRENCY || 8);
  console.error(`[zendesk] re-indexing ${ids.length} tickets (concurrency ${concurrency})...`);

  const [zendesk, embeddings] = await Promise.all([ZendeskClient.create(), EmbeddingsClient.create()]);
  let ok = 0, failed = 0;
  await mapWithConcurrency(ids, concurrency, async (id) => {
    try {
      const r = await indexTicket(id, { zendesk, embeddings, force: true });
      ok++;
      console.error(`  ticket ${id}: ${r.chunks} chunks (${r.embedded} embedded)`);
    } catch (err) {
      failed++;
      console.error(`  ticket ${id}: ERROR ${err.message}`);
    }
  });
  console.log(JSON.stringify({ requested: ids.length, ok, failed }, null, 2));
  await (await getPool()).end();
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
