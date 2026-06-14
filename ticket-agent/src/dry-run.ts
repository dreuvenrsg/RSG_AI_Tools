// src/dry-run.ts
// A process-wide kill-switch for all Zendesk writes.
//
// When dry-run is ON, every mutating Zendesk call (comments, tags, status,
// attachments) becomes a no-op that is RECORDED instead of executed. This lets
// us backtest the full classify → handle → draft pipeline over hundreds of real
// historical tickets without ever touching a customer's ticket.
//
// Enable via env (CSDROID_DRY_RUN=1) or programmatically with setDryRun(true).

export interface RecordedWrite {
  fn: string;
  ticketId?: number;
  detail?: Record<string, any>;
}

let dryRun = /^(1|true|yes)$/i.test(process.env.CSDROID_DRY_RUN || "");
const recorded: RecordedWrite[] = [];

export function setDryRun(on: boolean): void {
  dryRun = on;
}

export function isDryRun(): boolean {
  return dryRun;
}

// Classification-only mode (for the eval): the agent still ROUTES a PO ticket to
// run_po_pipeline, but the tool short-circuits instead of executing the real
// deterministic pipeline (PDF fetch + GPT-5 Vision extraction + Fulcrum match).
// The classification is already decided at classify_and_tag, so re-processing
// POs that are already in Fulcrum during a test is pure waste.
let classifyOnly = /^(1|true|yes)$/i.test(process.env.CSDROID_CLASSIFY_ONLY || "");

export function setClassifyOnly(on: boolean): void {
  classifyOnly = on;
}

export function isClassifyOnly(): boolean {
  return classifyOnly;
}

/** Record an intended (but suppressed) Zendesk write. Returns true in dry-run. */
export function recordWrite(entry: RecordedWrite): boolean {
  if (!dryRun) return false;
  recorded.push(entry);
  console.log(`[dry-run] suppressed ${entry.fn}${entry.ticketId ? ` (ticket ${entry.ticketId})` : ""}`);
  return true;
}

export function getRecordedWrites(): RecordedWrite[] {
  return [...recorded];
}

export function clearRecordedWrites(): void {
  recorded.length = 0;
}
