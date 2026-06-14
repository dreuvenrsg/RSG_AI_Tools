#!/usr/bin/env node
// Initial / catch-up backfill: walk the Incremental Ticket Export and index
// every changed ticket since a start time, advancing the stored cursor.
//   DATABASE_URL=... ZENDESK_TOKEN=... VOYAGE_API_KEY=... \
//     node src/zendesk/backfill.js [sinceUnixSeconds]
//   npm run zendesk:backfill            # full backfill from epoch
//
// With no argument it starts from 0 (the whole ticket history). Pass a Unix
// timestamp to start later, or set ZENDESK_BACKFILL_MAX to bound the run.
import { ZendeskClient } from "./client.js";
import { VoyageClient } from "./embeddings.js";
import { runReconcile } from "./indexer.js";
import { getPool } from "./store.js";

async function main() {
  const arg = process.argv[2];
  const since = arg != null ? Number(arg) : 0;
  const maxTickets = Number(process.env.ZENDESK_BACKFILL_MAX || 100000);

  const [zendesk, voyage] = await Promise.all([ZendeskClient.create(), VoyageClient.create()]);
  console.error(`[zendesk] backfilling from ${since} (max ${maxTickets} tickets)...`);
  const result = await runReconcile({
    zendesk,
    voyage,
    since,
    maxTickets,
    onProgress: (p) =>
      p.error
        ? console.error(`  ticket ${p.ticketId}: ERROR ${p.error}`)
        : console.error(`  ticket ${p.ticketId}: ${p.skipped ? "skip" : `${p.chunks} chunks (${p.embedded} embedded)`}`),
  });
  console.log(JSON.stringify(result, null, 2));
  await (await getPool()).end();
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
