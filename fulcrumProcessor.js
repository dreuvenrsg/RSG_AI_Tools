/**
 * Fulcrum Invoice Processor - Browser Automation for Invoice Creation
 * Runs BEFORE QBO processing to create and issue invoices in Fulcrum
 */

import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const IS_LOCAL = !process.env.AWS_LAMBDA_FUNCTION_NAME;

// Helper function to replace page.waitForTimeout (removed in Puppeteer v21+)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ========== SMART WAITING UTILITIES ==========
/**
 * Smart wait utilities to replace fixed delays with dynamic waiting
 * These functions wait for specific conditions rather than fixed time periods
 */

/**
 * Wait for page to be fully ready (no spinners, document ready, network idle)
 */
async function waitForPageReady(page, options = {}) {
  const startTime = Date.now();
  const timeout = options.timeout || config.timeouts.pageStabilization;
  const debugMode = options.debug || false;

  try {
    // Wait for multiple conditions in parallel
    await Promise.all([
      // Wait for document ready state
      page.waitForFunction(
        () => document.readyState === 'complete',
        { timeout: timeout / 2 }
      ),

      // Wait for no loading spinners (common patterns)
      page.waitForFunction(
        () => {
          const spinners = [
            '.loading', '.spinner', '.loader',
            '[class*="loading"]', '[class*="spinner"]',
            '.mat-progress-spinner', '.mat-progress-bar',
            'mat-spinner', 'mat-progress-spinner'
          ];

          for (const selector of spinners) {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
              if (el && (el.offsetParent !== null || getComputedStyle(el).display !== 'none')) {
                return false; // Still loading
              }
            }
          }
          return true; // No visible spinners
        },
        { timeout, polling: 100 }
      ),

      // Wait for Angular/Material specific readiness
      page.waitForFunction(
        () => {
          // Check if Angular is ready
          if (window.getAllAngularTestabilities) {
            const testabilities = window.getAllAngularTestabilities();
            return testabilities.every(t => t.isStable());
          }
          return true;
        },
        { timeout: timeout / 2 }
      ).catch(() => {}) // Ignore if Angular not present
    ]);

    const elapsed = Date.now() - startTime;
    if (debugMode || elapsed < 1000) {
      console.log(`[SmartWait] Page ready in ${elapsed}ms (saved ${timeout - elapsed}ms)`);
    }

  } catch (error) {
    // Fallback to small delay if smart wait fails
    console.log(`[SmartWait] Fallback triggered after ${Date.now() - startTime}ms: ${error.message}`);
    await delay(Math.min(2000, timeout / 4));
  }
}

/**
 * Wait for modal to disappear completely
 */
async function waitForModalGone(page, options = {}) {
  const startTime = Date.now();
  const timeout = options.timeout || config.timeouts.modalWait;

  try {
    await page.waitForFunction(
      () => {
        // Check for common modal patterns
        const modalSelectors = [
          '.modal', '.dialog', '.overlay',
          '[role="dialog"]', '[role="alertdialog"]',
          '.mat-dialog-container', '.cdk-overlay-container',
          '[class*="modal"]', '[class*="dialog"]'
        ];

        for (const selector of modalSelectors) {
          const modals = document.querySelectorAll(selector);
          for (const modal of modals) {
            if (modal && modal.offsetParent !== null) {
              const style = getComputedStyle(modal);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                return false; // Modal still visible
              }
            }
          }
        }

        // Check for overlay backdrops
        const overlays = document.querySelectorAll('.cdk-overlay-backdrop, .modal-backdrop');
        for (const overlay of overlays) {
          if (overlay && overlay.offsetParent !== null) {
            return false; // Overlay still visible
          }
        }

        return true; // No visible modals
      },
      { timeout, polling: 100 }
    );

    const elapsed = Date.now() - startTime;
    console.log(`[SmartWait] Modal gone in ${elapsed}ms (saved ${timeout - elapsed}ms)`);

  } catch (error) {
    console.log(`[SmartWait] Modal wait fallback after ${Date.now() - startTime}ms`);
    await delay(Math.min(2000, timeout / 4));
  }
}

/**
 * Wait for table data to stabilize (stop changing)
 */
async function waitForTableStable(page, options = {}) {
  const startTime = Date.now();
  const timeout = options.timeout || config.timeouts.elementWait;
  const stabilityDuration = options.stabilityDuration || 500; // Table unchanged for 500ms

  try {
    await page.evaluate((stabilityDuration) => {
      return new Promise((resolve, reject) => {
        let lastContent = '';
        let stableCount = 0;
        const checkInterval = 100;
        const maxChecks = 100; // 10 seconds max
        let checkCount = 0;

        const checkStability = () => {
          checkCount++;

          // Get current table content. The redesigned invoicing list renders
          // <j-table-row class="cdk-row" role="row">, so match by class/role
          // (the old `cdk-row` TAG selector no longer matches anything).
          const rows = document.querySelectorAll('.cdk-row, [role="row"], tbody tr');
          const currentContent = Array.from(rows)
            .slice(0, 10) // Check first 10 rows for efficiency
            .map(r => r.textContent?.trim() || '')
            .join('|');

          if (currentContent === lastContent && currentContent.length > 0) {
            stableCount++;
            if (stableCount * checkInterval >= stabilityDuration) {
              resolve(true); // Table is stable
              return;
            }
          } else {
            stableCount = 0;
            lastContent = currentContent;
          }

          if (checkCount >= maxChecks) {
            resolve(true); // Timeout, assume stable
          } else {
            setTimeout(checkStability, checkInterval);
          }
        };

        checkStability();
      });
    }, stabilityDuration);

    const elapsed = Date.now() - startTime;
    console.log(`[SmartWait] Table stable in ${elapsed}ms`);

  } catch (error) {
    console.log(`[SmartWait] Table stability fallback: ${error.message}`);
    await delay(1000);
  }
}

/**
 * Wait for a button to be clickable (not disabled, not loading)
 */
async function waitForButtonClickable(page, selector, options = {}) {
  const startTime = Date.now();
  const timeout = options.timeout || config.timeouts.elementWait;

  try {
    await page.waitForFunction(
      (sel) => {
        const button = document.querySelector(sel);
        if (!button) return false;

        // Check if button is enabled
        if (button.disabled || button.getAttribute('disabled') !== null) return false;
        if (button.getAttribute('aria-disabled') === 'true') return false;

        // Check if button has loading class
        const classList = button.className || '';
        if (classList.includes('loading') || classList.includes('disabled')) return false;

        // Check if button is visible
        if (button.offsetParent === null) return false;
        const style = getComputedStyle(button);
        if (style.display === 'none' || style.visibility === 'hidden') return false;

        return true;
      },
      { timeout, polling: 100 },
      selector
    );

    const elapsed = Date.now() - startTime;
    if (elapsed < 1000) {
      console.log(`[SmartWait] Button clickable in ${elapsed}ms`);
    }

  } catch (error) {
    console.log(`[SmartWait] Button wait fallback: ${error.message}`);
    await delay(500);
  }
}

/**
 * Wait for network to be idle
 */
async function waitForNetworkIdle(page, options = {}) {
  const timeout = options.timeout || 3000;
  const maxInflightRequests = options.maxInflightRequests || 2;

  try {
    await page.waitForLoadState('networkidle', { timeout });
  } catch {
    // Fallback for older Puppeteer versions
    try {
      let inflightRequests = 0;

      page.on('request', () => inflightRequests++);
      page.on('requestfinished', () => inflightRequests--);
      page.on('requestfailed', () => inflightRequests--);

      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (inflightRequests <= maxInflightRequests) {
            clearInterval(check);
            resolve();
          }
        }, 100);

        setTimeout(() => {
          clearInterval(check);
          resolve();
        }, timeout);
      });
    } catch {
      await delay(500);
    }
  }
}

/**
 * Tracks time saved by smart waiting
 */
class SmartWaitTracker {
  constructor() {
    this.totalSaved = 0;
    this.waitCounts = {};
    this.startTime = Date.now();
  }

  recordSaving(type, savedMs) {
    this.totalSaved += savedMs;
    this.waitCounts[type] = (this.waitCounts[type] || 0) + 1;
  }

  getSummary() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    return {
      totalSavedSeconds: Math.round(this.totalSaved / 1000),
      totalSavedMinutes: (this.totalSaved / 60000).toFixed(1),
      waitCounts: this.waitCounts,
      elapsedSeconds: Math.round(elapsed)
    };
  }
}

const smartWaitTracker = new SmartWaitTracker();

// ========== END SMART WAITING UTILITIES ==========

// Configuration
const config = {
  baseUrl: 'https://rsgsecurity.fulcrumpro.com',
  invoicingUrl: 'https://rsgsecurity.fulcrumpro.com/ui/invoicing',
  loginUrl: 'https://rsgsecurity.fulcrumpro.com/ui/login',

  timeouts: {
    navigation: 30000,      // Reduced from 45000 with smart waits
    elementWait: 40000,     // Reduced from 65000 with smart waits
    actionDelay: 3000,      // Reduced from 8000 with smart waits
    modalWait: 3000,        // Reduced from 8000 with smart waits
    pageStabilization: 3000 // Reduced from 8000 with smart waits
  },

  retries: {
    createDetailWait: {
      maxAttempts: 3,           // Increased attempts since we have more aggressive timeouts
      extendedDetailTimeout: 50000,  // Reduced from 70000
      extendedActionDelay: 6000,     // Reduced from 12000
      recoveryDelay: 5000            // Reduced from 15000
    }
  }
};

const DEFAULT_MAX_PAGES = 20;

function parsePositiveInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function createProcessingLimits(options = {}) {
  return {
    maxPages: parsePositiveInteger(options.maxPages) || DEFAULT_MAX_PAGES,
    maxActionAttempts: parsePositiveInteger(options.maxActionAttempts ?? options.maxProcessedInvoices),
    stopAtEpochMs: parsePositiveInteger(options.stopAtEpochMs),
    // Number of parallel browser tabs ("workers") that issue invoices concurrently.
    // 1 (default) uses the proven serial path; >1 enables the parallel worker pool.
    workerCount: parsePositiveInteger(options.workerCount) || 1
  };
}

function getProcessingStopReason(limits, state) {
  if (limits.maxActionAttempts && state.actionAttempts >= limits.maxActionAttempts) {
    return `reached Fulcrum action limit (${limits.maxActionAttempts})`;
  }

  if (limits.stopAtEpochMs && Date.now() >= limits.stopAtEpochMs) {
    return 'reached Fulcrum time budget';
  }

  return null;
}

// TTS for local development (Sheila Bot announcement)
async function playWelcomeTTS() {
  if (!IS_LOCAL) return;
  try {
    const message = "Hello, I am the Sheila Bot Invoice Processor 3000. Beginning program execution.";
    const command = process.platform === 'darwin' ? `say "${message}"` : `echo "${message}"`;
    await execAsync(command);
  } catch (error) {
    console.log('[TTS] Not available');
  }
}

// Initialize browser (headless for Lambda, visible for local)
// Initialize browser (headless for Lambda, visible for local)
async function initBrowser(headless = true) {
  console.log('[Browser] Initializing...');
  console.log('[Env] AWS_LAMBDA_FUNCTION_NAME:', process.env.AWS_LAMBDA_FUNCTION_NAME || '(local)');
  console.log('[Env] NODE_VERSION:', process.version);

  const DEFAULT_NAV_TIMEOUT = config.timeouts.navigation;
  const DEFAULT_WAIT_TIMEOUT = config.timeouts.elementWait;

  let browserConfig;

  if (IS_LOCAL) {
    browserConfig = {
      executablePath: process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : '/usr/bin/google-chrome',
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1920,1080'
      ],
      defaultViewport: { width: 1920, height: 1080 }
    };
  } else {
    const execPath = await chromium.executablePath();
    console.log('[Chromium] executablePath:', execPath || '(none)');

    browserConfig = {
      executablePath: execPath,
      // Pass boolean headless directly; don't call chromium.setHeadlessMode()
      headless, 
      args: [
        ...chromium.args,
        '--disable-dev-shm-usage',
        '--disable-features=site-per-process',
        '--no-zygote',
        '--single-process'
      ],
      defaultViewport: { width: 1920, height: 1080 }
    };
  }

  const browser = await puppeteer.launch(browserConfig);
  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(DEFAULT_NAV_TIMEOUT);
  page.setDefaultTimeout(DEFAULT_WAIT_TIMEOUT);

  // Block images/fonts in Lambda for speed
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (!IS_LOCAL && (type === 'image' || type === 'font')) {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.setViewport({ width: 1920, height: 1080 });
  console.log('[Browser] Ready');
  return { browser, page };
}

// Login to Fulcrum
async function login(page, username, password) {
  console.log('[Login] Logging in...');
  
  await page.goto(config.loginUrl, { waitUntil: 'networkidle2', timeout: config.timeouts.navigation });
  
  // Enter username
  await page.waitForSelector('input[type="email"]', { visible: true, timeout: config.timeouts.elementWait });
  await page.type('input[type="email"]', username);
  
  // Enter password
  await page.waitForSelector('input[type="password"]', { visible: true, timeout: config.timeouts.elementWait });
  await page.type('input[type="password"]', password);
  
  // Submit
  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: config.timeouts.navigation })
  ]);

  // Smart wait instead of fixed delay
  await waitForPageReady(page, { debug: true });
  smartWaitTracker.recordSaving('login', config.timeouts.actionDelay - 2000);
  console.log('[Login] Success');
}

// Navigate to invoicing page
async function goToInvoicing(page) {
  console.log('[Nav] Going to invoicing page...');
  await page.goto(config.invoicingUrl, { waitUntil: 'networkidle2', timeout: config.timeouts.navigation });

  // Smart wait for page to be ready
  await waitForPageReady(page);
  await waitForTableStable(page);
  smartWaitTracker.recordSaving('navigation', config.timeouts.actionDelay - 1000);

  await waitForInvoicingPageReady(page);
}

async function collectPageDiagnostics(page) {
  try {
    return await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      buttonCount: document.querySelectorAll('button').length,
      inputCount: document.querySelectorAll('input').length,
      rowCount: document.querySelectorAll('.cdk-row').length,
      invoiceGridPresent: !!document.querySelector('[data-testid="invoicing-grid"], invoicing-grid, invoicing-list'),
      needsActionCardPresent: !!document.querySelector('j-kpi-filter[label="Needs Action"]'),
      needsActionButtonPresent: !!document.querySelector('j-kpi-filter[label="Needs Action"] button'),
      needsActionButtonText: document.querySelector('j-kpi-filter[label="Needs Action"] button')?.textContent?.replace(/\s+/g, ' ').trim() || '',
      kpiCards: Array.from(document.querySelectorAll('j-kpi-filter')).map(card => ({
        label: card.getAttribute('label'),
        color: card.getAttribute('color'),
        text: (card.textContent || '').replace(/\s+/g, ' ').trim()
      })),
      rowSamples: Array.from(document.querySelectorAll('.cdk-row')).slice(0, 5).map(row =>
        (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 250)
      ),
      bodyTextSample: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 700)
    }));
  } catch (error) {
    return { diagnosticsError: error.message };
  }
}

async function logPageDiagnostics(page, context) {
  const diagnostics = await collectPageDiagnostics(page);
  console.log(`[Debug] ${context}: ${JSON.stringify(diagnostics)}`);
}

// ===== Invoicing-list UI regression guard =====
// Fulcrum has rebuilt the invoicing-list DOM before (the j-* component
// redesign — see specs/012). This guard runs ONCE per run, right after the
// NEEDS ACTION filter is applied, and checks that the selectors the scraper
// depends on still resolve. If they don't, the run records a regression so the
// summary email can raise a loud alert instead of the scraper silently
// processing nothing (the exact way the j-* redesign failed for days).
let uiHealthResult = null; // null = not yet checked this run

// Pure decision function over a structural snapshot of the list page.
// Exported for unit testing. Returns { healthy, issues, checks }.
export function evaluateInvoicingUiHealth(snapshot = {}) {
  const issues = [];
  const expectedColumns = ['salesOrderNumber', 'salesOrderBalance', 'invoice-total', 'action'];

  if (!snapshot.kpiFilterButtonPresent) {
    issues.push('NEEDS ACTION KPI filter button not found (selector j-kpi-filter[label="Needs Action"] button)');
  } else if (snapshot.needsActionCount === null || snapshot.needsActionCount === undefined) {
    issues.push('Could not parse the NEEDS ACTION count from the KPI button text (KPI markup changed)');
  }

  const count = snapshot.needsActionCount;
  // The exact failure mode of the last regression: the page renders but our row
  // selector matches nothing while the KPI count says there ARE items to act on.
  if (typeof count === 'number' && count > 0 && snapshot.rowCount === 0) {
    issues.push(`KPI reports ${count} NEEDS ACTION item(s) but 0 table rows matched (.cdk-row) — row selector likely broke`);
  }

  if (snapshot.rowCount > 0) {
    const cols = Array.isArray(snapshot.firstRowColumns) ? snapshot.firstRowColumns : [];
    const missing = expectedColumns.filter(c => !cols.includes(c));
    if (missing.length) {
      issues.push(`Row cells missing expected columns: ${missing.map(c => '.cdk-column-' + c).join(', ')}`);
    }
    if (!snapshot.anyActionButton) {
      issues.push('No Create/Issue button found in any row action cell (.cdk-column-action) — action button selector likely broke');
    }
    if (!snapshot.paginatorPresent) {
      issues.push('Paginator not found (selector j-paginator) — pagination may be broken');
    }
  }

  return {
    healthy: issues.length === 0,
    issues,
    checks: {
      kpiFilterButtonPresent: !!snapshot.kpiFilterButtonPresent,
      needsActionCount: count ?? null,
      rowCount: snapshot.rowCount ?? null,
      paginatorPresent: !!snapshot.paginatorPresent,
      anyActionButton: !!snapshot.anyActionButton
    }
  };
}

// Gather the structural snapshot from the live invoicing list.
async function collectInvoicingUiSnapshot(page) {
  return page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const kpiBtn = document.querySelector('j-kpi-filter[label="Needs Action"] button');
    const kpiText = kpiBtn ? norm(kpiBtn.textContent) : '';
    const m = kpiText.match(/needs action\s+([\d,]+)/i);
    const needsActionCount = m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
    const rows = Array.from(document.querySelectorAll('.cdk-row'));
    const firstRow = rows[0] || null;
    const firstRowColumns = firstRow
      ? Array.from(firstRow.querySelectorAll('[class*="cdk-column-"]'))
          .map(c => (String(c.className).match(/cdk-column-([A-Za-z-]+?)(?:\s|$)/) || [])[1])
          .filter(Boolean)
      : null;
    const anyActionButton = rows.some(r => {
      const cell = r.querySelector('.cdk-column-action') || r;
      return Array.from(cell.querySelectorAll('button')).some(b => {
        const t = norm(b.textContent);
        return t === 'Create' || t === 'Issue';
      });
    });
    return {
      kpiFilterButtonPresent: !!kpiBtn,
      needsActionCount,
      rowCount: rows.length,
      firstRowColumns,
      anyActionButton,
      paginatorPresent: !!document.querySelector('j-paginator')
    };
  });
}

// Run the health check at most once per run (guarded by the module-level flag).
function resetUiHealthCheck() { uiHealthResult = null; }
function getUiHealthResult() { return uiHealthResult; }
async function runUiHealthCheckOnce(page) {
  if (uiHealthResult !== null) return uiHealthResult;
  try {
    const snapshot = await collectInvoicingUiSnapshot(page);
    uiHealthResult = evaluateInvoicingUiHealth(snapshot);
    if (uiHealthResult.healthy) {
      console.log(`[UICheck] Invoicing list UI healthy: ${JSON.stringify(uiHealthResult.checks)}`);
    } else {
      console.error(`[UICheck] ⚠️ Invoicing list UI REGRESSION: ${JSON.stringify(uiHealthResult.issues)}`);
    }
  } catch (error) {
    uiHealthResult = {
      healthy: false,
      issues: [`UI health check could not run: ${error.message}`],
      checks: {}
    };
    console.error(`[UICheck] health check errored: ${error.message}`);
  }
  return uiHealthResult;
}

async function waitForInvoicingPageReady(page) {
  try {
    await page.waitForFunction(() => {
      const hasGrid = !!document.querySelector('[data-testid="invoicing-grid"], invoicing-grid, invoicing-list');
      const needsActionButton = document.querySelector('j-kpi-filter[label="Needs Action"] button');
      const hasSearchInput = Array.from(document.querySelectorAll('input')).some(
        input => input.placeholder && input.placeholder.includes('Search')
      );

      return (
        hasGrid &&
        hasSearchInput &&
        !!needsActionButton &&
        !!needsActionButton.textContent &&
        /needs action/i.test(needsActionButton.textContent)
      );
    }, { timeout: config.timeouts.elementWait });
  } catch (error) {
    await logPageDiagnostics(page, 'Invoicing page did not become ready');
    throw new Error(`Invoicing page did not fully render: ${error.message}`);
  }
}

async function findNeedsActionButton(page) {
  const handle = await page.evaluateHandle(() => {
    // Redesigned invoicing list: KPI filters are <j-kpi-filter label="Needs Action">
    // wrapping a <button class="juicy-kpi ...">.
    const directButton = document.querySelector('j-kpi-filter[label="Needs Action"] button');
    if (directButton) {
      return directButton;
    }

    const cards = Array.from(document.querySelectorAll('j-kpi-filter'));
    const matchingCard = cards.find(card => {
      const label = card.getAttribute('label') || '';
      const text = card.textContent || '';
      return /needs action/i.test(label) || /needs action/i.test(text);
    });

    const fallbackButton = matchingCard?.querySelector('button');
    if (fallbackButton) {
      return fallbackButton;
    }

    return null;
  });

  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    return null;
  }

  return element;
}

async function waitForNeedsActionFilterApplied(page) {
  await page.waitForFunction(() => {
    const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
    // The redesigned KPI filter button gains the `active` class when selected
    // (e.g. "juicy-kpi warning active").
    const needsActionButton = document.querySelector('j-kpi-filter[label="Needs Action"] button');
    const classSelected = !!needsActionButton && needsActionButton.classList.contains('active');

    const rows = Array.from(document.querySelectorAll('.cdk-row'));
    const rowsLookFiltered = rows.length > 0 && rows.every(row => {
      const rowText = normalize(row.textContent);
      const actionText = normalize(row.querySelector('.cdk-column-action')?.textContent);
      return rowText.includes('Unissued') && (actionText === 'Create' || actionText === 'Issue');
    });

    return classSelected || rowsLookFiltered;
  }, { timeout: config.timeouts.elementWait });
}

async function getNeedsActionFilterState(page) {
  return page.evaluate(() => {
    const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
    // Redesigned KPI filter: <j-kpi-filter label="Needs Action"><button class="juicy-kpi warning active">.
    const needsActionBtn = document.querySelector('j-kpi-filter[label="Needs Action"] button');
    const classSelected = !!needsActionBtn && (
      needsActionBtn.classList.contains('active') ||
      needsActionBtn.classList.contains('selected') ||
      needsActionBtn.getAttribute('aria-pressed') === 'true'
    );

    const rows = Array.from(document.querySelectorAll('.cdk-row'));
    const rowsLookFiltered = rows.length > 0 && rows.every(row => {
      const rowText = normalize(row.textContent);
      const actionText = normalize(row.querySelector('.cdk-column-action')?.textContent);
      return rowText.includes('Unissued') && (actionText === 'Create' || actionText === 'Issue');
    });

    return {
      isActive: classSelected || rowsLookFiltered,
      classSelected,
      rowsLookFiltered,
      rowCount: rows.length,
      needsActionText: normalize(needsActionBtn?.textContent),
      needsActionClass: needsActionBtn?.className || null
    };
  });
}

// Click the "NEEDS ACTION" button at the top
async function clickNeedsAction(page) {
  console.log('[Nav] Ensuring NEEDS ACTION filter is active...');

  await waitForInvoicingPageReady(page);

  const existingState = await getNeedsActionFilterState(page);
  if (existingState.isActive) {
    console.log(`[Nav] NEEDS ACTION already active, not clicking: ${JSON.stringify(existingState)}`);
    return;
  }

  console.log(`[Nav] NEEDS ACTION not active, clicking: ${JSON.stringify(existingState)}`);

  const needsActionButton = await findNeedsActionButton(page);
  if (!needsActionButton) {
    await logPageDiagnostics(page, 'NEEDS ACTION button not found');
    throw new Error('NEEDS ACTION button not found');
  }

  try {
    await needsActionButton.evaluate(button => {
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
    });
  } catch (error) {
    await needsActionButton.dispose();
    await logPageDiagnostics(page, 'Failed while clicking NEEDS ACTION');
    throw new Error(`Failed to click NEEDS ACTION: ${error.message}`);
  }

  await needsActionButton.dispose();

  try {
    await waitForNeedsActionFilterApplied(page);
    await verifyNeedsActionActive(page);
  } catch (_error) {
    if (!(await verifyNeedsActionActive(page))) {
      await logPageDiagnostics(page, 'NEEDS ACTION click may not have activated filter');
    }
  }

  // Smart wait for table to stabilize after filter
  await waitForTableStable(page, { stabilityDuration: 500 });
  smartWaitTracker.recordSaving('needsAction', config.timeouts.pageStabilization - 500);
  console.log('[Nav] NEEDS ACTION clicked');

  // One-time UI regression guard: with the filtered list now loaded, verify the
  // selectors the scraper depends on still resolve. Runs once per run (guarded
  // by the module-level flag); cheap no-op on later calls.
  await runUiHealthCheckOnce(page);
}

// Verify NEEDS ACTION filter is active
async function verifyNeedsActionActive(page) {
  const state = await getNeedsActionFilterState(page);

  if (!state.isActive) {
    console.log(`[Nav] WARNING: NEEDS ACTION filter may not be active: ${JSON.stringify(state)}`);
  } else {
    console.log(`[Nav] NEEDS ACTION filter verified: ${JSON.stringify(state)}`);
  }

  return state.isActive;
}

// Read paginator state from the current table view
async function getPageInfo(page) {
  return page.evaluate(() => {
    // Redesigned list uses a Material-style <j-paginator> showing a range label
    // ("1 – 25 of 152") plus nav buttons [first, prev, next, last]. There are no
    // numbered page buttons anymore, so derive page numbers from the range.
    const paginator = document.querySelector('j-paginator');
    const rangeText = paginator ? (paginator.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const match = rangeText.match(/([\d,]+)\s*[–-]\s*([\d,]+)\s+of\s+([\d,]+)/);
    const toInt = s => parseInt(String(s).replace(/,/g, ''), 10);

    let currentPageNum = 1;
    let totalPages = 1;
    if (match) {
      const start = toInt(match[1]);
      const end = toInt(match[2]);
      const total = toInt(match[3]);
      const pageSize = Math.max(1, end - start + 1);
      currentPageNum = Math.floor((start - 1) / pageSize) + 1;
      totalPages = Math.max(1, Math.ceil(total / pageSize));
    }

    // Nav buttons render in order [first, prev, next, last]; "next" is the
    // second-to-last button (also robust to a 2-button [prev, next] layout).
    const navButtons = paginator ? Array.from(paginator.querySelectorAll('button')) : [];
    const nextButton = navButtons.length >= 2 ? navButtons[navButtons.length - 2] : null;
    const isNextDisabled = !!nextButton && (
      nextButton.disabled ||
      nextButton.getAttribute('aria-disabled') === 'true' ||
      nextButton.getAttribute('disabled') !== null
    );

    return {
      totalPages,
      currentPageNum: Number.isNaN(currentPageNum) ? 1 : currentPageNum,
      hasNextButton: !!nextButton,
      isNextDisabled
    };
  });
}

// Click the paginator "next" button (second-to-last nav button). Returns true if clicked.
async function clickNextPageButton(page) {
  return page.evaluate(() => {
    const paginator = document.querySelector('j-paginator');
    const navButtons = paginator ? Array.from(paginator.querySelectorAll('button')) : [];
    const nextButton = navButtons.length >= 2 ? navButtons[navButtons.length - 2] : null;
    const disabled = !!nextButton && (
      nextButton.disabled ||
      nextButton.getAttribute('aria-disabled') === 'true' ||
      nextButton.getAttribute('disabled') !== null
    );
    if (nextButton && !disabled) {
      nextButton.click();
      return true;
    }
    return false;
  });
}

// Restore paginator to the desired page after reloading NEEDS ACTION
async function goToPage(page, targetPageNum) {
  if (!targetPageNum || targetPageNum <= 1) return;

  let pageInfo = await getPageInfo(page);
  if (pageInfo.totalPages <= 1) return;

  const desiredPage = Math.min(targetPageNum, pageInfo.totalPages);
  if (desiredPage <= pageInfo.currentPageNum) return;

  let attempts = 0;
  while (pageInfo.currentPageNum < desiredPage && attempts < desiredPage + 5) {
    const clicked = await clickNextPageButton(page);

    if (!clicked) {
      console.log(`[Pagination] Could not advance from page ${pageInfo.currentPageNum} while restoring to page ${desiredPage}`);
      return;
    }

    // Smart wait for table to stabilize after pagination
    await waitForTableStable(page, { stabilityDuration: 300 });
    smartWaitTracker.recordSaving('pagination', config.timeouts.pageStabilization - 300);
    const previousPageNum = pageInfo.currentPageNum;
    pageInfo = await getPageInfo(page);
    attempts++;

    if (pageInfo.currentPageNum <= previousPageNum) {
      console.log(`[Pagination] Page did not advance while restoring (still at ${pageInfo.currentPageNum})`);
      return;
    }
  }

  console.log(`[Pagination] Restored to page ${pageInfo.currentPageNum}/${pageInfo.totalPages}`);
}

async function returnToNeedsActionPage(page, targetPageNum) {
  await goToInvoicing(page);
  await clickNeedsAction(page);
  await goToPage(page, targetPageNum);
}

// Extract data from a row
async function extractRowData(row) {
  try {
    const data = await row.evaluate(el => {
      // Redesigned list: cells are <j-table-cell class="cdk-column-...">, so match
      // by the cdk-column-* CLASS (the old `cdk-cell` tag prefix no longer exists).
      // Get Sales Order Balance
      const balanceEl = el.querySelector('.cdk-column-salesOrderBalance');
      const balanceText = balanceEl ? balanceEl.textContent.trim() : '$0.00';
      const balance = parseFloat(balanceText.replace(/[$,()]/g, '')) || 0;

      // Get Invoice Total (negative totals render as "($436.05)")
      const totalEl = el.querySelector('.cdk-column-invoice-total');
      const totalText = totalEl ? totalEl.textContent.trim() : '$0.00';
      const total = parseFloat(totalText.replace(/[$,()]/g, '')) || 0;

      // Get Sales Order Number (link text, e.g. "SO7013"). Refunds now render as
      // "SO#### - REFUND" in this cell instead of a separate .refund-badge.
      const soCell = el.querySelector('.cdk-column-salesOrderNumber');
      const soLink = soCell ? soCell.querySelector('a') : null;
      const soNumber = soLink ? soLink.textContent.trim() : 'Unknown';
      const hasRefund = !!el.querySelector('.refund-badge') ||
        /refund/i.test(soCell ? soCell.textContent : '');

      return { balance, total, hasRefund, soNumber };
    });
    
    return data;
  } catch (error) {
    console.error('[Row] Failed to extract data:', error.message);
    return null;
  }
}

// Business logic for which invoices to process. Exported for unit testing.
// IMPORTANT: this must never throw. A row with no recognized action button
// (neither Create nor Issue — e.g. a transiently-rendered row, a $0 row in an
// odd state, or a future UI tweak) must simply be SKIPPED. Throwing here used
// to bubble up through processPage and abort the entire Fulcrum stage on a
// single weird row (observed on SO2617), so one bad row could halt the run.
export function shouldProcessRow(balance, total, hasRefund, hasCreate, hasIssue) {
  // Skip refunds
  if (hasRefund){
    return false;
  } else if (hasCreate){
    return balance > 0 && total > 0
  } else if (hasIssue){
    return total > 0
  } else {
    // No actionable button on this row — skip it rather than crashing the run.
    return false;
  }
}

function isCreateDetailTimeoutError(error) {
  return /Navigation timeout .* exceeded|Waiting failed: .* exceeded/i.test(error?.message || '');
}

async function waitForCreateDetailReady(page, timeoutMs) {
  await page.waitForFunction(() => {
    const dropdown = document.querySelector('.dropdown.actionsdrop button.dropdown-toggle');
    return !!dropdown && dropdown.offsetParent !== null;
  }, { timeout: timeoutMs });
}

async function findRowBySoNumber(page, soNumber) {
  const rows = await page.$$('.cdk-row');

  for (const row of rows) {
    const rowData = await extractRowData(row);
    if (rowData?.soNumber === soNumber) {
      return row;
    }
  }

  return null;
}

async function runCreateWorkflow(page, row, rowData, targetPageNum, detailTimeoutMs, actionDelayMs) {
  // Click the list row's "Create" button. In the redesigned list this button
  // lives in the action cell (.cdk-column-action) and no longer carries the
  // .btn-primary class, so match it by location + text.
  const clicked = await row.evaluate(el => {
    const scope = el.querySelector('.cdk-column-action') || el;
    const buttons = Array.from(scope.querySelectorAll('button'));
    const createBtn = buttons.find(btn => btn.textContent.trim() === 'Create');
    if (createBtn) {
      createBtn.click();
      return true;
    }
    return false;
  });

  if (!clicked) throw new Error('Create button not found');

  await waitForCreateDetailReady(page, detailTimeoutMs);

  // Smart wait for page ready instead of fixed delay
  await waitForPageReady(page, { timeout: actionDelayMs });
  smartWaitTracker.recordSaving('createReady', actionDelayMs - 1000);

  // Click Actions dropdown
  console.log('[Row] Clicking Actions dropdown...');
  await page.waitForSelector('.dropdown.actionsdrop button.dropdown-toggle', { visible: true, timeout: config.timeouts.elementWait });
  await waitForButtonClickable(page, '.dropdown.actionsdrop button.dropdown-toggle');
  await page.click('.dropdown.actionsdrop button.dropdown-toggle');

  // Smart wait for dropdown to open
  await page.waitForSelector('button.dropdown-item[name="Issued"]', { visible: true, timeout: 2000 }).catch(() => delay(500));
  
  // Click "Issued" in dropdown
  console.log('[Row] Clicking Issued...');
  const issuedClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button.dropdown-item'));
    const issuedBtn = buttons.find(btn => btn.getAttribute('name') === 'Issued');
    if (issuedBtn) {
      issuedBtn.click();
      return true;
    }
    return false;
  });
  
  if (!issuedClicked) throw new Error('Issued button not found in dropdown');
  
  // Wait for modal
  await page.waitForSelector('.card-footer', { visible: true, timeout: config.timeouts.elementWait });
  
  // Click "Ok" in modal
  console.log('[Row] Confirming...');
  const okClicked = await page.evaluate(() => {
    const modal = document.querySelector('.card-footer');
    if (modal) {
      const buttons = Array.from(modal.querySelectorAll('button'));
      const okBtn = buttons.find(btn => btn.textContent.trim().toLowerCase() === 'ok' && btn.classList.contains('btn-primary'));
      if (okBtn) {
        okBtn.click();
        return true;
      }
    }
    return false;
  });
  
  if (!okClicked) throw new Error('Ok button not found');

  // Smart wait for modal to close
  await waitForModalGone(page);
  smartWaitTracker.recordSaving('modalClose', config.timeouts.modalWait - 1000);
  console.log(`[Row] ✓ ${rowData.soNumber} created & issued`);
  
  await returnToNeedsActionPage(page, targetPageNum);
}

// Read which action a row currently exposes: 'Create', 'Issue', or null.
// Used during timeout recovery to tell whether a timed-out CREATE actually
// created the draft (the row then shows 'Issue') vs. still needs creating.
async function getRowAction(row) {
  try {
    return await row.evaluate(el => {
      const scope = el.querySelector('.cdk-column-action') || el;
      const texts = Array.from(scope.querySelectorAll('button')).map(b => b.textContent.trim());
      if (texts.includes('Create')) return 'Create';
      if (texts.includes('Issue')) return 'Issue';
      return null;
    });
  } catch (_error) {
    return null;
  }
}

// Process a row with "Create" button (Create → Issue workflow).
//
// Retry model (see specs/012 "Timeout / retry behavior"): timeout-style errors
// are retried up to maxAttempts with extended waits, but a retry is
// RECOVER-THEN-DECIDE, never a blind re-run — a timeout often fires AFTER the
// draft was already created, so re-running CREATE could create a duplicate
// invoice. After a timeout we return to the list, re-find the row, and act on
// its CURRENT state: gone → assume done; now an "Issue" row → finish via the
// ISSUE workflow; still a "Create" row → genuinely re-run CREATE. Non-timeout
// errors are not retried.
async function processCreate(page, row, rowData, errors, targetPageNum) {
  console.log(`[Row] Processing CREATE for ${rowData.soNumber}...`);

  const retryConfig = config.retries.createDetailWait;
  let currentRow = row;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    const detailTimeoutMs = attempt === 1
      ? config.timeouts.navigation
      : retryConfig.extendedDetailTimeout;
    const actionDelayMs = attempt === 1
      ? config.timeouts.actionDelay
      : retryConfig.extendedActionDelay;

    try {
      if (attempt > 1) {
        console.log(`[Row] Retrying CREATE for ${rowData.soNumber} with extended waits (attempt ${attempt}/${retryConfig.maxAttempts})...`);
      }

      await runCreateWorkflow(page, currentRow, rowData, targetPageNum, detailTimeoutMs, actionDelayMs);
      return true;
    } catch (error) {
      if (!isCreateDetailTimeoutError(error) || attempt >= retryConfig.maxAttempts) {
        const errorMsg = `Failed CREATE for ${rowData.soNumber}: ${error.message}`;
        console.error(`[Row] ${errorMsg}`);
        errors.push(errorMsg);

        try {
          await returnToNeedsActionPage(page, targetPageNum);
        } catch (recoveryError) {
          console.error('[Row] Recovery failed:', recoveryError.message);
        }

        return false;
      }

      console.warn(`[Row] CREATE attempt ${attempt} for ${rowData.soNumber} timed out (${error.message}). Recovering and retrying after ${retryConfig.recoveryDelay}ms...`);

      try {
        await returnToNeedsActionPage(page, targetPageNum);
        await delay(retryConfig.recoveryDelay);
        currentRow = await findRowBySoNumber(page, rowData.soNumber);

        if (!currentRow) {
          console.log(`[Row] ${rowData.soNumber} no longer appears in NEEDS ACTION after timeout recovery; assuming prior CREATE succeeded`);
          return true;
        }

        // A timed-out CREATE may have already created the draft, in which case
        // the row now shows an "Issue" button. Retrying CREATE would fail with
        // "Create button not found", so finish the job via the ISSUE workflow.
        const currentAction = await getRowAction(currentRow);
        if (currentAction === 'Issue') {
          console.log(`[Row] ${rowData.soNumber} now shows an Issue button after CREATE timeout — draft exists; completing via ISSUE workflow`);
          return await processIssue(page, currentRow, rowData, errors, targetPageNum);
        }
        if (currentAction !== 'Create') {
          console.log(`[Row] ${rowData.soNumber} has no Create/Issue action after CREATE timeout (action="${currentAction}"); assuming it completed`);
          return true;
        }
        // Still a Create row → loop continues and retries the CREATE workflow.
      } catch (recoveryError) {
        const errorMsg = `Failed CREATE for ${rowData.soNumber}: ${error.message} (retry recovery failed: ${recoveryError.message})`;
        console.error(`[Row] ${errorMsg}`);
        errors.push(errorMsg);
        return false;
      }
    }
  }

  return false;
}

// Process a row with "Issue" button (Issue only) - now with retry logic
async function processIssue(page, row, rowData, errors, targetPageNum) {
  console.log(`[Row] Processing ISSUE for ${rowData.soNumber}...`);

  const maxRetries = 3;  // Revisit a timed-out ISSUE a few times (matches CREATE)
  let currentRow = row;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[Row] Retrying ISSUE for ${rowData.soNumber} (attempt ${attempt}/${maxRetries})...`);
      }

      // Run the issue workflow
      await runIssueWorkflow(page, currentRow, rowData, targetPageNum);
      return true;

    } catch (error) {
      // Use the same broad timeout matcher as CREATE so element-wait failures
      // ("Waiting failed: …exceeded") are retried, not just navigation timeouts.
      const isTimeout = isCreateDetailTimeoutError(error);

      if (!isTimeout || attempt >= maxRetries) {
        const errorMsg = `Failed ISSUE for ${rowData.soNumber}: ${error.message}`;
        console.error(`[Row] ${errorMsg}`);
        errors.push(errorMsg);

        try {
          await returnToNeedsActionPage(page, targetPageNum);
        } catch (recoveryError) {
          console.error('[Row] Recovery failed:', recoveryError.message);
        }

        return false;
      }

      // Timeout occurred, try to recover and retry
      console.warn(`[Row] ISSUE attempt ${attempt} for ${rowData.soNumber} timed out. Recovering...`);

      try {
        await returnToNeedsActionPage(page, targetPageNum);
        await delay(2000); // Short recovery delay

        // Find the row again
        currentRow = await findRowBySoNumber(page, rowData.soNumber);

        if (!currentRow) {
          console.log(`[Row] ${rowData.soNumber} no longer appears in NEEDS ACTION; assuming ISSUE succeeded`);
          return true;
        }
      } catch (recoveryError) {
        const errorMsg = `Failed ISSUE for ${rowData.soNumber}: ${error.message} (recovery failed: ${recoveryError.message})`;
        console.error(`[Row] ${errorMsg}`);
        errors.push(errorMsg);
        return false;
      }
    }
  }

  return false;
}

// Extracted ISSUE workflow logic for cleaner retry handling
async function runIssueWorkflow(page, row, rowData, targetPageNum) {
  console.log(`[Row] Starting ISSUE workflow for ${rowData.soNumber}...`);
    
    // Click the list row's "Issue" button (action cell, no .btn-primary in the
    // redesigned list — match by location + text).
    const clicked = await row.evaluate(el => {
      const scope = el.querySelector('.cdk-column-action') || el;
      const buttons = Array.from(scope.querySelectorAll('button'));
      const issueBtn = buttons.find(btn => btn.textContent.trim() === 'Issue');
      if (issueBtn) {
        issueBtn.click();
        return true;
      }
      return false;
    });

    if (!clicked) throw new Error('Issue button not found');
    
    // Wait for detail page
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: config.timeouts.navigation });

    // Smart wait for page ready
    await waitForPageReady(page);
    smartWaitTracker.recordSaving('issueNavigation', config.timeouts.actionDelay - 1000);

    // Click Cancel button
    console.log('[Row] Clicking Cancel...');
    const cancelClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const cancelBtn = buttons.find(btn => btn.textContent.trim() === 'Cancel' && !btn.closest('.modal'));
      if (cancelBtn) {
        cancelBtn.click();
        return true;
      }
      return false;
    });
    
    if (!cancelClicked) throw new Error('Cancel button not found');

    // Smart wait for modal to appear
    await page.waitForSelector('.modal-footer', { visible: true, timeout: config.timeouts.elementWait });

    // Confirm modal (click Yes)
    console.log('[Row] Confirming...');
    
    const yesClicked = await page.evaluate(() => {
      const modal = document.querySelector('.modal-footer');
      if (modal) {
        const buttons = Array.from(modal.querySelectorAll('button'));
        const yesBtn = buttons.find(btn => btn.textContent.trim() === 'Yes' && btn.classList.contains('btn-primary'));
        if (yesBtn) {
          yesBtn.click();
          return true;
        }
      }
      return false;
    });
    
    if (!yesClicked) throw new Error('Yes button not found');

    // Smart wait for modal to close
    await waitForModalGone(page);
    smartWaitTracker.recordSaving('issueModalClose', config.timeouts.modalWait - 1000);
    console.log(`[Row] ✓ ${rowData.soNumber} issued`);
}

// Process all rows on current page using Set-based deduplication
// Re-scans page after each process to handle dynamic reordering
async function processPage(page, processedInvoices, errors, processedSOSet, limits, state) {
  console.log('[Process] Processing current page...');

  try {
    // Keep scanning current page until no unprocessed rows found
    while (true) {
      const stopReason = getProcessingStopReason(limits, state);
      if (stopReason) {
        state.stopReason = stopReason;
        console.log(`[Process] Stopping before next row: ${stopReason}`);
        return true;
      }

      const pageInfo = await getPageInfo(page);
      const currentPageNum = pageInfo.currentPageNum;

      await page.waitForSelector('.cdk-row', { visible: true, timeout: config.timeouts.elementWait });

      const rows = await page.$$('.cdk-row');
      console.log(`[Process] Found ${rows.length} rows on page`);

      if (rows.length === 0) return false;

      let foundUnprocessedRow = false;

      // Scan all rows looking for first unprocessed eligible row
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowData = await extractRowData(row);

        if (!rowData) {
          console.log(`[Process] Skipping row ${i + 1} - failed to extract data`);
          continue;
        }

        // Skip if already processed
        if (processedSOSet.has(rowData.soNumber)) {
          console.log(`[Process] Row ${i + 1}: ${rowData.soNumber} - already processed, skipping`);
          continue;
        }

        console.log(`[Process] Row ${i + 1}: ${rowData.soNumber}, $${rowData.balance} / $${rowData.total}, Refund=${rowData.hasRefund}`);

        // Check which action button the row exposes. In the redesigned list the
        // action button sits in .cdk-column-action and no longer has .btn-primary.
        const hasCreate = await row.evaluate(el => {
          const scope = el.querySelector('.cdk-column-action') || el;
          return Array.from(scope.querySelectorAll('button')).some(btn => btn.textContent.trim() === 'Create');
        });

        const hasIssue = await row.evaluate(el => {
          const scope = el.querySelector('.cdk-column-action') || el;
          return Array.from(scope.querySelectorAll('button')).some(btn => btn.textContent.trim() === 'Issue');
        });

        // Diagnostic: a non-refund row with no recognized action button is
        // unusual (transient render, odd $0 state, or an action-cell UI change).
        // Log the action-cell text so we can tell a genuine no-action row from a
        // selector miss, without halting the run.
        if (!hasCreate && !hasIssue && !rowData.hasRefund) {
          const actionCellText = await row.evaluate(el =>
            (el.querySelector('.cdk-column-action')?.textContent || '(no .cdk-column-action cell)').replace(/\s+/g, ' ').trim()
          ).catch(() => '(unreadable)');
          console.warn(`[Process] ${rowData.soNumber} has no Create/Issue action button (balance=$${rowData.balance}, total=$${rowData.total}); action cell="${actionCellText}". Skipping.`);
        }

        // Check if we should process
        if (!shouldProcessRow(rowData.balance, rowData.total, rowData.hasRefund, hasCreate, hasIssue)) {
          console.log(`[Process] Skipping ${rowData.soNumber} - validation failed`);
          // Mark as processed so we don't check again
          processedSOSet.add(rowData.soNumber);
          continue;
        }

        let success = false;
        let action = '';

        if (hasCreate) {
          state.actionAttempts++;
          success = await processCreate(page, row, rowData, errors, currentPageNum);
          action = 'Created & Issued';
        } else if (hasIssue) {
          state.actionAttempts++;
          success = await processIssue(page, row, rowData, errors, currentPageNum);
          action = 'Issued';
        } else {
          console.log(`[Process] No action button for ${rowData.soNumber}`);
          processedSOSet.add(rowData.soNumber);
          continue;
        }

        // Mark as processed regardless of success/failure
        processedSOSet.add(rowData.soNumber);

        if (success) {
          processedInvoices.push({
            soNumber: rowData.soNumber,
            balance: rowData.balance,
            total: rowData.total,
            action: action
          });
        }

        // Found and processed a row - mark flag and break to re-scan
        foundUnprocessedRow = true;
        await delay(1000);
        break; // Exit for loop to re-fetch all rows (page reordered)
      }

      // If we scanned all rows and found nothing to process, page is exhausted
      if (!foundUnprocessedRow) {
        console.log('[Process] No unprocessed rows found on this page');
        return true; // Page processed successfully
      }

      // Otherwise, loop continues and re-scans page
    }
  } catch (error) {
    console.error('[Process] Error:', error.message);
    errors.push(`Page processing error: ${error.message}`);
    return false;
  }
}

// Check for and click next page
async function checkNextPage(page) {
  try {
    const pageInfo = await getPageInfo(page);

    console.log(`[Pagination] Current page: ${pageInfo.currentPageNum}/${pageInfo.totalPages}`);

    // If we're on the last page number, we're done
    if (pageInfo.currentPageNum >= pageInfo.totalPages && pageInfo.totalPages > 0) {
      console.log('[Pagination] Reached last page (current page equals total pages)');
      return false;
    }

    // If next button is disabled, we're on the last page
    if (pageInfo.isNextDisabled) {
      console.log('[Pagination] Reached last page (next button disabled)');
      return false;
    }

    if (!pageInfo.hasNextButton) {
      console.log('[Pagination] No next button found');
      return false;
    }

    // Click the next button
    const clicked = await clickNextPageButton(page);

    if (!clicked) {
      console.log('[Pagination] Could not click next button');
      return false;
    }

    console.log('[Pagination] Clicked next page button');
    await delay(config.timeouts.pageStabilization);
    return true;
  } catch (error) {
    console.log('[Pagination] Error:', error.message);
    return false;
  }
}

// Main function - run the entire process
// ============================================================================
// Parallel worker pool (Design B): W browser tabs share one authenticated
// session and issue invoices concurrently. Invoices are URL-addressable only as
// sales-order detail pages (no invoice-issue controls there), so each worker
// drives the NEEDS ACTION list on its own tab and claims rows via a shared,
// atomically-updated claim set. Issued invoices drop off the list (reflow); the
// claim set prevents any two workers from taking the same SO.
// ============================================================================

// Create and prepare an extra tab in the existing (already authenticated) browser.
async function createWorkerPage(browser) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(config.timeouts.navigation);
  page.setDefaultTimeout(config.timeouts.elementWait);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (!IS_LOCAL && (type === 'image' || type === 'font')) req.abort();
    else req.continue();
  });
  await page.setViewport({ width: 1920, height: 1080 });
  return page;
}

// Land a tab on the NEEDS ACTION list, re-logging in if the shared session lapsed.
async function gotoNeedsAction(page, username, password) {
  await goToInvoicing(page);
  if (page.url().includes('/login')) {
    await login(page, username, password);
    await goToInvoicing(page);
  }
  await clickNeedsAction(page);
}

// Scan the current list view and ATOMICALLY claim the first actionable, unclaimed
// row. Permanently-skippable rows (refunds / failed validation) are added to the
// claim set so no worker re-examines them. Returns a claim or null (none here).
async function scanCurrentViewForClaim(page, shared) {
  await page.waitForSelector('.cdk-row', { visible: true, timeout: config.timeouts.elementWait }).catch(() => {});
  const rows = await page.$$('.cdk-row');
  for (const row of rows) {
    const rowData = await extractRowData(row);
    if (!rowData || rowData.soNumber === 'Unknown') continue;
    if (shared.claimedSet.has(rowData.soNumber)) continue;

    const hasCreate = await row.evaluate(el => {
      const scope = el.querySelector('.cdk-column-action') || el;
      return Array.from(scope.querySelectorAll('button')).some(b => b.textContent.trim() === 'Create');
    });
    const hasIssue = await row.evaluate(el => {
      const scope = el.querySelector('.cdk-column-action') || el;
      return Array.from(scope.querySelectorAll('button')).some(b => b.textContent.trim() === 'Issue');
    });

    if (!hasCreate && !hasIssue) { shared.claimedSet.add(rowData.soNumber); continue; }
    if (!shouldProcessRow(rowData.balance, rowData.total, rowData.hasRefund, hasCreate, hasIssue)) {
      shared.claimedSet.add(rowData.soNumber); // permanent skip — stays on the list, never actionable
      continue;
    }

    // Atomic claim: no `await` between the membership check and the add, so in
    // single-threaded JS exactly one worker can win a given SO.
    if (shared.claimedSet.has(rowData.soNumber)) continue;
    shared.claimedSet.add(rowData.soNumber);

    const pageNum = (await getPageInfo(page)).currentPageNum;
    return { row, rowData, hasCreate, pageNum };
  }
  return null;
}

// Sweep from the current view forward through pages until a claim is found or the
// last page is reached.
async function findClaimForward(page, shared) {
  while (true) {
    if (getProcessingStopReason(shared.limits, shared.state)) return null;
    const claim = await scanCurrentViewForClaim(page, shared);
    if (claim) return claim;
    const moved = await checkNextPage(page);
    if (!moved) return null;
  }
}

async function runFulcrumWorker(workerId, page, shared, username, password) {
  console.log(`[Worker ${workerId}] started`);
  let consecutiveNavFailures = 0;
  while (true) {
    const stop = getProcessingStopReason(shared.limits, shared.state);
    if (stop) { if (!shared.state.stopReason) shared.state.stopReason = stop; break; }

    // Find + claim the next row. Navigation/scan errors here must NOT reject the
    // whole pool (Promise.all) — recover this tab and retry; give up only after
    // repeated failures so one wedged tab can't spin forever.
    let claim;
    try {
      // Try the current view forward first (cheap — no reload after a CREATE, which
      // already returns this tab to the list). If that sweep is empty, reset to page
      // 1 and sweep fully before concluding there is nothing to do.
      claim = await findClaimForward(page, shared);
      if (!claim) {
        await gotoNeedsAction(page, username, password);
        claim = await findClaimForward(page, shared);
      }
      consecutiveNavFailures = 0;
    } catch (navErr) {
      consecutiveNavFailures++;
      console.error(`[Worker ${workerId}] navigation/scan error (${consecutiveNavFailures}/3): ${navErr.message}`);
      if (consecutiveNavFailures >= 3) {
        shared.errors.push(`Worker ${workerId} aborted after repeated navigation errors: ${navErr.message}`);
        break;
      }
      try { await gotoNeedsAction(page, username, password); } catch (_) { /* retry next loop */ }
      await delay(1500);
      continue;
    }

    if (!claim) {
      if (shared.activeClaims > 0) {
        // Other workers are still issuing; the list will shrink. Wait, refresh, retry.
        await delay(1500);
        try { await gotoNeedsAction(page, username, password); } catch (_) { /* retry next loop */ }
        continue;
      }
      console.log(`[Worker ${workerId}] no claimable rows and no active work — done`);
      break;
    }

    shared.activeClaims++;
    shared.state.actionAttempts++;
    try {
      const ok = claim.hasCreate
        ? await processCreate(page, claim.row, claim.rowData, shared.errors, claim.pageNum)
        : await processIssue(page, claim.row, claim.rowData, shared.errors, claim.pageNum);
      if (ok) {
        shared.processedInvoices.push({
          soNumber: claim.rowData.soNumber,
          balance: claim.rowData.balance,
          total: claim.rowData.total,
          action: claim.hasCreate ? 'Created & Issued' : 'Issued',
          worker: workerId
        });
      }
    } catch (e) {
      console.error(`[Worker ${workerId}] failed ${claim.rowData.soNumber}: ${e.message}`);
      shared.errors.push(`Worker ${workerId} failed ${claim.rowData.soNumber}: ${e.message}`);
      try { await gotoNeedsAction(page, username, password); } catch (_) { /* recover next loop */ }
    } finally {
      shared.activeClaims--;
    }
  }
  console.log(`[Worker ${workerId}] exiting (processed via this tab so far)`);
}

// Orchestrate W workers across W tabs sharing one browser session.
async function runWorkerPool(browser, firstPage, username, password, shared) {
  const workerCount = shared.limits.workerCount;
  console.log(`[Main] Parallel mode: ${workerCount} workers`);

  const pages = [firstPage];
  for (let i = 1; i < workerCount; i++) {
    pages.push(await createWorkerPage(browser));
  }

  // Bring every tab to the NEEDS ACTION list concurrently (shared cookies authenticate
  // the new tabs). Doing this sequentially would burn a big chunk of the time budget on
  // setup before any invoice is issued.
  await Promise.all(pages.map(p => gotoNeedsAction(p, username, password)));

  await Promise.all(pages.map((p, i) => runFulcrumWorker(i, p, shared, username, password)));
}

export async function runFulcrumProcessor(username, password, headless = true, options = {}) {
  const processedInvoices = [];
  const errors = [];
  const processedSOSet = new Set(); // Track processed SO numbers to prevent duplicates
  const limits = createProcessingLimits(options);
  resetUiHealthCheck(); // clear the once-per-run UI regression guard
  const state = {
    actionAttempts: 0,
    stopReason: null
  };
  let browser = null;
  let pageCount = 0;
  let hasMorePages = true;
  
  try {
    console.log('\n=== FULCRUM INVOICE PROCESSOR ===\n');
    console.log('[Config] Fulcrum processing limits:', JSON.stringify({
      maxPages: limits.maxPages,
      maxActionAttempts: limits.maxActionAttempts,
      stopAtEpochMs: limits.stopAtEpochMs
    }));
    
    // TTS welcome (local only)
    if (IS_LOCAL) await playWelcomeTTS();
    
    // Initialize browser
    const browserData = await initBrowser(headless);
    browser = browserData.browser;
    const page = browserData.page;
    
    // Login
    await login(page, username, password);

    if (limits.workerCount > 1) {
      // ---- Parallel worker pool ----
      const shared = {
        processedInvoices,
        errors,
        claimedSet: processedSOSet, // reuse the dedup set as the shared claim set
        state,
        limits,
        activeClaims: 0
      };
      await runWorkerPool(browser, page, username, password, shared);
      // Workers exit either because the queue drained (no stopReason) or the budget
      // was hit. Draining means no more pages remain.
      if (!state.stopReason) hasMorePages = false;
    } else {
      // ---- Serial path (proven, single tab) ----
      // Navigate to invoicing
      await goToInvoicing(page);

      // Click NEEDS ACTION
      await clickNeedsAction(page);

      // Process all pages
      while (hasMorePages && pageCount < limits.maxPages && !state.stopReason) {
        pageCount++;
        console.log(`\n[Main] Processing page ${pageCount}...\n`);

        const pageProcessed = await processPage(page, processedInvoices, errors, processedSOSet, limits, state);

        if (!pageProcessed) {
          console.log('[Main] Page processing failed, stopping');
          break;
        }

        if (state.stopReason) {
          console.log(`[Main] Fulcrum processing stopped early: ${state.stopReason}`);
          break;
        }

        hasMorePages = await checkNextPage(page);
      }

      if (pageCount >= limits.maxPages && hasMorePages && !state.stopReason) {
        state.stopReason = `hit page limit safety check (${limits.maxPages} pages)`;
        console.log(`[Main] WARNING: ${state.stopReason}`);
      }
    }

    console.log('\n=== FULCRUM COMPLETE ===');
    console.log(`Processed: ${processedInvoices.length}`);
    console.log(`Action attempts: ${state.actionAttempts}`);
    if (state.stopReason) {
      console.log(`Stopped early: ${state.stopReason}`);
    }
    console.log(`Errors: ${errors.length}\n`);
    
    return {
      processedInvoices,
      errors,
      success: errors.length === 0,
      complete: !state.stopReason && !hasMorePages,
      stoppedEarly: !!state.stopReason,
      stopReason: state.stopReason,
      actionAttempts: state.actionAttempts,
      pagesVisited: pageCount,
      uiHealthCheck: getUiHealthResult()
    };

  } catch (error) {
    console.error('\n[Main] FATAL ERROR:', error.message);
    errors.push(`Fatal error: ${error.message}`);
    
    return {
      processedInvoices,
      errors,
      success: false,
      complete: false,
      stoppedEarly: !!state.stopReason,
      stopReason: state.stopReason,
      actionAttempts: state.actionAttempts,
      pagesVisited: pageCount,
      uiHealthCheck: getUiHealthResult()
    };

  } finally {
    // Report smart wait savings
    const smartWaitSummary = smartWaitTracker.getSummary();
    if (smartWaitSummary.totalSavedSeconds > 0) {
      console.log('[SmartWait] === PERFORMANCE SUMMARY ===');
      console.log(`[SmartWait] Total time saved: ${smartWaitSummary.totalSavedMinutes} minutes (${smartWaitSummary.totalSavedSeconds} seconds)`);
      console.log(`[SmartWait] Wait counts:`, smartWaitSummary.waitCounts);
      console.log(`[SmartWait] Total elapsed: ${smartWaitSummary.elapsedSeconds} seconds`);
      console.log('[SmartWait] =========================');
    }

    if (browser) {
      await browser.close();
      console.log('[Browser] Closed');
    }
  }
}

export default { runFulcrumProcessor };
export { isCreateDetailTimeoutError };
// Internal helpers exported for the parallel-worker refactor + live investigation tooling.
export { initBrowser, login, goToInvoicing, clickNeedsAction, extractRowData, config };
