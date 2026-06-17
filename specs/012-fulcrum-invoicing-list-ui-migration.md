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

- [ ] Deploy to Lambda (`npm run deploy`) so the nightly run picks up the fix.
      Until deployed, the scheduled run keeps failing.
- [ ] A ~151-invoice backlog accrued during the 4+ day outage; the first run
      after deploy will be large (watch for the 900s timeout — normal for big
      batches per CLAUDE.md). Consider a one-off higher `FULCRUM_WORKERS`.
- [ ] Draft invoice **10320 (SO9796)** was created during investigation and
      left unissued; it will be issued by the next run (now an "Issue" row) or
      can be issued/deleted manually.
- [ ] These selectors are now coupled to Fulcrum's `j-*` component DOM. If it
      changes again the same class of failure recurs — the `[Debug]`
      diagnostics line is the fastest way to re-diagnose.
