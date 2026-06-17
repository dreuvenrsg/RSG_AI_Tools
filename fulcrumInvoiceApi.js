// Fulcrum invoicing via the app's HTTP API (specs/013), Phase 1: discovery.
//
// The invoicing LIST page is rendered from a single authenticated endpoint,
// GET /api/Invoices/GetInvoiceGridDataQuery?Status=Needs Action&..., which
// returns the whole Needs Action set as JSON. This module fetches that list and
// classifies each row into create / issue / skip — REUSING shouldProcessRow so
// the skip rules (refunds, zero/blank values, etc.) are byte-for-byte identical
// to the browser-scrape path. No DOM scraping, no pagination clicks.
//
// Writes (actually create/issue via API) are a later, supervised phase; this
// module only reads + plans.
import { shouldProcessRow } from "./fulcrumProcessor.js";

const NEEDS_ACTION_GRID_PATH =
  "/api/Invoices/GetInvoiceGridDataQuery?Status=Needs%20Action&CustomerId=" +
  "&Paging.Skip=__SKIP__&Paging.Take=__TAKE__&Sort.Field=invoiceStatus&Sort.Dir=asc&OmniSearch=";

// Replicate how the browser path reads a currency grid cell: the DOM does
// parseFloat(text.replace(/[$,()]/g,'')), so a value shown in accounting
// parentheses (negative) is read as its positive magnitude. Mirror that with
// abs() so the keep/skip decision matches the scrape exactly.
function domNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

// Map one GetInvoiceGridDataQuery row to the fields the decision logic needs.
// - invoice === null  → no invoice yet → a "Create" row
// - invoice !== null  → an unissued invoice exists → an "Issue" row
//   (this mirrors which action button the DOM renders for the same row)
// - salesOrderBalance is null on issue rows; issue only checks total, so 0 is safe.
export function normalizeApiInvoiceRow(apiRow = {}) {
  const soRaw = apiRow.salesOrderNumber ?? apiRow.salesOrder?.name ?? "";
  const soStr = String(soRaw).trim();
  const soNumber = soStr === ""
    ? "Unknown"
    : /^so/i.test(soStr) ? soStr.toUpperCase() : `SO${soStr}`;
  const hasInvoice = apiRow.invoice != null;
  // The grid's "invoice-total" column binds to invoiceTotalV2 (the actionable/
  // pending amount), NOT invoiceTotal — confirmed by matching DOM cells to API
  // fields. For create rows V2 == the full amount; for an already-created
  // invoice V2 is 0 (nothing pending), which is exactly why the scrape skips
  // those. Use V2 so the keep/skip decision matches the browser path; fall back
  // to invoiceTotal only if V2 is absent.
  const totalSource = apiRow.invoiceTotalV2 != null ? apiRow.invoiceTotalV2 : apiRow.invoiceTotal;
  return {
    soNumber,
    salesOrderId: apiRow.salesOrder?.id || null,
    invoiceId: apiRow.invoice?.id || null,
    hasRefund: !!apiRow.hasRefund,
    balance: domNumber(apiRow.salesOrderBalance),
    total: domNumber(totalSource),
    hasCreate: !hasInvoice,
    hasIssue: hasInvoice,
    invoiceStatus: apiRow.invoiceStatus || null,
    shippingStatus: apiRow.shippingStatus || null,
  };
}

// Decide create / issue / skip for a normalized row. Skip parity is guaranteed
// by delegating the keep/skip decision to the SAME shouldProcessRow the browser
// path uses; the reason string is purely for reporting.
export function classifyInvoice(row) {
  const keep = shouldProcessRow(row.balance, row.total, row.hasRefund, row.hasCreate, row.hasIssue);
  if (keep) {
    return { soNumber: row.soNumber, action: row.hasCreate ? "create" : "issue", reason: null };
  }
  let reason;
  if (row.hasRefund) reason = "refund";
  else if (!row.hasCreate && !row.hasIssue) reason = "no-action-button";
  else if (row.hasCreate) reason = "create-needs-positive-balance-and-total";
  else reason = "issue-needs-positive-total";
  return { soNumber: row.soNumber, action: "skip", reason };
}

// Build the full work plan from a set of raw API rows.
export function planInvoiceActions(apiRows = []) {
  const create = [];
  const issue = [];
  const skip = [];
  for (const raw of apiRows) {
    const row = normalizeApiInvoiceRow(raw);
    const decision = classifyInvoice(row);
    const entry = { ...decision, balance: row.balance, total: row.total, invoiceId: row.invoiceId, salesOrderId: row.salesOrderId };
    if (decision.action === "create") create.push(entry);
    else if (decision.action === "issue") issue.push(entry);
    else skip.push(entry);
  }
  const skipByReason = skip.reduce((acc, s) => { acc[s.reason] = (acc[s.reason] || 0) + 1; return acc; }, {});
  return {
    create,
    issue,
    skip,
    counts: { total: apiRows.length, create: create.length, issue: issue.length, skip: skip.length, skipByReason },
  };
}

// Fetch the entire Needs Action list via the authenticated browser session
// (cookie auth — fetch runs in the page origin, so the session is reused).
// `page` is a logged-in Puppeteer page already on the Fulcrum origin.
export async function fetchNeedsActionInvoices(page, { take = 500, maxPages = 40 } = {}) {
  const all = [];
  let skip = 0;
  for (let i = 0; i < maxPages; i++) {
    const path = NEEDS_ACTION_GRID_PATH.replace("__SKIP__", String(skip)).replace("__TAKE__", String(take));
    const res = await page.evaluate(async (p) => {
      const r = await fetch(p, { credentials: "include", headers: { Accept: "application/json" } });
      return { status: r.status, body: await r.text() };
    }, path);
    if (res.status !== 200) {
      throw new Error(`GetInvoiceGridDataQuery returned HTTP ${res.status}`);
    }
    const json = JSON.parse(res.body);
    const batch = json.data || [];
    all.push(...batch);
    const total = typeof json.total === "number" ? json.total : all.length;
    skip += batch.length;
    if (batch.length === 0 || all.length >= total) break;
  }
  return all;
}

// Convenience: fetch + plan in one call.
export async function planNeedsActionFromApi(page, opts = {}) {
  const rows = await fetchNeedsActionInvoices(page, opts);
  return planInvoiceActions(rows);
}
