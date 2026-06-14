import './src/env.js';
import { findSalesOrdersByPO } from './src/fulcrum';

async function testSortedSearch() {
  console.log('='.repeat(80));
  console.log('TEST: Search performance with newest-first sort');
  console.log('='.repeat(80));

  // Test 1: Search for a recent PO (should be found quickly)
  console.log('\n--- Test 1: Recent PO (400315315 - created today) ---');
  const start1 = Date.now();
  const result1 = await findSalesOrdersByPO('400315315', { maxBatches: 10, batchSize: 100 });
  const time1 = Date.now() - start1;
  console.log(`\nResult: ${result1.length} order(s) found in ${time1}ms`);
  if (result1.length > 0) {
    console.log(`  Order #${result1[0].number} - Created: ${result1[0].createdUtc}`);
  }

  // Test 2: Search for the old PO (400203171 - from October)
  console.log('\n--- Test 2: Old PO (400203171 - from October) ---');
  const start2 = Date.now();
  const result2 = await findSalesOrdersByPO('400203171', { maxBatches: 100, batchSize: 100 });
  const time2 = Date.now() - start2;
  console.log(`\nResult: ${result2.length} order(s) found in ${time2}ms`);
  if (result2.length > 0) {
    console.log(`  Order #${result2[0].number} - Created: ${result2[0].createdUtc}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('PERFORMANCE COMPARISON:');
  console.log(`  Recent PO: ${time1}ms`);
  console.log(`  Old PO: ${time2}ms`);
  console.log('='.repeat(80));
}

testSortedSearch().catch(console.error);
