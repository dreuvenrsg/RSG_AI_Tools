# 012 — Fulcrum invoicing-list UI redesign broke the Fulcrum stage

**Status:** shipped (2026-06-17)

## Problem / Goal

The Fulcrum stage (`fulcrumProcessor.js`) failed every nightly run since at
least **2026-06-13**, aborting before doing any work:

```
Fatal error: Invoicing page did not fully render: Waiting failed: 40000ms exceeded
- Fulcrum: 0 invoices created and issued
```

Root cause (confirmed against live Fulcrum + CloudWatch diagnostics): Fulcrum
**rebuilt the invoicing _list_ page** on a new Angular component library
(`j-*` components, TaifUI). Every selector the scraper used to read the list
disappeared, so `waitForInvoicingPageReady()` timed out at 40s and the whole
stage threw. The downstream QBO stage then sent 0 because nothing was issued.

Diagnostics showed the page loaded (`readyState: complete`, grid present) but
`kpiCards: []` and `rowCount: 0` — the old `kpi-total` KPI cards and `cdk-row`
table rows no longer existed.

**Key scoping discovery:** only the **list page** changed. Clicking a row's
"Create"/"Issue" button still navigates to the invoice **detail page**
(`/Invoicing/<id>`), which is **unchanged** — `.dropdown.actionsdrop
button.dropdown-toggle`, `button[name="Issued"]`, `.card-footer`,
`.modal-footer` are all intact. So `runCreateWorkflow` / `runIssueWorkflow`
detail-page logic needed no changes; the fix is confined to the list page.

## Old → new selector mapping (list page only)

| Purpose | Old | New |
|---|---|---|
| KPI "Needs Action" filter | `kpi-total[displaystatus="NEEDS ACTION"] button` | `j-kpi-filter[label="Needs Action"] button` |
| Filter-active signal | background-luminance heuristic | button gains class `active` (e.g. `juicy-kpi warning active`) |
| Table rows | `cdk-row` (tag) | `j-table-row` carrying **class** `cdk-row` → select `.cdk-row` |
| Row cells | `cdk-cell.cdk-column-X` (tag.class) | `j-table-cell` with **class** `cdk-column-X` → select `.cdk-column-X` |
| SO number | `…salesOrderNumber a b` | `.cdk-column-salesOrderNumber a` (no inner `<b>`) |
| Refund flag | `.refund-badge` | SO cell text `"SO#### - REFUND"` (badge gone) |
| Row Create/Issue button | `button.btn-primary` (text) | `.cdk-column-action button` (text; no `.btn-primary`) |
| Pagination | `.p-paginator-page` / `.p-paginator-next` (numbered) | `j-paginator` range label `"1 – 25 of 152"` + nav buttons `[first, prev, next, last]` (next = 2nd-to-last) |

## Tasks

- [x] Diagnose via CloudWatch (`[Debug]` diagnostics) + read-only live DOM dump.
- [x] Migrate `waitForInvoicingPageReady`, `findNeedsActionButton`,
      `waitForNeedsActionFilterApplied`, `getNeedsActionFilterState`,
      `collectPageDiagnostics` to the `j-kpi-filter` / `.active` model.
- [x] Migrate `extractRowData` to `.cdk-column-*` classes; parse parenthesized
      negatives; detect refunds from the SO cell text.
- [x] Migrate row selection (`.cdk-row`) and Create/Issue button detection
      (action-cell, no `.btn-primary`) across `processPage`,
      `findRowBySoNumber`, `scanCurrentViewForClaim`, `runCreateWorkflow`,
      `runIssueWorkflow`.
- [x] Rewrite `getPageInfo` for the range-based `j-paginator`; add
      `clickNextPageButton`; rewire `goToPage` / `checkNextPage`.
- [x] Leave detail-page create/issue workflow untouched (verified unchanged).

### Hardening (added after the first full local runs)

- [x] **UI regression guard.** `evaluateInvoicingUiHealth()` (pure, unit-tested)
      runs once per run via `runUiHealthCheckOnce` (module flag) at the end of
      `clickNeedsAction`. It verifies the KPI filter button, that a >0 KPI count
      has matching `.cdk-row`s (the exact silent-failure mode of this outage),
      the expected `.cdk-column-*` cells, an action button, and the paginator.
      Result rides on `fulcrumResults.uiHealthCheck`; `buildSummaryEmailContent`
      raises a loud top-of-body **ALERT box** + `⚠️ FULCRUM UI REGRESSION` subject
      prefix when it trips.
- [x] **`shouldProcessRow` no longer throws.** A row with no recognized
      Create/Issue button now returns `false` (skip) instead of throwing. The
      throw used to bubble up through `processPage` and abort the entire Fulcrum
      stage on a single odd row — observed on **SO2617** ($0 / $36,529.60, no
      action button), which halted run #2 after only 7 invoices. `processPage`
      also logs the action-cell text for such rows so a selector miss is
      distinguishable from a genuine no-action row.

### Timeout / retry behavior (`processCreate`, `processIssue`)

Fulcrum's detail pages are sometimes slow; the workflows treat **timeout-style
errors** (`Navigation timeout … exceeded` or `Waiting failed: …exceeded`, via
the shared `isCreateDetailTimeoutError` matcher) as retryable. CREATE retries up
to **3 attempts** (extended timeouts on retries: `extendedDetailTimeout: 50s`);
ISSUE retries up to **3 attempts** as well. Non-timeout errors (e.g. a button
genuinely absent) are **not** retried — they're logged, counted as a Fulcrum
error, the row is marked processed, and it's left for the next run.

Crucially, a retry is **recover-then-decide**, not a blind re-run, because a
timeout often fires *after* the action already took effect (so re-running would
create a **duplicate invoice**). On a timeout the code returns to the Needs
Action list, waits, re-finds the row by SO#, and branches:

| Row state after timeout | Action taken |
|---|---|
| Row gone from Needs Action | create+issue completed → assume success, no re-run |
| Row now shows **Issue** | draft was created → **switch to the ISSUE workflow** to finish it (fixes the old "Create button not found" hard-fail, e.g. SO9541/SO9859) |
| Row still shows **Create** | create never happened → **re-run CREATE** with extended waits (attempt 2/3) |
| Row shows something else (e.g. "Email") | already issued → assume success |

This means a genuinely-incomplete action is revisited up to 3×, while a timeout
on a *confirmation* wait is recognized as progress rather than re-attempted —
preventing duplicate invoices. Verified live in run #4: 14 timeouts, 3
Create→Issue switches, **0 hard failures** (those 3 would have been hard fails
before the fix).

## Verification

- [x] `npm test` — 65/65 green; module imports cleanly.
- [x] Read-only live run: filter applies (`juicy-kpi warning active`),
      paginator parses `152 items / 25 per page / 7 pages`, 25 `.cdk-row`
      extracted with correct SO/balance/total, refunds flagged & skipped.
- [x] **Supervised live create+issue (maxActionAttempts=1):** SO9291
      ($12,646.32) created & issued, 0 errors. Observable confirmation — the
      "Needs Action" KPI dropped **152 → 151** and **$127,588 → $114,941**
      (−$12,647 ≈ the invoice), proving it left the queue, not just that a
      click fired.
- [x] **Full local pipeline (`node V2_emailSender.js`, FULCRUM_MAX_ACTIONS=3):**
      end-to-end through both stages + summary email. Fulcrum issued SO8694 /
      SO9754 / SO9206; KPI decremented **151→150→149→148** (one per issue),
      refunds skipped, dedup held, stopped cleanly at the cap. QBO stage then
      found exactly those 3 (F10321-23), validated shipping, and emailed the
      correct customer primary addresses (JCI, Kidde Fenwal, Kidde Edwards) —
      3 sent, 0 skipped, 0 errors. Summary email delivered to ar@. (The QBO
      stage is naturally bounded to newly-issued/unsent invoices, so capping
      Fulcrum capped the whole run.)
- [ ] First unattended nightly run (5pm PT) processes the remaining ~148-item
      backlog without the render error. **Watch `npm run logs`.**

## Follow-ups

- [x] Deploy the selector migration to Lambda (commit `7afe489`).
- [ ] Deploy the hardening pass (UI regression guard + `shouldProcessRow` fix).
- [ ] The outage backlog is being drained via local runs; remaining items clear
      on the nightly run. Large batches can approach the 900s timeout (normal);
      consider a one-off higher `FULCRUM_WORKERS` if it lags.
- [x] Draft invoice **10320 (SO9796)** issued on a later run (picked up as an
      "Issue" row), confirming the self-heal path.
- [ ] **Retry edge case (`SO9541`-type).** When a timed-out CREATE already
      created the draft, the retry finds the row as an "Issue" row and fails with
      "Create button not found" (counts as 1 Fulcrum error; invoice is a safe
      created-but-unissued draft that self-heals next run). `processCreate`
      should detect this and switch to the Issue workflow instead of erroring.
- [ ] **Detail-page timeout rate.** Some runs see many CREATEs hit the ~30s
      detail-page wait and complete via the recovery path (slower, noisier).
      Mostly environmental (Fulcrum/network); revisit `waitForCreateDetailReady`
      timeouts if it persists in Lambda.
- [ ] These selectors are coupled to Fulcrum's `j-*` component DOM. If it
      changes again, the UI regression guard now raises an email alert and the
      `[Debug]`/`[UICheck]` log lines are the fastest way to re-diagnose.
