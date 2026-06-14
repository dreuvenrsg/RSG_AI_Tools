// test-safety.ts
// Verifies the structural guarantees that we never message a customer:
//   1. Any attempt to post a PUBLIC comment throws.
//   2. In dry-run, private writes are suppressed (recorded, not executed).
// Run: npx tsx test-safety.ts
import "./src/env";
import { setDryRun, clearRecordedWrites, getRecordedWrites } from "./src/dry-run";
import { attachFileToTicket, updateTicketWithResult } from "./src/zendesk";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failures++;
}

async function main() {
  setDryRun(true);

  // 1. Public comment must be refused — even in dry-run, the assert runs first.
  let threw = false;
  try {
    await attachFileToTicket(1, "x.txt", "x", "text/plain", "note", { public: true });
  } catch (err: any) {
    threw = /PUBLIC/i.test(err.message);
  }
  check("attachFileToTicket({public:true}) throws a safety error", threw);

  // 2. Private attach is suppressed in dry-run (returns a stub token, no fetch).
  clearRecordedWrites();
  const res = await attachFileToTicket(1, "x.txt", "x", "text/plain", "note", { public: false });
  check("attachFileToTicket({public:false}) suppressed in dry-run", res.uploadToken === "dry-run");

  // 3. updateTicketWithResult (always private) is suppressed and recorded.
  clearRecordedWrites();
  await updateTicketWithResult(
    1,
    { success: true, requiresHumanReview: false, reason: "t", tag: "AI_READY_FOR_HUMAN_REVIEW", internalNote: "n", publicResponse: "draft", additionalTags: ["order_tracking"] },
    "there"
  );
  const recorded = getRecordedWrites();
  check("updateTicketWithResult suppressed + recorded in dry-run", recorded.some((w) => w.fn === "updateTicketWithResult"));

  console.log(`\n${failures === 0 ? "ALL SAFETY CHECKS PASSED" : `${failures} SAFETY CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
