// Integration test for fuzzy PO matching with real Fulcrum data
import './src/env.js';
import { findSalesOrdersByPO } from './src/fulcrum';
import { trackOrder } from './src/order-tracking';

console.log('='.repeat(80));
console.log('FUZZY PO MATCHING - FULCRUM INTEGRATION TEST');
console.log('='.repeat(80));

async function testFuzzySearch() {
  // Test with PO 400203171 using various formats
  const testFormats = [
    '400203171',           // Plain
    'PO 400203171',        // With prefix and space
    'PO-400203171',        // With prefix and dash
    '400203171-XP',        // With suffix
    'PO 400203171-XP',     // Both prefix and suffix
    '400 203 171',         // With spaces
  ];

  console.log('\n--- Testing findSalesOrdersByPO() with various formats ---\n');

  for (const format of testFormats) {
    console.log(`\nSearching for: "${format}"`);
    console.log('-'.repeat(60));

    try {
      const startTime = Date.now();
      const results = await findSalesOrdersByPO(format, { maxBatches: 10, batchSize: 100 });
      const elapsed = Date.now() - startTime;

      if (results.length > 0) {
        console.log(`✓ FOUND ${results.length} order(s) in ${elapsed}ms`);
        results.forEach(order => {
          console.log(`  - Order #${order.number}`);
          console.log(`    Customer PO: "${order.customerPoNumber}"`);
          console.log(`    Created: ${order.createdUtc}`);
        });
      } else {
        console.log(`✗ No orders found in ${elapsed}ms`);
      }
    } catch (error: any) {
      console.log(`✗ ERROR: ${error.message}`);
    }
  }

  console.log('\n\n--- Testing trackOrder() with various formats ---\n');

  for (const format of testFormats) {
    console.log(`\nTracking: "${format}"`);
    console.log('-'.repeat(60));

    try {
      const startTime = Date.now();
      const result = await trackOrder(format);
      const elapsed = Date.now() - startTime;

      if (result.status === 'NOT_FOUND') {
        console.log(`✗ NOT_FOUND in ${elapsed}ms`);
      } else {
        console.log(`✓ ${result.status} in ${elapsed}ms`);
        console.log(`  Sales Order: #${result.salesOrder.number}`);
        console.log(`  Customer PO: "${result.salesOrder.customerPoNumber}"`);
        console.log(`  Shipped Shipments: ${result.shippedShipments.length}`);
        console.log(`  Pending Shipments: ${result.pendingShipments.length}`);
        if (result.trackingInfo.length > 0) {
          console.log(`  Tracking Numbers: ${result.trackingInfo.map(t => t.trackingNumber).join(', ')}`);
        }
      }
    } catch (error: any) {
      console.log(`✗ ERROR: ${error.message}`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('INTEGRATION TEST COMPLETE');
  console.log('='.repeat(80));
}

testFuzzySearch().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
