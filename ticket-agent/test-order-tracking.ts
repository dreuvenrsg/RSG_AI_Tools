// Test script for ORDER_TRACKING functionality
// Run with: npx tsx test-order-tracking.ts

import * as dotenv from 'dotenv';
dotenv.config();

import { trackOrder, formatDateForCustomer } from './src/order-tracking';
import { generateTrackingResponse } from './src/response-generation';
import type { TicketContext, IntentClassification, TicketUser } from './src/types';

async function testOrderTracking() {
  console.log('='.repeat(80));
  console.log('TESTING ORDER TRACKING IMPLEMENTATION');
  console.log('='.repeat(80));

  // Test PO number from our earlier tests
  const testPoNumber = '1234';

  console.log(`\n--- Test 1: Track Order for PO "${testPoNumber}" ---`);
  try {
    const result = await trackOrder(testPoNumber);

    console.log('\nTracking Result:');
    console.log(`  Status: ${result.status}`);
    console.log(`  Sales Order: #${result.salesOrder?.number || 'N/A'}`);
    console.log(`  Total Shipments: ${result.shipments.length}`);
    console.log(`  Shipped: ${result.shippedShipments.length}`);
    console.log(`  Pending: ${result.pendingShipments.length}`);
    console.log(`  Scheduled Delivery: ${formatDateForCustomer(result.scheduledDeliveryDate)}`);

    console.log('\nTracking Info:');
    result.trackingInfo.forEach((info, idx) => {
      console.log(`\n  [${idx + 1}] ${info.shipmentName}`);
      console.log(`      Tracking: ${info.trackingNumber || 'N/A'}`);
      console.log(`      URL: ${info.trackingUrl || 'N/A'}`);
      console.log(`      Carrier: ${info.carrier || 'N/A'}`);
      console.log(`      Method: ${info.shippingMethod || 'N/A'}`);
      console.log(`      Shipped: ${formatDateForCustomer(info.shippedDate)}`);
    });

    // Test AI response generation
    if (result.status !== 'NOT_FOUND') {
      console.log('\n\n--- Test 2: Generate AI Response ---');

      // Mock ticket context
      const mockTicketContext: TicketContext = {
        ticketId: 12345,
        subject: 'Tracking for PO 1234',
        description: 'Can you provide tracking information for our PO 1234?',
        status: 'open',
        priority: 'normal',
        requester: {
          id: 1,
          name: 'John Doe',
          email: 'john@example.com'
        } as TicketUser,
        submitter: {
          id: 1,
          name: 'John Doe',
          email: 'john@example.com'
        } as TicketUser,
        comments: [],
        latestPublicComment: {
          id: 1,
          type: 'Comment',
          author_id: 1,
          body: 'Can you provide tracking information for our PO 1234?',
          public: true,
          created_at: new Date().toISOString(),
          attachments: []
        },
        privateNotes: [],
        customFields: [],
        tags: []
      };

      const mockIntent: IntentClassification = {
        intent: 'ORDER_TRACKING',
        confidence: 0.95,
        reasoning: 'Customer asking about order tracking',
        keyEntities: {
          poNumber: testPoNumber,
          orderNumber: undefined,
          productSkus: [],
          urgencyLevel: 'medium'
        }
      };

      const response = await generateTrackingResponse(
        mockTicketContext,
        result,
        mockIntent,
        'John'
      );

      console.log('\nAI Response:');
      console.log('─'.repeat(80));
      console.log(response.publicResponse);
      console.log('─'.repeat(80));
      console.log(`\nConfidence: ${response.confidence}`);
      console.log(`Reasoning: ${response.reasoning}`);
    }

  } catch (error) {
    console.error('Error during test:', error);
  }

  // Test with non-existent PO
  console.log('\n\n--- Test 3: Track Non-Existent PO ---');
  try {
    const result = await trackOrder('NONEXISTENT-PO-999');
    console.log(`Status: ${result.status}`);
    console.log('Expected: NOT_FOUND');
  } catch (error) {
    console.error('Error:', error);
  }

  console.log('\n\n' + '='.repeat(80));
  console.log('TEST COMPLETE');
  console.log('='.repeat(80));
}

testOrderTracking().catch(console.error);
