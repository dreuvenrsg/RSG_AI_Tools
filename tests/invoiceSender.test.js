import test from 'node:test';
import assert from 'node:assert/strict';

import { isCreateDetailTimeoutError, evaluateInvoicingUiHealth, shouldProcessRow } from '../fulcrumProcessor.js';
import { buildFulcrumRunOptions, buildInvocationLockMetadata, buildSummaryEmailContent, customerModule, utils, resolveAuditRange, buildAuditReportEmail, buildAuditAllClearEmail } from '../V2_emailSender.js';

test('summary email separates explicit exclusions from allowlist misses', () => {
  const results = {
    processed: 3,
    sent: 0,
    skipped: 3,
    errors: 3,
    candidatePolicySummary: {
      candidateInvoiceCount: 5,
      uniqueCustomerCount: 4,
      sendableCustomers: ['Johnson Controls Fire Protection LP'],
      explicitlyExcludedCustomers: ['HONEYWELL FIRE SYSTEMS, US', 'SIEMENS CANADA LIMITED'],
      allowlistMissCustomers: ['Summit Fire & Security'],
      sendableInvoiceCount: 2,
      explicitlyExcludedInvoiceCount: 2,
      allowlistMissInvoiceCount: 1
    },
    details: [
      {
        invoiceId: 'F1001',
        status: 'skipped',
        customer: 'SIEMENS CANADA LIMITED',
        reason: 'explicit_exclusion',
        skipCategory: 'explicit_exclusion'
      },
      {
        invoiceId: 'F1002',
        status: 'skipped',
        customer: 'HONEYWELL FIRE SYSTEMS, US',
        reason: 'explicit_exclusion',
        skipCategory: 'explicit_exclusion'
      },
      {
        invoiceId: 'F1003',
        status: 'skipped',
        customer: 'Summit Fire & Security',
        reason: 'not_in_allowlist',
        skipCategory: 'allowlist_miss'
      },
      {
        invoiceId: 'F1004',
        status: 'error',
        error: 'Customer Summit Fire & Security has no primary email defined'
      },
      {
        invoiceId: 'F1005',
        status: 'error',
        error: '{"message":"[Fulcrum] No shipments found for SO: 221986/F1005/Sales OrderId in Fulcrum:abc123"}'
      },
      {
        invoiceId: 'SYSTEM',
        status: 'error',
        error: 'Fatal system error: browser crashed'
      }
    ]
  };

  const {
    body,
    skippedCustomers,
    explicitlyExcludedCustomers,
    allowlistMissCustomers,
    emailContext
  } = buildSummaryEmailContent(results, null, {
    now: new Date('2026-04-02T12:00:00.000Z'),
    environmentLabel: 'PRODUCTION'
  });

  assert.deepEqual(skippedCustomers, [
    'HONEYWELL FIRE SYSTEMS, US',
    'SIEMENS CANADA LIMITED',
    'Summit Fire & Security'
  ]);
  assert.deepEqual(explicitlyExcludedCustomers, [
    'HONEYWELL FIRE SYSTEMS, US',
    'SIEMENS CANADA LIMITED'
  ]);
  assert.deepEqual(allowlistMissCustomers, [
    'Summit Fire & Security'
  ]);
  assert.deepEqual(emailContext.qbo.explicitlyExcludedCustomers, explicitlyExcludedCustomers);
  assert.deepEqual(emailContext.qbo.allowlistMissCustomers, allowlistMissCustomers);
  assert.equal(emailContext.qbo.candidatePolicySummary.candidateInvoiceCount, 5);
  assert.match(body, /ACTION REQUIRED/);
  assert.match(body, /Add customers to allowlist \(these invoices were skipped because the customer is not yet approved to receive invoices\)/);
  assert.match(body, /- Summit Fire & Security: F1003/);
  assert.match(body, /Add missing customer email addresses in QBO/);
  assert.match(body, /- Summit Fire & Security: F1004/);
  assert.match(body, /Review shipment issues/);
  assert.match(body, /- F1005: \[Fulcrum\] No shipments found/);
  assert.match(body, /Review unexpected system errors/);
  assert.match(body, /- SYSTEM: Fatal system error: browser crashed/);
  assert.match(body, /- Explicit exclusions honored: HONEYWELL FIRE SYSTEMS, US, SIEMENS CANADA LIMITED/);
  assert.match(body, /Run Metrics/);
  assert.match(body, /Total runtime: \d+\.\d min/);
  assert.match(body, /Fulcrum stage: \d+\.\d min/);
  assert.match(body, /QBO stage: \d+\.\d min/);
  assert.doesNotMatch(body, /The errors are:/);
});

test('summary email reports bounded Fulcrum processing', () => {
  const results = {
    processed: 0,
    sent: 0,
    skipped: 0,
    errors: 0,
    details: []
  };
  const fulcrumResults = {
    processedInvoices: [],
    errors: [],
    stoppedEarly: true,
    stopReason: 'reached Fulcrum time budget'
  };

  const { body, emailContext } = buildSummaryEmailContent(results, fulcrumResults, {
    now: new Date('2026-05-04T12:00:00.000Z'),
    environmentLabel: 'PRODUCTION'
  });

  assert.match(body, /Operational Notes/);
  assert.match(body, /Fulcrum stopped before exhausting all pages: reached Fulcrum time budget/);
  assert.equal(emailContext.fulcrum.stoppedEarly, true);
  assert.equal(emailContext.fulcrum.stopReason, 'reached Fulcrum time budget');
});

test('Fulcrum run options reserve Lambda time for QBO', () => {
  const before = Date.now();
  const options = buildFulcrumRunOptions(
    {
      fulcrumMaxActionAttempts: 10,
      fulcrumStageBudgetMs: 480000,
      qboStageReserveMs: 360000,
      lambdaSafetyBufferMs: 15000
    },
    {
      getRemainingTimeInMillis: () => 900000
    }
  );
  const after = Date.now();

  assert.equal(options.maxActionAttempts, 10);
  assert.equal(options.maxPages, 20);
  assert.equal(options.budgetMs, 480000);
  assert.equal(options.qboReserveMs, 360000);
  assert.equal(options.safetyBufferMs, 15000);
  assert.ok(options.stopAtEpochMs >= before + 480000);
  assert.ok(options.stopAtEpochMs <= after + 480000);
});

test('Fulcrum run options do not default to an action cap', () => {
  const options = buildFulcrumRunOptions(
    {},
    {
      getRemainingTimeInMillis: () => 900000
    }
  );

  assert.equal(options.maxActionAttempts, null);
  assert.equal(options.maxPages, 20);
});

test('Fulcrum run options expose a parallel worker count', () => {
  // Default: proven serial path (parallel is opt-in until validated in Lambda).
  const defaults = buildFulcrumRunOptions({}, { getRemainingTimeInMillis: () => 900000 });
  assert.equal(defaults.workerCount, 1);

  // Event override wins and must be a positive integer.
  const overridden = buildFulcrumRunOptions(
    { fulcrumWorkers: 6 },
    { getRemainingTimeInMillis: () => 900000 }
  );
  assert.equal(overridden.workerCount, 6);

  // Invalid override falls back to the default rather than 0/NaN.
  const invalid = buildFulcrumRunOptions(
    { fulcrumWorkers: 0 },
    { getRemainingTimeInMillis: () => 900000 }
  );
  assert.equal(invalid.workerCount, 1);
});

test('invocation lock metadata expires after remaining runtime plus buffer', () => {
  const metadata = buildInvocationLockMetadata(
    {
      awsRequestId: 'req-123',
      getRemainingTimeInMillis: () => 120000
    },
    {
      nowMs: 1_700_000_000_000,
      tableName: 'InvoiceLocks',
      lockName: 'invoice-run'
    }
  );

  assert.deepEqual(metadata, {
    tableName: 'InvoiceLocks',
    lockName: 'invoice-run',
    ownerId: 'req-123',
    acquiredAtEpochSeconds: 1_700_000_000,
    expiresAtEpochSeconds: 1_700_000_180
  });
});

test('Fulcrum create timeout detection matches timeout-style errors only', () => {
  assert.equal(
    isCreateDetailTimeoutError(new Error('Navigation timeout of 35000 ms exceeded')),
    true
  );
  assert.equal(
    isCreateDetailTimeoutError(new Error('Waiting failed: 30000ms exceeded')),
    true
  );
  assert.equal(
    isCreateDetailTimeoutError(new Error('Create button not found')),
    false
  );
});

test('customer skip policy distinguishes explicit exclusions from allowlist misses', () => {
  assert.deepEqual(customerModule.getSkipPolicy('Honeywell Fire Systems, US'), {
    shouldSkip: true,
    skipCategory: 'explicit_exclusion',
    reason: 'explicit_exclusion. The customer is: Honeywell Fire Systems, US'
  });

  assert.deepEqual(customerModule.getSkipPolicy('Summit Fire & Security'), {
    shouldSkip: true,
    skipCategory: 'allowlist_miss',
    reason: 'not_in_allowlist. The customer is: Summit Fire & Security'
  });

  assert.deepEqual(customerModule.getSkipPolicy('Johnson Controls Fire Protection LP'), {
    shouldSkip: false,
    skipCategory: null,
    reason: null
  });

  assert.deepEqual(customerModule.getSkipPolicy('Colec LLC'), {
    shouldSkip: false,
    skipCategory: null,
    reason: null
  });

  // Exact QBO DisplayName is allowlisted...
  assert.deepEqual(customerModule.getSkipPolicy('WORLD SECURITY & CONTROL,INC.'), {
    shouldSkip: false,
    skipCategory: null,
    reason: null
  });

  // ...but the old partial form no longer matches (exact match, not substring).
  assert.equal(customerModule.getSkipPolicy('World Security & Control').shouldSkip, true);
});

test('candidate policy summary reports sendable and skipped customer groups', () => {
  const summary = customerModule.summarizeInvoicePolicies([
    { CustomerRef: { value: '1', name: 'Honeywell Fire Systems, US' } },
    { CustomerRef: { value: '2', name: 'Summit Fire & Security' } },
    { CustomerRef: { value: '3', name: 'Johnson Controls Fire Protection LP' } },
    { CustomerRef: { value: '3', name: 'Johnson Controls Fire Protection LP' } }
  ], {
    '1': { DisplayName: 'Honeywell Fire Systems, US' },
    '2': { DisplayName: 'Summit Fire & Security' },
    '3': { DisplayName: 'Johnson Controls Fire Protection LP' }
  });

  assert.deepEqual(summary, {
    candidateInvoiceCount: 4,
    uniqueCustomerCount: 3,
    sendableCustomers: ['Johnson Controls Fire Protection LP'],
    explicitlyExcludedCustomers: ['Honeywell Fire Systems, US'],
    allowlistMissCustomers: ['Summit Fire & Security'],
    sendableInvoiceCount: 2,
    explicitlyExcludedInvoiceCount: 1,
    allowlistMissInvoiceCount: 1
  });
});

test('HLI San Diego invoices route to AP-C510', () => {
  const selection = utils.resolveInvoiceRecipients({
    invoice: {
      CustomerRef: { name: 'HLI Solutions, Inc.' },
      ShipAddr: {
        Line1: 'c/o MC Warehouse & Logistics 7707 Paseo de la Fuente',
        Line2: 'San Diego, CA 92154 USA'
      }
    },
    customer: {
      DisplayName: 'HLI Solutions, Inc.',
      PrimaryEmail: 'aphli@currentlighting.com'
    }
  });

  assert.equal(selection.recipients, 'ap-c510@currentlighting.com');
  assert.equal(selection.source, 'hli_ship_to_san_diego');
});

test('HLI Christiansburg invoices route to APHLI', () => {
  const selection = utils.resolveInvoiceRecipients({
    invoice: {
      CustomerRef: { name: 'HLI Solutions, Inc.' },
      ShipAddr: {
        Line1: '2000 Electric Way',
        Line2: 'Christiansburg, VA 24073'
      }
    },
    customer: {
      DisplayName: 'HLI Solutions, Inc.',
      PrimaryEmail: 'some-old-value@example.com'
    }
  });

  assert.equal(selection.recipients, 'aphli@currentlighting.com');
  assert.equal(selection.source, 'hli_ship_to_christiansburg');
});

test('non-HLI invoices default to normalized customer primary email set', () => {
  const selection = utils.resolveInvoiceRecipients({
    invoice: {
      CustomerRef: { name: 'Summit Fire & Security' },
      ShipAddr: {
        Line1: '123 Main St'
      }
    },
    customer: {
      DisplayName: 'Summit Fire & Security',
      PrimaryEmail: 'Ap@summitcompanies.com, apvendorinquiry@summitfire.com'
    }
  });

  assert.equal(selection.recipients, 'ap@summitcompanies.com, apvendorinquiry@summitfire.com');
  assert.equal(selection.source, 'customer_primary_email');
});

test('monthly audit resolves the previous calendar month (with year rollover + override)', () => {
  assert.deepEqual(
    resolveAuditRange({}, new Date('2026-07-01T08:00:00Z')),
    { start: '2026-06-01', end: '2026-06-30', label: 'June 2026' }
  );
  const dec = resolveAuditRange({}, new Date('2026-01-10T00:00:00Z'));
  assert.equal(dec.start, '2025-12-01');
  assert.equal(dec.end, '2025-12-31');
  assert.equal(dec.label, 'December 2025');
  assert.deepEqual(
    resolveAuditRange({ auditStart: '2026-05-01', auditEnd: '2026-05-31' }, new Date('2026-07-01T00:00:00Z')),
    { start: '2026-05-01', end: '2026-05-31', label: '2026-05-01 to 2026-05-31' }
  );
});

test('monthly audit email builders: all-clear vs report with leaks + QBO links', () => {
  const clear = buildAuditAllClearEmail('June 2026');
  assert.match(clear.subject, /all clear for June 2026/i);
  assert.match(clear.html, /All clear/i);
  assert.match(clear.html, /went to the right location/i);
  assert.match(clear.html, /Excellence/);

  const rep = buildAuditReportEmail({
    total: 1, scanned: 10, filteredResolved: 5,
    leaks: [{ doc: 'F10006', id: '215001', customer: 'SIEMENS INDUSTRY INC', sentTo: 'x@siemens.com', paid: true }],
    groups: [{ customer: 'SIEMENS INDUSTRY INC', cat: 'LEAK', explanation: 'verify', items: [{ doc: 'F10006', id: '215001', month: '2026-05' }] }]
  }, 'May 2026');
  assert.match(rep.subject, /1 leak/);
  assert.match(rep.html, /should NOT have received/);
  assert.match(rep.html, /qbo\.intuit\.com\/app\/invoice\?txnId=215001/);
  assert.match(rep.html, /already paid, shown anyway/); // paid leak is still surfaced
  assert.match(rep.html, /credit-card-paid invoices/);  // filter footnote present
});

test('allowlist matches exact QBO name (case-insensitive), not substring', () => {
  // Exact approved name -> sendable
  assert.equal(customerModule.getSkipPolicy('HOCHIKI').shouldSkip, false);
  // Case-insensitive
  assert.equal(customerModule.getSkipPolicy('hochiki').shouldSkip, false);
  assert.equal(customerModule.getSkipPolicy('Empire Fire Alarm Specialist Co., Inc').shouldSkip, false);
  assert.equal(customerModule.getSkipPolicy('  ANIXTER  ').shouldSkip, false); // trimmed

  // Over-match cases are now resolved: the OTHER entity is NOT allowlisted.
  const hochikiVes = customerModule.getSkipPolicy('HOCHIKI/VES');
  assert.equal(hochikiVes.shouldSkip, true);
  assert.equal(hochikiVes.skipCategory, 'allowlist_miss');
  assert.equal(customerModule.getSkipPolicy('ANIXTER CANADA INC.').shouldSkip, true);

  // A substring of an approved name must NOT match (the old danger).
  assert.equal(customerModule.getSkipPolicy('Potter').shouldSkip, true); // exact is "POTTER ELECTRIC"
  assert.equal(customerModule.getSkipPolicy('Some Unapproved Customer LLC').shouldSkip, true);

  // Exclusions still win and still use substring.
  const honeywell = customerModule.getSkipPolicy('HONEYWELL FIRE SYSTEMS, US');
  assert.equal(honeywell.shouldSkip, true);
  assert.equal(honeywell.skipCategory, 'explicit_exclusion');
});

test('summary email renders helpful error messages and never surfaces a bare "{}"', () => {
  const results = {
    processed: 3,
    sent: 0,
    skipped: 0,
    errors: 3,
    details: [
      {
        invoiceId: 'F10178',
        status: 'error',
        error: '[Fulcrum] Could not determine a trackingNumber: QBO Invoice Id: 223356 /QBO Invoice: F10178'
      },
      // Legacy bug payload: an Error JSON.stringify'd to "{}" must not reach the operator as "{}".
      { invoiceId: 'F10225', status: 'error', error: '{}' },
      // Error instances must be unwrapped to their message (the Fulcrum 500 timeout case).
      { invoiceId: 'F10204', status: 'error', error: new Error('Fulcrum API error: 500 - Execution Timeout Expired') }
    ]
  };

  const { body } = buildSummaryEmailContent(results, null, {
    now: new Date('2026-06-09T12:00:00.000Z'),
    environmentLabel: 'PRODUCTION'
  });

  assert.match(body, /Review other program errors/);
  assert.match(body, /Could not determine a trackingNumber/);
  assert.match(body, /Fulcrum API error: 500 - Execution Timeout Expired/);
  assert.ok(!body.includes('{}'), 'summary body must never contain a bare "{}"');
});

// ===== Fulcrum invoicing-list UI regression guard =====

const healthySnapshot = {
  kpiFilterButtonPresent: true,
  needsActionCount: 148,
  rowCount: 25,
  firstRowColumns: ['invoiceNumber', 'customerSummary-name', 'salesOrderNumber', 'salesOrderBalance', 'invoice-total', 'invoiceStatus', 'shippingStatus', 'action'],
  anyActionButton: true,
  paginatorPresent: true
};

test('evaluateInvoicingUiHealth: healthy snapshot is healthy', () => {
  const r = evaluateInvoicingUiHealth(healthySnapshot);
  assert.equal(r.healthy, true);
  assert.deepEqual(r.issues, []);
});

test('evaluateInvoicingUiHealth: genuinely empty backlog is healthy (no false alarm)', () => {
  const r = evaluateInvoicingUiHealth({
    kpiFilterButtonPresent: true,
    needsActionCount: 0,
    rowCount: 0,
    firstRowColumns: null,
    anyActionButton: false,
    paginatorPresent: true
  });
  assert.equal(r.healthy, true);
});

test('evaluateInvoicingUiHealth: KPI filter button missing is a regression', () => {
  const r = evaluateInvoicingUiHealth({ ...healthySnapshot, kpiFilterButtonPresent: false });
  assert.equal(r.healthy, false);
  assert.ok(r.issues.some(i => /KPI filter button not found/i.test(i)));
});

test('evaluateInvoicingUiHealth: count>0 but zero rows is a regression (the original failure mode)', () => {
  const r = evaluateInvoicingUiHealth({
    kpiFilterButtonPresent: true,
    needsActionCount: 148,
    rowCount: 0,
    firstRowColumns: null,
    anyActionButton: false,
    paginatorPresent: true
  });
  assert.equal(r.healthy, false);
  assert.ok(r.issues.some(i => /0 table rows matched/i.test(i)));
});

test('evaluateInvoicingUiHealth: missing expected column cells is a regression', () => {
  const r = evaluateInvoicingUiHealth({
    ...healthySnapshot,
    firstRowColumns: ['invoiceNumber', 'customerSummary-name'] // no SO/balance/total/action
  });
  assert.equal(r.healthy, false);
  assert.ok(r.issues.some(i => /missing expected columns/i.test(i)));
  assert.ok(/salesOrderNumber/.test(r.issues.join(' ')));
});

test('evaluateInvoicingUiHealth: no action button when rows present is a regression', () => {
  const r = evaluateInvoicingUiHealth({ ...healthySnapshot, anyActionButton: false });
  assert.equal(r.healthy, false);
  assert.ok(r.issues.some(i => /No Create\/Issue button/i.test(i)));
});

test('summary email raises a loud alert box + subject prefix on UI regression', () => {
  const results = { processed: 0, sent: 0, skipped: 0, errors: 0, details: [] };
  const fulcrumResults = {
    processedInvoices: [],
    errors: [],
    stoppedEarly: false,
    stopReason: null,
    uiHealthCheck: {
      healthy: false,
      issues: ['KPI reports 148 NEEDS ACTION item(s) but 0 table rows matched (.cdk-row) — row selector likely broke'],
      checks: {}
    }
  };
  const { subject, body, emailContext } = buildSummaryEmailContent(results, fulcrumResults, {
    now: new Date('2026-06-17T00:00:00Z'),
    environmentLabel: 'PRODUCTION'
  });
  assert.match(subject, /FULCRUM UI REGRESSION/);
  assert.match(body, /ALERT: FULCRUM INVOICING UI REGRESSION DETECTED/);
  assert.match(body, /0 table rows matched/);
  assert.equal(emailContext.fulcrum.uiRegression, true);
  assert.ok(emailContext.fulcrum.uiHealthIssues.length >= 1);
});

test('summary email shows no UI alert when the guard is healthy', () => {
  const results = { processed: 1, sent: 1, skipped: 0, errors: 0, details: [] };
  const fulcrumResults = {
    processedInvoices: [{ soNumber: '9291', balance: 10, total: 10, action: 'Created & Issued' }],
    errors: [],
    stoppedEarly: false,
    stopReason: null,
    uiHealthCheck: { healthy: true, issues: [], checks: {} }
  };
  const { subject, body, emailContext } = buildSummaryEmailContent(results, fulcrumResults, {
    now: new Date('2026-06-17T00:00:00Z'),
    environmentLabel: 'PRODUCTION'
  });
  assert.doesNotMatch(subject, /UI REGRESSION/);
  assert.doesNotMatch(body, /ALERT: FULCRUM INVOICING UI REGRESSION/);
  assert.equal(emailContext.fulcrum.uiRegression, false);
});

// ===== shouldProcessRow: never throws, skips non-actionable rows =====

test('shouldProcessRow: refunds are always skipped', () => {
  assert.equal(shouldProcessRow(100, 100, true, true, false), false);
  assert.equal(shouldProcessRow(0, 100, true, false, true), false);
});

test('shouldProcessRow: Create rows need positive balance AND total', () => {
  assert.equal(shouldProcessRow(100, 100, false, true, false), true);
  assert.equal(shouldProcessRow(0, 100, false, true, false), false);
  assert.equal(shouldProcessRow(100, 0, false, true, false), false);
});

test('shouldProcessRow: Issue rows need positive total', () => {
  assert.equal(shouldProcessRow(0, 100, false, false, true), true);
  assert.equal(shouldProcessRow(0, 0, false, false, true), false);
});

test('shouldProcessRow: a row with no action button is skipped, never throws (regression: SO2617 halted the stage)', () => {
  let result;
  assert.doesNotThrow(() => { result = shouldProcessRow(0, 36529.6, false, false, false); });
  assert.equal(result, false);
});
