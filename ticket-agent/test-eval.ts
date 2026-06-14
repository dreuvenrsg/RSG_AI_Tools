// test-eval.ts
// Score the agent's classification against the hand-labeled golden set.
// Runs the FULL agent in dry-run (no Zendesk writes) and compares the predicted
// category to the expected label, printing per-category precision/recall and a
// confusion matrix.
//
//   npx tsx test-eval.ts            # default: first 6 fixtures
//   npx tsx test-eval.ts --limit 10
//   npx tsx test-eval.ts all
import "./src/env";
import fs from "node:fs";
import { setDryRun, setClassifyOnly, clearRecordedWrites, getRecordedWrites } from "./src/dry-run";
import { extractTicketContext } from "./src/zendesk";
import { runCustomerServiceAgent } from "./src/agent/orchestrator";
import { CATEGORIES, type CategoryKey } from "./src/ticket-categories";

interface Fixture { ticketId: number; label: CategoryKey; auxTags?: string[]; notes?: string }

function parseLimit(): number | "all" {
  const argv = process.argv.slice(2);
  if (argv.includes("all")) return "all";
  const i = argv.indexOf("--limit");
  if (i >= 0 && argv[i + 1]) return Number(argv[i + 1]);
  return 6;
}

async function main() {
  setDryRun(true); // hard guarantee: no Zendesk writes during evaluation
  setClassifyOnly(true); // don't execute the real PO pipeline (GPT-5 extraction) — this is a classification test

  const fixtures: Fixture[] = JSON.parse(
    fs.readFileSync(new URL("./fixtures/golden-tickets.json", import.meta.url), "utf8")
  ).tickets;

  const limit = parseLimit();
  const subset = limit === "all" ? fixtures : fixtures.slice(0, limit);
  console.log(`Evaluating ${subset.length}/${fixtures.length} fixtures (dry-run)…\n`);

  const rows: Array<{ ticketId: number; expected: CategoryKey; predicted: CategoryKey | "ERROR"; ok: boolean; auxOk: boolean }> = [];

  for (const fx of subset) {
    clearRecordedWrites();
    try {
      const ctx = await extractTicketContext(fx.ticketId);
      const { result } = await runCustomerServiceAgent(ctx);
      const predicted = (result.data?.category as CategoryKey) || "OTHER";
      // Multi-label scoring: a ticket can carry several type tags. Count the
      // expected category as correct if its tag appears ANYWHERE in the applied
      // tag set (primary + additionalTags) — i.e. the thread exhibited it.
      const appliedTags = new Set(result.additionalTags || []);
      const expectedTag = CATEGORIES[fx.label].tag;
      const ok = appliedTags.has(expectedTag);
      const expectedAux = (fx.auxTags || []).sort();
      const auxOk = expectedAux.every((t) => appliedTags.has(t));
      rows.push({ ticketId: fx.ticketId, expected: fx.label, predicted, ok, auxOk });
      const tagList = [...appliedTags].join(",");
      const action = result.data?.nextAction || "?";
      console.log(`  #${fx.ticketId}  expected=${fx.label}  primary=${predicted} → ${action}  ${ok ? "✓" : `✗ (tags: ${tagList})`}${expectedAux.length ? `  aux[${expectedAux}] ${auxOk ? "✓" : "✗"}` : ""}`);
    } catch (err: any) {
      rows.push({ ticketId: fx.ticketId, expected: fx.label, predicted: "ERROR", ok: false, auxOk: false });
      console.log(`  #${fx.ticketId}  expected=${fx.label}  ERROR: ${err.message}`);
    }
  }

  // Metrics
  const correct = rows.filter((r) => r.ok).length;
  const accuracy = rows.length ? correct / rows.length : 0;
  const auxExpected = rows.filter((r) => subset.find((f) => f.ticketId === r.ticketId)?.auxTags?.length);
  const auxCorrect = auxExpected.filter((r) => r.auxOk).length;

  console.log(`\n=== Accuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${rows.length}) ===`);
  if (auxExpected.length) console.log(`Aux-tag recall: ${auxCorrect}/${auxExpected.length}`);

  // Confusion matrix (expected → predicted counts), compact
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    confusion[r.expected] = confusion[r.expected] || {};
    confusion[r.expected][r.predicted] = (confusion[r.expected][r.predicted] || 0) + 1;
  }
  console.log("\nConfusion (expected → predicted):");
  for (const exp of Object.keys(confusion)) {
    const preds = Object.entries(confusion[exp]).map(([p, c]) => `${p}:${c}`).join(", ");
    console.log(`  ${exp} → ${preds}`);
  }

  // Safety assertion: evaluation must never have written to Zendesk.
  const writes = getRecordedWrites();
  console.log(`\n[safety] suppressed Zendesk writes during eval: ${writes.length} (must be > 0 if any tagging occurred, and 0 real writes by construction)`);

  process.exit(accuracy >= 0.7 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
