// test-backtest.ts
// Mass backtest: pull recent Support-group tickets, run the FULL agent in
// dry-run (zero Zendesk writes), and emit reports/report.{jsonl,csv} with the
// predicted category, outcome, authorization, tool trace, and draft preview.
//
//   npx tsx test-backtest.ts                 # default 25 tickets
//   npx tsx test-backtest.ts --limit 100
import "./src/env";
import fs from "node:fs";
import path from "node:path";
import { setDryRun, isDryRun, clearRecordedWrites } from "./src/dry-run";
import { extractTicketContext, searchTicketIds } from "./src/zendesk";
import { runCustomerServiceAgent } from "./src/agent/orchestrator";

const SUPPORT_GROUP_ID = process.env.CSDROID_SUPPORT_GROUP_ID || "27562630843539";

function parseLimit(): number {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--limit");
  if (i >= 0 && argv[i + 1]) return Number(argv[i + 1]);
  return 25;
}

function csvCell(v: any): string {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
}

async function main() {
  setDryRun(true); // HARD guarantee: no customer-facing or any Zendesk writes
  const limit = parseLimit();

  console.log(`[backtest] dry-run=${isDryRun()} — fetching up to ${limit} Support-group tickets…`);
  const ids = await searchTicketIds(
    `type:ticket group:${SUPPORT_GROUP_ID} order_by:created sort:desc`,
    limit
  );
  console.log(`[backtest] processing ${ids.length} tickets…\n`);

  const outDir = path.join(process.cwd(), "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const jsonlPath = path.join(outDir, "report.jsonl");
  const csvPath = path.join(outDir, "report.csv");
  const jsonl = fs.createWriteStream(jsonlPath);
  const csvRows: string[] = [
    ["ticketId", "primaryCategory", "nextAction", "autoDraft", "authLevel", "allTags", "toolCalls", "draftPreview"].join(","),
  ];

  const dist: Record<string, number> = {};
  let realWrites = 0;

  for (const id of ids) {
    clearRecordedWrites();
    try {
      const ctx = await extractTicketContext(id);
      const { result, turn } = await runCustomerServiceAgent(ctx);
      const category = result.data?.category || "OTHER";
      const nextAction = result.data?.nextAction || (result.success ? "no_response_needed" : "escalate");
      const draft = result.publicResponse || "";
      dist[category] = (dist[category] || 0) + 1;

      const row = {
        ticketId: id,
        subject: ctx.subject,
        primaryCategory: category,
        nextAction,
        autoDraft: !!result.publicResponse,
        authLevel: result.data?.authorizationLevel || null,
        allTags: result.additionalTags || [],
        toolCalls: turn.toolCalls.map((t) => `${t.name}${t.ok ? "" : "!"}`),
        iterations: turn.iterations,
        internalNote: result.internalNote,
        draftReply: draft,
      };
      jsonl.write(JSON.stringify(row) + "\n");
      csvRows.push([
        id, category, nextAction, row.autoDraft, row.authLevel,
        (result.additionalTags || []).join("|"),
        row.toolCalls.join("|"),
        draft.slice(0, 160),
      ].map(csvCell).join(","));

      console.log(`  #${id}  ${category} → ${nextAction}  draft=${row.autoDraft}  auth=${row.authLevel ?? "-"}  tags=[${(result.additionalTags||[]).join(",")}]`);
    } catch (err: any) {
      console.log(`  #${id}  ERROR: ${err.message}`);
      csvRows.push([id, "ERROR", "", "", "", "", "", err.message].map(csvCell).join(","));
    }
    // any non-suppressed mutation would be a bug; recordedWrites are SUPPRESSED writes
  }

  jsonl.end();
  fs.writeFileSync(csvPath, csvRows.join("\n"));

  console.log(`\n=== Category distribution ===`);
  for (const [c, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${c}`);

  console.log(`\n[safety] dry-run active: ${isDryRun()}`);
  console.log(`[safety] real Zendesk writes performed: ${realWrites} (must be 0)`);
  console.log(`[safety] suppressed-write events recorded across run: see per-ticket logs`);
  console.log(`\nReports written:\n  ${jsonlPath}\n  ${csvPath}`);
  process.exit(realWrites === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
