# 015 — Fulcrum→QBO sync gap: poll-until-synced + issued-vs-sent reconciliation

**Status:** shipped (2026-06-26)

## Problem / Goal

On the 2026-06-23 production run (Zendesk #34752), the Fulcrum stage **created &
issued 8 invoices** (F10482–F10489) but the QBO send stage **sent only 6**. The
two missing ones — **F10488 (Potter)** and **F10489 (ADI)** — were the
*newest/last-issued* invoices, and the summary reported "0 need attention." They
weren't flagged; they were simply **absent** from the summary entirely.

Two contributing causes, one underlying:

1. **Fixed-wait sync race.** After Fulcrum issues invoices, `waitForFulcrumQboSync`
   (`V2_emailSender.js`) slept a **fixed 20s** (`FULCRUM_QBO_SYNC_WAIT_MS`) for the
   async Fulcrum→QBO sync, then the QBO stage ran `getUnsentUnpaidInvoices()`
   (`Balance > 0` and `EmailStatus ∈ {NeedToSend, NotSet}`). The last-issued
   invoices hadn't finished syncing into QBO within that 20s window, so they were
   **never fetched as candidates** — they slip to the next run. The wait was a
   single `setTimeout` with no confirmation that the issued invoices had landed.

2. **No reconciliation = silent.** The summary reported "8 created"
   (`fulcrumResults.processedInvoices.length`) and "6 sent" (`results.sent`)
   **independently**. Nothing compared the two sets, so a gap produced **no
   ACTION REQUIRED item**.

The "stale email" angle on F10489 is a **symptom, not a separate bug**: the send
stage *overwrites* `BillEmail` with the freshly-resolved recipient (QBO customer
`PrimaryEmailAddr`, or HLI ship-to routing) via a sparse update **before**
sending. F10489 kept its old (Fulcrum-synced) address only because the send stage
never processed it. Fixing the fetch fixes the email — no email-specific change.

Goal: just-issued invoices reliably send the **same** run, and **any**
issued-but-not-sent invoice is **loudly flagged** in the summary instead of
disappearing.

## Approach (poll-until-synced + safety-net reconciliation)

1. **Capture the Fulcrum invoice number as a reconciliation key.** QBO's
   `DocNumber` is the Fulcrum invoice's numeric `number` with an `F` prefix
   (e.g. 10488 → "F10488"; same digits relationship `findFulcrumInvoiceByDocNumber`
   already uses). API mode (prod default) reads each issued invoice's `number`
   post-issue (`fulcrumInvoiceDocNumber` in `fulcrumInvoiceApi.js`) and adds
   `invoiceNumber` to each `processedInvoices` entry — best-effort, a read failure
   leaves it null and never fails the (already successful) issue. Browser mode
   doesn't capture it and degrades to the legacy fixed wait (documented; follow-up).

2. **Poll instead of a fixed sleep.** `waitForFulcrumQboSync` builds the expected
   DocNumber set from the captured numbers and polls a cheap targeted query
   (`invoiceModule.findInvoicesByDocNumbers` → `DocNumber IN (...)`) every
   `FULCRUM_QBO_SYNC_WAIT_MS` (default 20000) until all are visible, up to
   `FULCRUM_QBO_SYNC_MAX_WAIT_MS` (default 120000). On a normal run it exits in a
   check or two; on timeout it proceeds and step 3 flags whatever stayed unsent.
   No captured numbers → legacy single fixed wait.

3. **Reconcile issued-vs-sent in the summary.** Pure exported
   `reconcileIssuedVsSent({ processedInvoices, details })` returns issued invoices
   that QBO never even fetched (not sent/skipped/errored — those already surface in
   their own ACTION REQUIRED sections). `buildSummaryEmailContent` adds an ACTION
   REQUIRED section naming each (F-number + SO), which also bumps `actionItemCount`
   so the "needs attention" total is accurate. Unkeyed (browser-mode) issued
   invoices are counted, not flagged (a count compare is unreliable — the QBO query
   spans a 30-day window that includes prior runs' invoices).

## Tasks

- [x] `fulcrumInvoiceDocNumber()` + capture `invoiceNumber` per issued invoice in
      `runInvoicingViaApi` / `runFulcrumApiMode` (`fulcrumInvoiceApi.js`).
- [x] Note browser-mode limitation at the `fulcrumProcessor.js` push sites.
- [x] `invoiceModule.findInvoicesByDocNumbers()` targeted `DocNumber IN (...)` query.
- [x] Rework `waitForFulcrumQboSync` into a bounded poll; add `normalizeDocNumber`.
- [x] `reconcileIssuedVsSent` (pure, exported) + ACTION REQUIRED section wiring.
- [x] `FULCRUM_QBO_SYNC_MAX_WAIT_MS` env in `template.yaml`.
- [x] Unit tests (`tests/invoiceSender.test.js`, `tests/fulcrumInvoiceApi.test.js`).
- [x] Document in `CLAUDE.md` + `index.md`.

## Verification

- `npm test` — passing (7 new reconciliation/sync tests in `invoiceSender.test.js`;
  `fulcrumInvoiceApi.test.js` extended, all injected — no network).
- Reconciliation proven against the 2026-06-23 scenario: 8 issued, only F10483 in
  `details` → F10488/F10489 surface in ACTION REQUIRED, `actionItemCount` reflects it.
- `npm run build` for the `template.yaml` env change.
- Operational: a fast-sync run exits the poll in one check and shows "0 need
  attention"; set `FULCRUM_QBO_SYNC_MAX_WAIT_MS` low to force the timeout path and
  confirm the ACTION REQUIRED alert fires and names the invoice.

## Follow-ups

- [ ] Confirm next scheduled run picked up F10488/F10489 (or that the operator's
      manual send cleared them) so they aren't double-counted.
- [ ] Browser-mode precise F-number capture (count-only fallback for now).
- [ ] Stale-recipient guarding beyond the existing monthly mis-route audit.
- [ ] Related over-strict send guards: same-date shipment guard (spec 011),
      tracking-optional Will Call (spec 014).
