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
- `invoice` — **null ⇒ Create row**; an object ⇒ an invoice exists (Issue row).
  `invoiceStatus` is "New" for all Needs Action rows, so it does NOT distinguish
  create/issue — key off `invoice` presence (matches the DOM's action button).
- `hasRefund` (bool), `salesOrderBalance`, **`invoiceTotalV2`** (numbers)
- **Total field gotcha (verified by matching DOM cells to API fields):** the
  grid's "invoice-total" column binds to **`invoiceTotalV2`**, NOT `invoiceTotal`.
  For a create row V2 == the full amount; for an already-created invoice V2 == 0
  (nothing pending) — which is exactly why the scrape skips those. Using
  `invoiceTotal` instead caused 6 false "issue" classifications. The DOM also
  strips accounting parens (negatives shown positive), so we read `abs(V2)`.
- `id` (invoice id), `salesOrder.{id,name}`, `customerSummary`, `shippingStatus`
- KPI: `GET /api/Invoices/GetUnpaidInvoiceKPIDataQuery/GetUnpaidInvoiceKPIQuery?CustomerId=`

**Skip parity confirmed (Phase 1):** `fulcrumInvoiceApi.js` fetches the list and
classifies each row via the SAME `shouldProcessRow` the browser uses. A live
check classified **99/99 rows identically** to a DOM scrape of the same moment
(49 create, 0 issue, 50 skip = 39 refund + 6 issue-zero-total + 5 create-zero) —
0 mismatches.

**Writes — Phase 0 results (captured 2026-06-17):**
- **CREATE is a clean REST call (replayable):**
  `POST /api/Invoices/CreateInvoiceFromSalesOrderCommand?SalesOrderId=<soId>&InvoiceGridId=<gridGuid>&IsDeposit=false`
  (empty body, cookie auth). The Angular list page calls this when you click
  "Create"; it creates the draft invoice. `SalesOrderId` = `salesOrder.id` from
  the grid row; `InvoiceGridId` is a per-session grid GUID.
- **ISSUE is NOT a replayable HTTP call — the invoice detail page is Blazor
  Server.** During the full Actions→Issued→Ok confirm, the only HTTP request
  observed was `POST /_blazor/disconnect`; the issue happens over the Blazor
  **SignalR WebSocket**, which Puppeteer request-interception can't capture and
  we can't simply replay. (The earlier `GetInvoiceEmailCommand?UpdateStatus=true`
  GET is a server-driven side effect of the Blazor issue, not a standalone
  trigger.) So the list is Angular+REST, but the **detail/issue UI is Blazor**.
- **Implication:** issuing via the internal UI surface is not HTTP-replayable.

**Public Bearer API (`api.fulcrumpro.com/api`, key in SSM) — from the docs
(developers.fulcrumpro.com/api-schema):**
- **`POST /api/invoices/{id}/status`** ("Update an invoice status") — the likely
  server-side **ISSUE** endpoint, no browser/Blazor. Also `GET/PUT/PATCH
  /api/invoices/{id}`, `POST /api/invoices/list`, and line-item endpoints.
- **No create-from-sales-order endpoint** in the public API (docs may be
  truncated, but not found) — so CREATE likely stays on the internal
  `CreateInvoiceFromSalesOrderCommand` (session/cookie).

**Resulting target architecture (inverted from the original guess):**
- Discover: internal `GetInvoiceGridDataQuery` (cookie) — done, Phase 1a.
- Create draft: internal `CreateInvoiceFromSalesOrderCommand` (cookie) — fast REST.
- Issue: **public `POST /api/invoices/{id}/status`** (Bearer key) — server-side,
  removes the slow Blazor detail-page step entirely.

**Status enum confirmed (read-only, via our Bearer key):** invoice `status` is
the issue lifecycle — values include `new` (draft), **`issued`**, `paid` (a
50-invoice sample tallied `{paid:49, issued:1}`). So issuing = `POST
/api/invoices/{id}/status` with `status:"issued"`. The path is viable.

**KEY OPEN RISK (must verify before any batch):** does the public status change
to `issued` also (a) email the customer and (b) trigger the Fulcrum→QBO sync,
exactly as the UI issue does? If it only flips status without emailing/syncing,
it is NOT equivalent and would break downstream. Requires a supervised
single-invoice test comparing real outputs (Fulcrum status, customer email
sent, QBO sync) against the click path. This test issues a real invoice via the
unverified path (emails a customer), so it needs explicit go-ahead.

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

- [x] Phase 0: Create mutation documented — `POST CreateInvoiceFromSalesOrderCommand`
      (clean REST, replayable).
- [x] Phase 0: Issue path investigated — it's **Blazor SignalR**, not a
      replayable REST call (see Writes above). This blocks pure-API issuing via
      the internal UI surface.
- [x] Phase 0: public Bearer API check — `POST /api/invoices/{id}/status` exists
      (issue candidate, server-side); no public create-from-SO endpoint.
- [x] Phase 0 (final, supervised): **VERIFIED.** Created a draft via
      `CreateInvoiceFromSalesOrderCommand` (response `{createdInvoiceId}`), then
      `POST /api/invoices/{id}/status {"status":"issued"}` → HTTP 200; within 8s
      the invoice showed `status=issued`, `issueDate` set, and
      `externalReferences.qbo-invoice` populated (QBO id + URL) — i.e. it issued
      AND triggered the Fulcrum→QBO sync (which auto-emails) exactly like the UI.
      Test invoice: 10384 / SO9737 / $0.60 → QBO 223798. Payload schema:
      `InvoiceRequestUpdateStatus { status: enum[new,needsApproval,approved,issued,paid], paidDate? }`.

**Phase 0 conclusion:** the full API path works browser-free for issue —
discover (`GetInvoiceGridDataQuery`, cookie) → create (`CreateInvoiceFrom
SalesOrderCommand`, cookie) → issue (`POST /api/invoices/{id}/status` `{issued}`,
Bearer). Proceed to build (Phase 2) behind a flag with dry-run + browser fallback.
- [x] Phase 1a: `fulcrumInvoiceApi.js` — fetch the Needs Action list via
      `GetInvoiceGridDataQuery` (paged), normalize + classify reusing
      `shouldProcessRow`; pure functions unit-tested; **99/99 live skip parity**
      vs the DOM scrape (refunds + zero values + create/issue all match).
- [ ] Phase 1b: wire the API plan into the run (behind a flag) to drive the
      existing click-issuer via `findRowBySoNumber`, replacing the DOM
      discovery/pagination walk.
- [x] Phase 2a: `fulcrumInvoiceApi.js` write primitives + orchestrator —
      `createInvoiceFromSalesOrder` (session), `issueInvoiceViaApi` (Bearer),
      `getInvoiceById`, `runInvoicingViaApi` (dry-run, maxActions cap, skip bucket
      untouched, per-invoice error isolation; DI'd create/issue). Unit-tested
      (91/91). Live-verified: dry-run planned 46 create / 50 skip (parity held);
      a maxActions=1 live run created+issued SO9772 → invoice 10385 → QBO 223799.
- [x] Phase 2b: wired into the Fulcrum stage via `runFulcrumStage` behind
      `FULCRUM_API_MODE` (default OFF → no behavior change); `runFulcrumApiMode`
      logs in for the session then discovers+creates+issues via API and returns
      the `runFulcrumProcessor` result shape (summary email unchanged).
      `FULCRUM_API_DRY_RUN` plans only. Added IAM read for
      `/rsg-ai/prod/fulcrum-api-key`. Verified: dry-run wrapper (45 create
      planned, parity held, email builds) + live `maxActions=3` batch
      (SO9812/9827/9823 issued, QBO 223800/223801/sync, 0 errors). Tests 91/91.
- [x] Enablement: prod-verified 2026-06-17 — triggered the Lambda with a capped
      API-mode event (`{fulcrumApiMode:true, fulcrumMaxActionAttempts:5}`); it ran
      `runFulcrumApiMode` in headless-Lambda Chromium (login + plan fetch + SSM
      key load via the new IAM grant), QBO-sent, and emailed the summary, clean.
      Then set **`FULCRUM_API_MODE: '1'` in `template.yaml` (uncapped — no
      `FULCRUM_MAX_ACTIONS`)**, so the nightly run now uses the API path and
      processes everything. Revert by setting it to `''`. A per-invocation event
      override (`fulcrumApiMode`/`fulcrumApiDryRun`) exists for one-off control.
- [~] Phase 3 (drop Chromium) — investigated 2026-06-17, **blocked**: the public
      Bearer API has **no invoice-create endpoint** (exhaustive swagger scan).
      `PUT /api/invoices/{id}` (UpdateInvoice) only patches `externalReferences`
      (its `InvoiceUpdateDto` has just that one property); there's no
      `POST /api/invoices`, no sales-order→invoice op (only quote→SO). So **create
      requires the internal cookie-authed `CreateInvoiceFromSalesOrderCommand`**,
      i.e. the browser login is unavoidable for create (issue is already
      browser-free via the Bearer API). Only way to drop Chromium would be to
      replicate the ASP.NET-antiforgery HTTP login (fragile/undocumented) — not
      worth it since browser login is no longer the bottleneck. Revisit only if
      Fulcrum adds a public create endpoint or infra/cold-start cost forces it.
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
