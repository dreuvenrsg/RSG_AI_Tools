// test-analytics.ts
// Read-only: report ticket volume by type tag x outcome tag, so we can see which
// categories are being auto-handled (ai_ready_for_human_review) vs escalated
// (ai_alert_human_review_required). This is the measurement the new tagging
// unlocks. No writes.
// Run: npx tsx test-analytics.ts
import "./src/env";
import { searchTicketIds } from "./src/zendesk";
import { CATEGORIES, CATEGORY_KEYS, AUX_TAGS, OUTCOME_TAGS } from "./src/ticket-categories";

async function count(query: string): Promise<number> {
  return (await searchTicketIds(query, 1000)).length;
}

async function main() {
  console.log("Ticket-type x outcome analytics (read-only)\n");
  console.log("category".padEnd(22), "total".padStart(6), "ready".padStart(7), "alert".padStart(7));
  console.log("-".repeat(46));

  for (const key of CATEGORY_KEYS) {
    const tag = CATEGORIES[key].tag;
    const total = await count(`tags:${tag}`);
    if (total === 0) continue;
    const ready = await count(`tags:${tag} tags:${OUTCOME_TAGS.READY}`);
    const alert = await count(`tags:${tag} tags:${OUTCOME_TAGS.ALERT}`);
    console.log(tag.padEnd(22), String(total).padStart(6), String(ready).padStart(7), String(alert).padStart(7));
  }

  const poNotEntered = await count(`tags:${AUX_TAGS.PO_NOT_ENTERED}`);
  console.log(`\nAux: ${AUX_TAGS.PO_NOT_ENTERED} = ${poNotEntered}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
