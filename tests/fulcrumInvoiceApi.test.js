import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeApiInvoiceRow, classifyInvoice, planInvoiceActions } from '../fulcrumInvoiceApi.js';

// API row shapes mirror real GetInvoiceGridDataQuery rows observed 2026-06-17.
// The grid "invoice-total" column binds to invoiceTotalV2 (not invoiceTotal).
const refundRow = { salesOrderNumber: 7013, salesOrder: { id: 'so1', name: '7013' }, invoice: null, hasRefund: true, invoiceStatus: 'New', salesOrderBalance: 0, invoiceTotal: 536.2, invoiceTotalV2: 536.2 };
const createRow = { salesOrderNumber: 9756, salesOrder: { id: 'so2', name: '9756' }, invoice: null, hasRefund: false, invoiceStatus: 'New', salesOrderBalance: 127.96, invoiceTotal: 127.96, invoiceTotalV2: 127.96 };
const issueRow  = { salesOrderNumber: 9760, salesOrder: { id: 'so3', name: '9760' }, invoice: { id: 'inv3' }, hasRefund: false, invoiceStatus: 'New', salesOrderBalance: null, invoiceTotal: 91.6, invoiceTotalV2: 91.6 };

test('normalizeApiInvoiceRow: create row (invoice null) maps to hasCreate; total from V2', () => {
  const r = normalizeApiInvoiceRow(createRow);
  assert.equal(r.soNumber, 'SO9756');
  assert.equal(r.hasCreate, true);
  assert.equal(r.hasIssue, false);
  assert.equal(r.balance, 127.96);
  assert.equal(r.total, 127.96);
  assert.equal(r.hasRefund, false);
});

test('normalizeApiInvoiceRow: issue row (invoice present) maps to hasIssue; null balance → 0', () => {
  const r = normalizeApiInvoiceRow(issueRow);
  assert.equal(r.soNumber, 'SO9760');
  assert.equal(r.hasCreate, false);
  assert.equal(r.hasIssue, true);
  assert.equal(r.balance, 0); // null salesOrderBalance coerced to 0
  assert.equal(r.total, 91.6);
  assert.equal(r.invoiceId, 'inv3');
});

test('normalizeApiInvoiceRow: total comes from invoiceTotalV2, not invoiceTotal (the parity bug)', () => {
  // Real already-created invoice: V2=0 (nothing pending) but invoiceTotal>0.
  // The DOM shows $0.00 and skips it; we must too.
  const r = normalizeApiInvoiceRow({ ...issueRow, invoiceTotalV2: 0, invoiceTotal: 91.6 });
  assert.equal(r.total, 0);
});

test('normalizeApiInvoiceRow: negative V2 (accounting parens) read as positive magnitude, matching the DOM', () => {
  const r = normalizeApiInvoiceRow({ ...issueRow, invoiceTotalV2: -41.03 });
  assert.equal(r.total, 41.03);
});

test('normalizeApiInvoiceRow: already-SO-prefixed and string SO numbers handled', () => {
  assert.equal(normalizeApiInvoiceRow({ salesOrderNumber: 'SO123', invoice: null }).soNumber, 'SO123');
  assert.equal(normalizeApiInvoiceRow({ salesOrder: { name: '456' }, invoice: null }).soNumber, 'SO456');
  assert.equal(normalizeApiInvoiceRow({ invoice: null }).soNumber, 'Unknown');
});

// ---- skip parity: same rules as the browser shouldProcessRow path ----

test('classifyInvoice: refunds are skipped', () => {
  assert.deepEqual(classifyInvoice(normalizeApiInvoiceRow(refundRow)), { soNumber: 'SO7013', action: 'skip', reason: 'refund' });
});

test('classifyInvoice: create with positive balance & total → create', () => {
  assert.equal(classifyInvoice(normalizeApiInvoiceRow(createRow)).action, 'create');
});

test('classifyInvoice: create with zero balance or zero total → skip', () => {
  assert.equal(classifyInvoice(normalizeApiInvoiceRow({ ...createRow, salesOrderBalance: 0 })).action, 'skip');
  assert.equal(classifyInvoice(normalizeApiInvoiceRow({ ...createRow, invoiceTotalV2: 0 })).action, 'skip');
});

test('classifyInvoice: issue with positive total → issue; zero V2 total → skip', () => {
  assert.equal(classifyInvoice(normalizeApiInvoiceRow(issueRow)).action, 'issue');
  assert.equal(classifyInvoice(normalizeApiInvoiceRow({ ...issueRow, invoiceTotalV2: 0 })).action, 'skip');
});

test('planInvoiceActions: buckets and counts a mixed set with refund/zero skips', () => {
  const rows = [
    refundRow,                                                              // skip: refund
    createRow,                                                              // create
    issueRow,                                                               // issue
    { ...createRow, salesOrderNumber: 5197, hasRefund: true, salesOrderBalance: 0, invoiceTotalV2: 0 }, // skip: refund
    { ...createRow, salesOrderNumber: 8000, invoiceTotalV2: 0 },            // skip: create zero total
    { ...issueRow,  salesOrderNumber: 8001, invoiceTotalV2: 0 },            // skip: issue zero total (already issued)
  ];
  const plan = planInvoiceActions(rows);
  assert.equal(plan.counts.total, 6);
  assert.equal(plan.counts.create, 1);
  assert.equal(plan.counts.issue, 1);
  assert.equal(plan.counts.skip, 4);
  assert.equal(plan.counts.skipByReason.refund, 2);
  assert.equal(plan.counts.skipByReason['create-needs-positive-balance-and-total'], 1);
  assert.equal(plan.counts.skipByReason['issue-needs-positive-total'], 1);
});
