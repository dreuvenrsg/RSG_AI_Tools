// test-pdf-classification.ts
// Simple test script to verify PDF classification logic

import './src/env.js';
import { getTicketPdfUrl } from './src/zendesk';
import { MultiplePurchaseOrdersError, NoPurchaseOrderFoundError } from './src/types';

/**
 * Test the PDF classification logic with a real ticket
 *
 * Usage:
 *   npx tsx test-pdf-classification.ts <ticketId>
 *
 * Examples:
 *   npx tsx test-pdf-classification.ts 26154
 */
async function testPdfClassification() {
  const ticketId = parseInt(process.argv[2]);

  if (!ticketId || isNaN(ticketId)) {
    console.error('Usage: npx tsx test-pdf-classification.ts <ticketId>');
    console.error('Example: npx tsx test-pdf-classification.ts 26154');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing PDF Classification for Ticket #${ticketId}`);
  console.log('='.repeat(60));

  try {
    const pdfUrl = await getTicketPdfUrl(ticketId);

    if (!pdfUrl) {
      console.log('\n❌ Result: No PDF found');
      console.log('The ticket has no PDF attachments.');
    } else {
      console.log('\n✅ Result: Single PO found');
      console.log(`PDF URL: ${pdfUrl}`);
    }
  } catch (error: any) {
    if (error instanceof MultiplePurchaseOrdersError) {
      console.log('\n⚠️  Result: Multiple Purchase Orders Detected');
      console.log(`Count: ${error.count} POs`);
      console.log('\nPurchase Orders:');
      error.filenames.forEach((filename, idx) => {
        const poNum = error.poNumbers[idx];
        console.log(`  ${idx + 1}. ${filename}${poNum ? ` (PO #${poNum})` : ''}`);
      });
      console.log('\n📋 Tags that will be added:');
      console.log('  - AI_ALERT_HUMAN_REVIEW_REQUIRED');
      console.log('  - multiple_pos_detected');
      console.log('\n🚨 Action Required: Human review needed to determine which PO to process');
    } else if (error instanceof NoPurchaseOrderFoundError) {
      console.log('\n⚠️  Result: No Purchase Order Found');
      console.log(`Total PDFs: ${error.pdfCount}`);
      console.log('\nAttachments:');
      error.filenames.forEach((filename, idx) => {
        console.log(`  ${idx + 1}. ${filename}`);
      });
      console.log('\n🚨 Action Required: Human review needed - no POs identified among PDFs');
    } else {
      console.log('\n❌ Error:');
      console.error(error.message);
      if (error.stack) {
        console.error('\nStack trace:');
        console.error(error.stack);
      }
    }
  }

  console.log('\n' + '='.repeat(60) + '\n');
}

testPdfClassification().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
