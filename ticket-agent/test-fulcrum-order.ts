import './src/env.js';
import { findSalesOrdersByPO } from './src/fulcrum';

const FULCRUM_TOKEN = process.env.FULCRUM_TOKEN!;
const FULCRUM_API_URL = "https://api.fulcrumpro.com";

async function fulcrumRequest(method: string, endpoint: string, body?: any) {
  const url = `${FULCRUM_API_URL}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${FULCRUM_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Fulcrum API error: ${res.status} - ${txt}`);
  return txt ? JSON.parse(txt) : {};
}

async function testSortOrder() {
  console.log('='.repeat(80));
  console.log('TEST: Checking Fulcrum API default sort order');
  console.log('='.repeat(80));

  // Test 1: Default (no sort specified)
  console.log('\n--- Test 1: Default (no Sort.Field or Sort.Dir) ---');
  const default1 = await fulcrumRequest('POST', '/api/sales-orders/list?Skip=0&Take=5', {});
  console.log('\nFirst 5 orders (default):');
  default1.forEach((o: any) => {
    console.log(`  Order #${o.number} - PO: ${o.customerPoNumber} - Created: ${o.createdUtc} - Modified: ${o.modifiedUtc}`);
  });

  // Test 2: Sort by createdUtc descending (newest first)
  console.log('\n--- Test 2: Sort by createdUtc descending ---');
  const sorted = await fulcrumRequest('POST', '/api/sales-orders/list?Skip=0&Take=5&Sort.Field=createdUtc&Sort.Dir=descending', {});
  console.log('\nFirst 5 orders (sorted by createdUtc desc):');
  sorted.forEach((o: any) => {
    console.log(`  Order #${o.number} - PO: ${o.customerPoNumber} - Created: ${o.createdUtc}`);
  });

  // Test 3: Sort by number descending (highest order number = most recent)
  console.log('\n--- Test 3: Sort by number descending ---');
  const sortedByNumber = await fulcrumRequest('POST', '/api/sales-orders/list?Skip=0&Take=5&Sort.Field=number&Sort.Dir=descending', {});
  console.log('\nFirst 5 orders (sorted by number desc):');
  sortedByNumber.forEach((o: any) => {
    console.log(`  Order #${o.number} - PO: ${o.customerPoNumber} - Created: ${o.createdUtc}`);
  });

  // Test 4: Check if default matches sorted
  console.log('\n--- Comparison ---');
  const defaultFirstOrderNum = default1[0].number;
  const sortedFirstOrderNum = sortedByNumber[0].number;
  
  if (defaultFirstOrderNum === sortedFirstOrderNum) {
    console.log('✅ Default sort IS newest-first (by order number)');
  } else {
    console.log('⚠️  Default sort is NOT newest-first');
    console.log(`   Default first order: #${defaultFirstOrderNum}`);
    console.log(`   Newest order: #${sortedFirstOrderNum}`);
  }

  // Test 5: Search for PO 400203171 with sorted order
  console.log('\n--- Test 4: Search for PO 400203171 with descending sort ---');
  const result = await findSalesOrdersByPO('400203171', { maxBatches: 50, batchSize: 100 });
  console.log(`Found: ${result.length} order(s)`);
  if (result.length > 0) {
    console.log(`  Order #${result[0].number} - Created: ${result[0].createdUtc}`);
  }

  console.log('\n' + '='.repeat(80));
}

testSortOrder().catch(console.error);
