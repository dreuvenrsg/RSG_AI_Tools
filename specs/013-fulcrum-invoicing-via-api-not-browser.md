# 013 — Drive Fulcrum invoicing via its API instead of browser automation

**Status:** planned

## Problem / Goal

The Fulcrum stage (`fulcrumProcessor.js`) drives the invoicing **list page** with
Puppeteer: it scrapes the DOM page-by-page and *clicks* Create/Issue, each of
which opens a detail page. This is slow and fragile:

- Each create/issue is a full browser round-trip (navigate → detail page →
  Actions dropdown → confirm modal), and the detail page frequently takes
  >30s to render, so runs hit heavy timeout churn (observed: 14 timeouts in
  one run) and the 11-min stage budget / 20-page cap before clearing much
  (~5–13 invoices/run). A ~100-item backlog takes many runs / days.
- It depends on the redesigned `j-*` DOM (specs/012); UI changes break it.

**Goal:** drive invoicing through Fulcrum's HTTP API directly — no DOM
scraping, no clicking — so the whole Needs Action list is read in one call and
create/issue are direct (parallelizable) requests. This is faster, more
robust, and potentially removes the need for headless Chromium entirely.

## What was confirmed (live capture, 2026-06-17)

Every UI click is a call to Fulcrum's app backend at
`rsgsecurity.fulcrumpro.com/api/...`, **cookie-authenticated** (session from
`POST /api/Login/Login` — multipart Email/Password/RememberMe/csrfToken — plus
`POST /api/Login/RefreshToken`). There is also a `/v2/graphql` surface (used
for chat/etc.). Separately, the **public Bearer API** `api.fulcrumpro.com/api`
(key in SSM `/rsg-ai/prod/fulcrum-api-key`) is already used for reads by
`src/fulcrum/client.js` and the monolith's QBO stage.

**Reads — confirmed replaceable (demonstrated end-to-end):**
```
GET /api/Invoices/GetInvoiceGridDataQuery
    ?Status=Needs Action&CustomerId=&Paging.Skip=0&Paging.Take=500
    &Sort.Field=invoiceStatus&Sort.Dir=asc&OmniSearch=
→ 200, JSON { data: [...], total, kpiData }
```
One authenticated GET returned the entire backlog (99 rows). Each row already
carries the fields the scraper computes by hand:
- `invoice` — **null ⇒ needs Create**; an object with `invoiceStatus:"Unissued"`
  ⇒ needs Issue
- `hasRefund` (bool), `salesOrderBalance`, `invoiceTotal` (numbers)
- `id` (invoice id), `salesOrder.{id,name}`, `customerSummary`, `shippingStatus`
- KPI: `GET /api/Invoices/GetUnpaidInvoiceKPIDataQuery/GetUnpaidInvoiceKPIQuery?CustomerId=`

**Writes — partially observed, NOT yet confirmed:**
- During an Issue, the only state-changing call seen was
  `GET /api/Invoices/GetInvoiceEmailCommand?InvoiceIds=<id>&UpdateStatus=true&BaseUrl=https://rsgsecurity.fulcrumpro.com`
  — promising (looks like it issues + prepares the email), but **unconfirmed**
  as *the* issue trigger vs. a detail-page side effect.
- The **Create** mutation endpoint (the call that creates an invoice from a
  sales order) was **not** isolated yet.

**Auth for replay:** after one Puppeteer login, calling `fetch()` from the page
context (`page.evaluate`) carries the session cookie + CSRF automatically —
proven to work for the read call above. Open question: whether the public
Bearer API exposes create/issue (if so, no browser at all → runs server-side in
Lambda with no Chromium).

## Approach (staged, write path gated)

- **Phase 0 — confirm endpoints (no behavior change).** Capture a clean Create
  to identify the create mutation + payload; confirm whether
  `GetInvoiceEmailCommand?UpdateStatus=true` is the issue trigger and that it
  (a) marks the invoice Issued, (b) sends the customer email, (c) triggers the
  Fulcrum→QBO sync — matching the click path. Check the public Bearer API for
  create/issue support and CSRF/header requirements.
- **Phase 1 — reads via API (low risk).** Replace DOM scrape + pagination with
  `GetInvoiceGridDataQuery` to build the work list (map `invoice==null`→Create,
  `Unissued`→Issue, plus `hasRefund`/balance/total for `shouldProcessRow`).
  Keep the proven click-issuer for writes initially. Ship + verify.
- **Phase 2 — writes via API (supervised).** Implement create/issue as direct
  requests behind a flag (e.g. `FULCRUM_API_MODE`), with `CSDROID_DRY_RUN`-style
  suppression and a supervised single-invoice rollout. Verify against real
  observable outputs before trusting the batch. Keep the browser path as a
  fallback. Parallelize in rate-limited batches (cf. QBO stage `BATCH_SIZE`).
- **Phase 3 — optional infra win.** If the Bearer API supports writes, move the
  Fulcrum stage server-side and drop the Chromium layer / 3008MB / 900s config
  in `template.yaml`.

## Tasks

- [ ] Phase 0: capture + document the Create mutation (endpoint, method, payload).
- [ ] Phase 0: confirm the Issue trigger and that it emails + QBO-syncs identically.
- [ ] Phase 0: test whether `api.fulcrumpro.com` (Bearer key) supports create/issue.
- [ ] Phase 1: list discovery via `GetInvoiceGridDataQuery` (paged), mapped to the
      existing `shouldProcessRow` inputs; feed the current click-issuer.
- [ ] Phase 2: direct create/issue behind `FULCRUM_API_MODE`, dry-run + supervised
      single-invoice verify, then batch with rate limiting; browser path as fallback.
- [ ] Extend the UI/health-alert idea to the API (loud alert on unexpected
      HTTP status / shape change), analogous to specs/012's guard.
- [ ] Phase 3 (optional): server-side stage, remove Chromium from `template.yaml`.

## Verification

- [ ] Phase 1: API-derived work list matches a DOM scrape of the same moment
      (same SOs, Create vs Issue classification, refund flags).
- [ ] Phase 2: supervised single invoice issued via API shows, against real
      outputs: Fulcrum status = Issued, customer email sent, QBO synced — same as
      the click path. Then a bounded batch, then full.
- [ ] `npm test` green (pure mapping/decision functions unit-tested).

## Risks / open questions

- **Irreversibility:** issuing emails the customer and syncs to QBO; the write
  path must be proven equivalent before batch use. Start dry-run + 1 invoice.
- **Undocumented internal API:** `rsgsecurity.fulcrumpro.com/api` can change —
  but an HTTP error is louder than silent DOM breakage, and the guard pattern
  from specs/012 extends naturally (alert on bad status/shape).
- **Auth lifetime:** session/RefreshToken cadence for long runs; or Bearer key
  if the public API suffices.
- **CSRF:** login uses a csrfToken; raw replay may need CSRF headers
  (page-context fetch sidesteps this).
- **Where write capability lives:** `src/fulcrum/client.js` is deliberately
  read-only (project invariant). Any API writes belong in the monolith's
  invoicing stage, not that guard — do not weaken `src/`'s read-only rule.

## Follow-ups (carried from specs/012)

- The detail-page timeout rate that motivated this is itself the symptom the API
  path eliminates.
- If Phase 2 lands, the create→Issue retry switch and timeout retries in
  `processCreate`/`processIssue` become moot for the API path (keep for the
  browser fallback).
