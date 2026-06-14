import { test } from "node:test";
import assert from "node:assert/strict";

import { allocateCents, allocationWeights, toCents } from "../src/lib/allocation.js";
import { toCsv } from "../src/lib/csv.js";
import { classifyOverhead, partFromDescription, parseLine, processTxn } from "../src/tools/accounting/landedCost.js";
import { summarizePayment } from "../src/tools/accounting/cashApplication.js";
import { toolDefinitions, getTool } from "../src/tools/index.js";

// ---------- allocation ----------

test("allocateCents splits proportionally and sums exactly", () => {
  const parts = allocateCents(30000, [7000, 2000, 1000]); // $300 over $70/$20/$10 lines
  assert.deepEqual(parts, [21000, 6000, 3000]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 30000);
});

test("allocateCents largest-remainder keeps exact total on awkward splits", () => {
  const parts = allocateCents(100, [1, 1, 1]); // $1.00 across 3 equal lines
  assert.equal(parts.reduce((a, b) => a + b, 0), 100);
  assert.ok(parts.every((p) => p === 33 || p === 34));
});

test("allocateCents handles zero weights via even split", () => {
  const parts = allocateCents(99, [0, 0, 0]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 99);
});

test("allocateCents handles negative totals (vendor credits)", () => {
  const parts = allocateCents(-100, [3, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0), -100);
});

test("allocationWeights selects by method", () => {
  const lines = [
    { amountCents: 9000, qty: 1 },
    { amountCents: 1000, qty: 9 },
  ];
  assert.deepEqual(allocationWeights(lines, "value"), [9000, 1000]);
  assert.deepEqual(allocationWeights(lines, "quantity"), [1, 9]);
  assert.deepEqual(allocationWeights(lines, "even"), [1, 1]);
});

// ---------- overhead classification ----------

test("classifyOverhead detects freight/tariff/fee/tax and ignores parts", () => {
  assert.equal(classifyOverhead("Shipping & Handling"), "freight");
  assert.equal(classifyOverhead("FREIGHT OUT"), "freight");
  assert.equal(classifyOverhead("Freight in"), "freight");
  assert.equal(classifyOverhead("TARIFF ADJUSTMENT"), "tariff");
  assert.equal(classifyOverhead("Customs Duty"), "tariff");
  assert.equal(classifyOverhead("Fuel charge"), "fee");
  assert.equal(classifyOverhead("Surcharge"), "fee");
  assert.equal(classifyOverhead("Minimum Lot Fee"), "fee");
  assert.equal(classifyOverhead("SALES TAX"), "tax");
  assert.equal(classifyOverhead("Tax:"), "tax");
  assert.equal(classifyOverhead("Smoke Detector SD-100"), null);
  assert.equal(classifyOverhead(""), null);
});

test("classifyOverhead excludes professional/service charges from overhead", () => {
  assert.equal(classifyOverhead("Professional Fees:Legal"), null);
  assert.equal(classifyOverhead("Engineering Consulting Fee"), null);
  assert.equal(classifyOverhead("Insurance:Medical"), null);
  assert.equal(classifyOverhead("Software subscription fee"), null);
});

// ---------- part-number extraction ----------

test("partFromDescription extracts the PART: prefix convention", () => {
  assert.equal(partFromDescription("PS-ORIG-075: O-RING #2-047 75 FKM (VITON)"), "PS-ORIG-075");
  assert.equal(partFromDescription("SRVC-PC-RMS W/O LETTERS: RMS RED POWDER COATING"), "SRVC-PC-RMS W/O LETTERS");
  assert.equal(partFromDescription("Freight in"), null);
  assert.equal(partFromDescription(""), null);
  assert.equal(partFromDescription(null), null);
});

test("parseLine: part lines keyed by description prefix, overhead detected in descriptions", () => {
  const part = parseLine({
    Amount: 538.3,
    Description: "PS-ORIG-075: O-RING #2-047 75 FKM (VITON)",
    ItemBasedExpenseLineDetail: { ItemRef: { value: "1", name: "COGS Purchasing" }, Qty: 1000 },
  });
  assert.equal(part.kind, "item");
  assert.equal(part.part, "PS-ORIG-075");
  assert.equal(part.qty, 1000);

  const tariff = parseLine({
    Amount: 11.31,
    Description: "TARIFF ADJUSTMENT: PS-ORIG-075: O-RING #2-047",
    ItemBasedExpenseLineDetail: { ItemRef: { value: "1", name: "COGS Purchasing" }, Qty: 1 },
  });
  assert.equal(tariff.kind, "overhead");
  assert.equal(tariff.category, "tariff");

  const freight = parseLine({
    Amount: 13.99,
    Description: "Shipping",
    ItemBasedExpenseLineDetail: { ItemRef: { value: "2", name: "Shop Supplies" }, Qty: 1 },
  });
  assert.equal(freight.kind, "overhead");
  assert.equal(freight.category, "freight");

  // No description: falls back to the QBO item name as the part key
  const bare = parseLine({
    Amount: 100,
    ItemBasedExpenseLineDetail: { ItemRef: { value: "3", name: "Life Safety" }, Qty: 2 },
  });
  assert.equal(bare.kind, "item");
  assert.equal(bare.part, "Life Safety");
});

// ---------- bill processing ----------

const bill = {
  DocNumber: "B-100",
  TxnDate: "2026-01-15",
  VendorRef: { name: "Acme Supply" },
  Line: [
    { Amount: 700, Description: "PANEL-X: Fire panel", ItemBasedExpenseLineDetail: { ItemRef: { value: "1", name: "COGS Purchasing" }, Qty: 7 } },
    { Amount: 300, Description: "SENSOR-Y: Smoke sensor", ItemBasedExpenseLineDetail: { ItemRef: { value: "1", name: "COGS Purchasing" }, Qty: 30 } },
    { Amount: 100, AccountBasedExpenseLineDetail: { AccountRef: { name: "Freight & Delivery" } } },
    { Amount: 50, Description: "Tariff", ItemBasedExpenseLineDetail: { ItemRef: { value: "1", name: "COGS Purchasing" }, Qty: 1 } },
    { Amount: 25, AccountBasedExpenseLineDetail: { AccountRef: { name: "Office Supplies" } } },
  ],
};

test("processTxn allocates overhead by value and tracks non-item spend", () => {
  const agg = new Map();
  const unallocated = [];
  const nonItem = [];
  processTxn(bill, { sign: 1, method: "value", agg, unallocated, nonItem });

  const panel = agg.get("PANEL-X");
  const sensor = agg.get("SENSOR-Y");
  // $100 freight split 70/30; $50 tariff split 35/15
  assert.equal(panel.directCents, 70000);
  assert.equal(panel.freightCents, 7000);
  assert.equal(panel.tariffCents, 3500);
  assert.equal(sensor.freightCents, 3000);
  assert.equal(sensor.tariffCents, 1500);
  // the tariff item line is overhead, not a part
  assert.equal(agg.size, 2);
  // office supplies is non-item spend, not allocated
  assert.equal(nonItem.length, 1);
  assert.equal(nonItem[0].amountCents, 2500);
  assert.equal(unallocated.length, 0);
});

test("processTxn routes overhead on item-less bills to unallocated", () => {
  const agg = new Map();
  const unallocated = [];
  const nonItem = [];
  processTxn(
    {
      DocNumber: "F-1",
      VendorRef: { name: "FedEx" },
      Line: [{ Amount: 80, AccountBasedExpenseLineDetail: { AccountRef: { name: "Freight" } } }],
    },
    { sign: 1, method: "value", agg, unallocated, nonItem }
  );
  assert.equal(unallocated.length, 1);
  assert.equal(unallocated[0].category, "freight");
  assert.equal(unallocated[0].amountCents, 8000);
  assert.equal(agg.size, 0);
});

test("processTxn applies vendor credits as negatives", () => {
  const agg = new Map();
  processTxn(bill, { sign: 1, method: "value", agg, unallocated: [], nonItem: [] });
  processTxn(
    {
      Line: [{ Amount: 100, Description: "PANEL-X: Fire panel return", ItemBasedExpenseLineDetail: { ItemRef: { value: "1", name: "COGS Purchasing" }, Qty: 1 } }],
    },
    { sign: -1, method: "value", agg, unallocated: [], nonItem: [] }
  );
  assert.equal(agg.get("PANEL-X").directCents, 60000);
  assert.equal(agg.get("PANEL-X").qty, 6);
});

// ---------- cash application ----------

test("summarizePayment maps linked invoices and amounts", () => {
  const payment = {
    Id: "777",
    TxnDate: "2026-05-01",
    TotalAmt: 1500,
    UnappliedAmt: 100,
    PaymentRefNum: "CHK-9921",
    CustomerRef: { name: "Johnson Controls" },
    DepositToAccountRef: { name: "Operating Checking" },
    Line: [
      { Amount: 900, LinkedTxn: [{ TxnId: "11", TxnType: "Invoice" }] },
      { Amount: 500, LinkedTxn: [{ TxnId: "12", TxnType: "Invoice" }] },
    ],
  };
  const invoices = new Map([
    ["11", { Id: "11", DocNumber: "INV-1001", TxnDate: "2026-04-01", TotalAmt: 900, Balance: 0 }],
    ["12", { Id: "12", DocNumber: "INV-1004", TxnDate: "2026-04-10", TotalAmt: 600, Balance: 100 }],
  ]);
  const s = summarizePayment(payment, invoices);
  assert.equal(s.referenceNumber, "CHK-9921");
  assert.equal(s.appliedAmount, 1400);
  assert.equal(s.unappliedAmount, 100);
  assert.equal(s.applications.length, 2);
  assert.equal(s.applications[0].docNumber, "INV-1001");
  assert.equal(s.applications[1].invoiceBalance, 100);
});

// ---------- registry / definitions ----------

test("tool definitions are valid Anthropic tool-use shapes", () => {
  const defs = toolDefinitions();
  assert.equal(defs.length, 8);
  for (const d of defs) {
    assert.match(d.name, /^[a-z0-9_]+$/);
    assert.ok(d.description.length > 20);
    assert.equal(d.input_schema.type, "object");
    assert.ok(d.input_schema.properties);
  }
  assert.ok(getTool("qbo_landed_cost_report"));
  assert.ok(getTool("qbo_cash_application_lookup"));
});

// ---------- csv ----------

test("toCsv quotes commas and quotes", () => {
  const csv = toCsv([{ a: 'He said "hi"', b: "x,y" }], [
    { key: "a", header: "a" },
    { key: "b", header: "b" },
  ]);
  assert.equal(csv, 'a,b\n"He said ""hi""","x,y"\n');
});

test("toCents rounds float money safely", () => {
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(0.1 + 0.2), 30);
});

// ---------- fulcrum ----------

import { isReadOnlyRequest } from "../src/fulcrum/client.js";
import { fitForModel } from "../src/tools/fulcrum/apiRequest.js";

test("fulcrum read-only guard allows GET and POST list, refuses mutations", () => {
  assert.equal(isReadOnlyRequest("GET", "/shipments/abc123"), true);
  assert.equal(isReadOnlyRequest("POST", "/invoices/list"), true);
  assert.equal(isReadOnlyRequest("POST", "/shipments/list?Skip=0&Take=50"), true);
  assert.equal(isReadOnlyRequest("POST", "/invoices"), false);
  assert.equal(isReadOnlyRequest("POST", "/invoices/create"), false);
  assert.equal(isReadOnlyRequest("PUT", "/shipments/abc"), false);
  assert.equal(isReadOnlyRequest("DELETE", "/shipments/abc"), false);
  assert.equal(isReadOnlyRequest("POST", "/listings"), false); // "list" must be a path segment
});

test("fitForModel passes small payloads and truncates big arrays with a note", () => {
  const small = { data: [{ a: 1 }] };
  assert.deepEqual(fitForModel(small), { payload: small, truncated: false });

  const big = Array.from({ length: 5000 }, (_, i) => ({ id: i, pad: "x".repeat(50) }));
  const { payload, truncated } = fitForModel(big);
  assert.equal(truncated, true);
  assert.ok(payload.rowsShown < 5000);
  assert.equal(payload.totalRowsReturnedByApi, 5000);
  assert.ok(JSON.stringify(payload.rows).length <= 35000);
  assert.ok(payload.note.includes("Skip/Take"));

  const bigObject = { blob: "y".repeat(100000) };
  const r2 = fitForModel(bigObject);
  assert.equal(r2.truncated, true);
  assert.ok(r2.payload.json.length <= 35000);
});

test("registry includes the fulcrum tool", () => {
  assert.ok(getTool("fulcrum_api_request"));
});
