// src/routing.ts
// Intent routing and handler functions

import type { TicketAttachment, TicketContext, IntentClassification, ProcessingResult, ParsedPO, TrackingResult } from "./types";
import { MultiplePurchaseOrdersError, NoPurchaseOrderFoundError } from "./types";
import { attachFileToTicket, getTicketPdfUrl, getRequesterFirstName } from "./zendesk";
import { analyzePdfAndBuildPO } from "./openai";
import { fetchFulcrumData } from "./s3";
import { enrichWithFulcrumAndAI } from "./matching";
import { updateTicketWithPO } from "./zendesk";
import { notifyFailure, sendAlertEmail } from "./ses";
import { trackOrder } from "./order-tracking";
import { generateTrackingResponse, generateMultiTrackingResponse } from "./response-generation";
import { enrichOpenOrderReport, findOpenOrderReportAttachment, parseOpenOrderReportAttachment } from "./open-order-report";

/**
 * Wrapper around existing PO processing logic
 * Keeps existing code clean but integrates with new architecture
 */
export async function processPurchaseOrderWrapper(
  ticketContext: TicketContext,
  intent: IntentClassification
): Promise<ProcessingResult> {
  let pdfUrl: string | null = null;

  try {
    // Find PDF attachment (handles single PDF fast path and multi-PDF classification)
    pdfUrl = await getTicketPdfUrl(ticketContext.ticketId);
  } catch (error: any) {
    // Handle multiple purchase orders error
    if (error instanceof MultiplePurchaseOrdersError) {
      const poList = error.filenames.map((filename, idx) => {
        const poNum = error.poNumbers[idx];
        return `  - ${filename}${poNum ? ` (PO #${poNum})` : ''}`;
      }).join('\n');

      return {
        success: true,
        requiresHumanReview: true,
        reason: `Multiple purchase orders detected (${error.count} POs)`,
        tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
        additionalTags: ['multiple_pos_detected'],
        internalNote: `⚠️ Multiple Purchase Orders Detected\n\nThe customer attached ${error.count} purchase order documents:\n\n${poList}\n\nPlease review the ticket and determine which PO(s) to process, or contact the customer for clarification.`
      };
    }

    // Handle no purchase order found error (multiple PDFs but none are POs)
    if (error instanceof NoPurchaseOrderFoundError) {
      const fileList = error.filenames.map(f => `  - ${f}`).join('\n');

      return {
        success: true,
        requiresHumanReview: true,
        reason: `No purchase order found among ${error.pdfCount} PDF attachments`,
        tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
        internalNote: `⚠️ No Purchase Order Found\n\nThe customer attached ${error.pdfCount} PDF documents, but the AI could not identify any as purchase orders:\n\n${fileList}\n\nPossible reasons:\n- The PO is in an unusual format\n- The documents are quotes, invoices, or other non-PO documents\n- The customer forgot to attach the actual PO\n\nPlease review the attachments manually and contact the customer if needed.`
      };
    }

    // Re-throw other errors to be caught by outer try-catch
    throw error;
  }

  if (!pdfUrl) {
    return {
      success: true,
      requiresHumanReview: true,
      reason: 'No PDF attachment found for purchase order',
      tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
      internalNote: `⚠️ Purchase Order Processing Failed\n\nNo PDF attachment found on this ticket.\n\nPlease request the customer to attach their purchase order.`
    };
  }

  try {
    // Call existing PO processing logic
    // Parse PO with OpenAI (base schema)
    const baseParsed = await analyzePdfAndBuildPO(pdfUrl);

    // Load Fulcrum catalog
    const catalog = await fetchFulcrumData();

    // Enrich with customer/item matching & pricing checks
    const enriched = await enrichWithFulcrumAndAI(baseParsed, catalog);

    // Update ticket with PO data
    await updateTicketWithPO(ticketContext.ticketId, enriched, pdfUrl);

    // Extract first name for friendly response
    const firstName = getRequesterFirstName(ticketContext.requester);

    // Success!
    return {
      success: true,
      requiresHumanReview: false,
      reason: 'PO processed successfully',
      tag: 'AI_READY_FOR_HUMAN_REVIEW',
      additionalTags: ['purchase_order', 'ready_to_review'],
      internalNote: `✅ Purchase Order Processed\n\nPO Number: ${enriched.purchase_order?.purchase_order_number || 'N/A'}\nCompany: ${enriched.company_name || 'N/A'}\nItems: ${enriched.purchase_order?.items?.length || 0}\n\nPlease review the extracted data before submitting to Fulcrum.`,
      publicResponse: `Hi ${firstName},\n\nThank you for your purchase order! We've received it and are processing your request. Our team will review the details and get back to you shortly with confirmation.\n\nBest regards,\nRSG Security Team`,
      data: enriched
    };
  } catch (error: any) {
    // PO processing failed
    return {
      success: false,
      requiresHumanReview: true,
      reason: `PO processing error: ${error.message}`,
      tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
      internalNote: `⚠️ Purchase Order Processing Failed\n\nError: ${error.message}\n\nStack: ${error.stack || 'N/A'}\n\nPlease process this PO manually.`
    };
  }
}

/**
 * Handle ORDER_TRACKING intent
 * Fetches tracking information from Fulcrum and generates AI response
 * Supports both single and multiple PO numbers
 */
async function handleOrderTracking(
  ticketContext: TicketContext,
  intent: IntentClassification
): Promise<ProcessingResult> {
  console.log('[OrderTracking Handler] Starting order tracking handler');

  const openOrderReportAttachment = findOpenOrderReportAttachment(ticketContext);
  if (openOrderReportAttachment) {
    const openOrderReportResult = await handleOpenOrderReportTracking(ticketContext, openOrderReportAttachment);
    if (openOrderReportResult) {
      return openOrderReportResult;
    }
  }

  // Extract PO numbers from intent (now an array)
  const poNumbers = intent.keyEntities?.poNumbers || [];

  if (poNumbers.length === 0) {
    console.log('[OrderTracking Handler] No PO numbers found in intent');
    return {
      success: false,
      requiresHumanReview: true,
      reason: 'Could not extract any PO numbers from ticket',
      tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
      internalNote: `⚠️ Order Tracking - Missing PO Numbers\n\nThe AI could not extract any PO or order numbers from the ticket.\n\nIntent Confidence: ${intent.confidence}\nReasoning: ${intent.reasoning}\n\nPlease review the ticket and provide tracking information manually.`
    };
  }

  // MULTI-PO PATH: Handle multiple PO numbers
  if (poNumbers.length > 1) {
    console.log(`[OrderTracking Handler] Multi-PO request: ${poNumbers.length} POs - ${poNumbers.join(', ')}`);
    return await handleMultipleOrderTracking(ticketContext, intent, poNumbers);
  }

  // SINGLE-PO PATH: Original logic for single PO
  const poNumber = poNumbers[0];
  console.log(`[OrderTracking Handler] Single-PO request: ${poNumber}`);

  try {
    // Track the order
    console.log(`[OrderTracking Handler] Tracking PO: ${poNumber}`);
    const trackingResult = await trackOrder(poNumber);

    // Handle NOT_FOUND
    if (trackingResult.status === 'NOT_FOUND') {
      console.log('[OrderTracking Handler] Sales order not found');
      return {
        success: false,
        requiresHumanReview: true,
        reason: `Sales order not found for PO: ${poNumber}`,
        tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
        internalNote: `⚠️ Order Tracking - PO Not Found\n\nPO Number: ${poNumber}\n\nNo sales order was found in Fulcrum for this PO number. This could mean:\n- The PO number was misidentified by the AI\n- The order hasn't been entered into Fulcrum yet\n- The customer is referencing a different order number\n\nPlease verify with the customer and provide tracking manually.`,
        publicResponse: null
      };
    }

    // Generate AI response
    const firstName = getRequesterFirstName(ticketContext.requester);
    const { publicResponse, confidence, reasoning } = await generateTrackingResponse(
      ticketContext,
      trackingResult,
      intent,
      firstName
    );

    console.log(`[OrderTracking Handler] Generated response with confidence: ${confidence}`);

    // Check confidence threshold (0.85 per user requirements)
    const CONFIDENCE_THRESHOLD = Number(process.env.ORDER_TRACKING_CONFIDENCE_THRESHOLD ?? "0.85");

    if (confidence < CONFIDENCE_THRESHOLD) {
      console.log(`[OrderTracking Handler] Confidence ${confidence} below threshold ${CONFIDENCE_THRESHOLD}`);
      return {
        success: false,
        requiresHumanReview: true,
        reason: `Low confidence response (${confidence})`,
        tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
        internalNote: `⚠️ Order Tracking - Low Confidence\n\nPO Number: ${poNumber}\nSales Order: #${trackingResult.salesOrder.number}\nStatus: ${trackingResult.status}\nConfidence: ${confidence}\nReasoning: ${reasoning}\n\nThe AI generated a response but confidence is below the threshold (${CONFIDENCE_THRESHOLD}).\n\nPlease review the draft response below and adjust as needed before sending to the customer.`,
        publicResponse
      };
    }

    // Success!
    console.log('[OrderTracking Handler] Success - ready for review');
    return {
      success: true,
      requiresHumanReview: false,
      reason: 'Order tracking information retrieved successfully',
      tag: 'AI_READY_FOR_HUMAN_REVIEW',
      internalNote: `✅ Order Tracking Retrieved\n\nPO Number: ${poNumber}\nSales Order: #${trackingResult.salesOrder.number}\nStatus: ${trackingResult.status}\nShipped Shipments: ${trackingResult.shippedShipments.length}\nPending Shipments: ${trackingResult.pendingShipments.length}\nAI Confidence: ${confidence}\n\nPlease review the draft response below and send to the customer if accurate.`,
      publicResponse,
      data: trackingResult
    };

  } catch (error: any) {
    console.error('[OrderTracking Handler] Error:', error);
    return {
      success: false,
      requiresHumanReview: true,
      reason: `Error tracking order: ${error.message}`,
      tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
      internalNote: `⚠️ Order Tracking - Error\n\nPO Number: ${poNumber}\n\nError: ${error.message}\n\nStack: ${error.stack || 'N/A'}\n\nPlease investigate and provide tracking information manually.`
    };
  }
}

async function handleOpenOrderReportTracking(
  ticketContext: TicketContext,
  attachment: TicketAttachment
): Promise<ProcessingResult | null> {
  try {
    const report = await parseOpenOrderReportAttachment(attachment);
    const result = await enrichOpenOrderReport(report);
    const outputFilename = attachment.filename.replace(/\.csv$/i, "") + "-with-tracking.csv";
    const firstName = getRequesterFirstName(ticketContext.requester);

    await attachFileToTicket(
      ticketContext.ticketId,
      outputFilename,
      result.generatedCsv,
      "text/csv",
      `Attached open order report enriched from Fulcrum: ${outputFilename}`
    );

    const noteLines = [
      "✅ Open Order Report Enriched",
      "",
      `Source Attachment: ${attachment.filename}`,
      `Generated Attachment: ${outputFilename}`,
      `Rows Processed: ${result.rows.length}`,
      `Rows With Warnings: ${result.unmatchedRows}`,
      `Unmatched Purchase Orders: ${result.unmatchedPurchaseOrders.length > 0 ? result.unmatchedPurchaseOrders.join(", ") : "none"}`,
      "",
      "Please review the attached CSV and the draft response below before sending to the customer."
    ];

    const requiresHumanReview = result.unmatchedRows > 0;

    return {
      success: true,
      requiresHumanReview,
      reason: requiresHumanReview
        ? `Open order report enriched with ${result.unmatchedRows} warning row(s)`
        : "Open order report enriched successfully",
      tag: requiresHumanReview ? 'AI_ALERT_HUMAN_REVIEW_REQUIRED' : 'AI_READY_FOR_HUMAN_REVIEW',
      additionalTags: ['order_tracking', 'open_order_report'],
      internalNote: noteLines.join("\n"),
      publicResponse: `Hi ${firstName},

Attached is the updated open order report with Promise / Ship Date and Tracking Number columns populated from Fulcrum where available.

Please let us know if anything else is needed and we'd be happy to help.

Thank you,`,
      data: result,
    };
  } catch (error: any) {
    if (error.message?.includes("not a supported open order report")) {
      console.log(`[OpenOrderReport Handler] Attachment ${attachment.filename} is not a supported open order report, falling back to standard tracking`);
      return null;
    }

    console.error('[OpenOrderReport Handler] Error:', error);
    return {
      success: false,
      requiresHumanReview: true,
      reason: `Error processing open order report: ${error.message}`,
      tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
      internalNote: `⚠️ Open Order Report Processing Error\n\nAttachment: ${attachment.filename}\n\nError: ${error.message}\n\nStack: ${error.stack || 'N/A'}\n\nPlease review the CSV manually and provide the requested tracking update.`,
    };
  }
}

/**
 * Handle ORDER_TRACKING intent for MULTIPLE PO numbers
 * Tracks all orders in parallel and generates consolidated response
 */
async function handleMultipleOrderTracking(
  ticketContext: TicketContext,
  intent: IntentClassification,
  poNumbers: string[]
): Promise<ProcessingResult> {
  console.log(`[Multi-OrderTracking Handler] Tracking ${poNumbers.length} POs: ${poNumbers.join(', ')}`);

  // Track all orders in parallel
  const trackingPromises = poNumbers.map(async (po) => {
    try {
      const result = await trackOrder(po);
      return { success: true as const, poNumber: po, result };
    } catch (error: any) {
      console.error(`[Multi-OrderTracking Handler] Error tracking PO ${po}:`, error);
      return { success: false as const, poNumber: po, error: error.message };
    }
  });

  const trackingAttempts = await Promise.all(trackingPromises);

  // Categorize results
  const successful: Array<{ poNumber: string; result: TrackingResult }> = [];
  const notFound: string[] = [];
  const errors: Array<{ poNumber: string; message: string }> = [];

  trackingAttempts.forEach((attempt) => {
    if (!attempt.success) {
      errors.push({ poNumber: attempt.poNumber, message: attempt.error });
    } else if (attempt.result.status === 'NOT_FOUND') {
      notFound.push(attempt.poNumber);
    } else {
      successful.push({ poNumber: attempt.poNumber, result: attempt.result });
    }
  });

  console.log(`[Multi-OrderTracking Handler] Results - Success: ${successful.length}, Not Found: ${notFound.length}, Errors: ${errors.length}`);

  // If ALL failed or not found, require human review
  if (successful.length === 0) {
    const failureDetails = [
      ...notFound.map(po => `- ${po}: Not found in Fulcrum`),
      ...errors.map(err => `- ${err.poNumber}: Error - ${err.message}`)
    ].join('\n');

    return {
      success: false,
      requiresHumanReview: true,
      reason: `Could not find tracking for any of ${poNumbers.length} PO numbers`,
      tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
      internalNote: `⚠️ Order Tracking - All POs Failed\n\nRequested POs: ${poNumbers.join(', ')}\n\nFailure Details:\n${failureDetails}\n\nPlease review the ticket and provide tracking information manually.`
    };
  }

  // Generate consolidated response using AI
  const firstName = getRequesterFirstName(ticketContext.requester);
  const { publicResponse, confidence, reasoning } = await generateMultiTrackingResponse(
    ticketContext,
    successful.map(s => s.result),
    notFound,
    errors,
    intent,
    firstName
  );

  // Check confidence threshold
  const CONFIDENCE_THRESHOLD = Number(process.env.ORDER_TRACKING_CONFIDENCE_THRESHOLD ?? "0.85");

  if (confidence < CONFIDENCE_THRESHOLD) {
    console.log(`[Multi-OrderTracking Handler] Confidence ${confidence} below threshold ${CONFIDENCE_THRESHOLD}`);
    return {
      success: false,
      requiresHumanReview: true,
      reason: `Low confidence multi-PO response (${confidence})`,
      tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
      internalNote: buildMultiTrackingNote(successful, notFound, errors, confidence, reasoning),
      publicResponse
    };
  }

  // Success!
  console.log('[Multi-OrderTracking Handler] Success - ready for review');
  return {
    success: true,
    requiresHumanReview: false,
    reason: `Successfully tracked ${successful.length}/${poNumbers.length} orders`,
    tag: 'AI_READY_FOR_HUMAN_REVIEW',
    internalNote: buildMultiTrackingNote(successful, notFound, errors, confidence, reasoning),
    publicResponse,
    data: {
      trackingResults: successful.map(s => s.result),
      notFound,
      errors,
      poNumbers
    }
  };
}

/**
 * Build internal note for multi-PO tracking results
 * Formats as a summary table with key details
 */
function buildMultiTrackingNote(
  successful: Array<{ poNumber: string; result: TrackingResult }>,
  notFound: string[],
  errors: Array<{ poNumber: string; message: string }>,
  confidence: number,
  reasoning: string
): string {
  const lines: string[] = ['✅ Multiple Order Tracking Results\n'];

  // Summary stats
  const total = successful.length + notFound.length + errors.length;
  lines.push(`Total POs Requested: ${total}`);
  lines.push(`Successfully Tracked: ${successful.length}`);
  lines.push(`Not Found: ${notFound.length}`);
  lines.push(`Errors: ${errors.length}`);
  lines.push(`AI Confidence: ${confidence}\n`);

  // Successful tracking table
  if (successful.length > 0) {
    lines.push('SUCCESSFULLY TRACKED:');
    lines.push('PO Number | Sales Order | Status | Shipped | Pending');
    lines.push('----------|-------------|--------|---------|--------');
    successful.forEach(({ poNumber, result }) => {
      lines.push(
        `${poNumber} | #${result.salesOrder.number} | ${result.status} | ${result.shippedShipments.length} | ${result.pendingShipments.length}`
      );
    });
    lines.push('');
  }

  // Not found
  if (notFound.length > 0) {
    lines.push('NOT FOUND IN FULCRUM:');
    notFound.forEach(po => lines.push(`- ${po}`));
    lines.push('');
  }

  // Errors
  if (errors.length > 0) {
    lines.push('ERRORS:');
    errors.forEach(err => lines.push(`- ${err.poNumber}: ${err.message}`));
    lines.push('');
  }

  lines.push(`Reasoning: ${reasoning}\n`);
  lines.push('Please review the draft response below and send to the customer if accurate.');

  return lines.join('\n');
}

/**
 * Route ticket to appropriate handler based on intent
 * Includes comprehensive error handling
 */
export async function handleTicketIntent(
  ticketContext: TicketContext,
  intent: IntentClassification
): Promise<ProcessingResult> {
  try {
    switch (intent.intent) {
      case 'PURCHASE_ORDER':
        // Call existing PO processing logic (modular wrapper)
        return await processPurchaseOrderWrapper(ticketContext, intent);

      case 'ORDER_TRACKING':
        return await handleOrderTracking(ticketContext, intent);

      case 'PRODUCT_QUESTION':
        // Stub for now
        return {
          success: false,
          requiresHumanReview: true,
          reason: 'PRODUCT_QUESTION handler not yet implemented',
          tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
          internalNote: `⚠️ AI Processing - Not Yet Implemented\n\nIntent: PRODUCT_QUESTION\nConfidence: ${intent.confidence}\n\nThis ticket appears to be a product question, but the handler is not yet implemented.\n\nPlease handle manually.`
        };

      case 'OTHER':
        return {
          success: false,
          requiresHumanReview: true,
          reason: 'Ticket intent does not match supported categories',
          tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
          internalNote: `⚠️ AI Processing - Unknown Intent\n\nThe AI could not confidently classify this ticket into a supported category.\n\nReasoning: ${intent.reasoning}\n\nPlease handle manually.`
        };

      default:
        throw new Error(`Unknown intent type: ${intent.intent}`);
    }
  } catch (error: any) {
    // Catch any errors during handler execution
    console.error(`Error in handler for intent ${intent.intent}:`, error);

    // Send alert email
    await sendAlertEmail({
      to: 'dreuven@rsgsecurity.com',
      subject: `PoProcessor Error - Ticket ${ticketContext.ticketId} - Handler Failure`,
      body: `
Error occurred while processing ticket ${ticketContext.ticketId}

Intent: ${intent.intent}
Confidence: ${intent.confidence}

Error Message:
${error.message}

Stack Trace:
${error.stack || 'N/A'}

Ticket Subject: ${ticketContext.subject}
Requester: ${ticketContext.requester.name} <${ticketContext.requester.email}>

Zendesk Link: https://rsgsecurity.zendesk.com/agent/tickets/${ticketContext.ticketId}
      `.trim()
    });

    return {
      success: false,
      requiresHumanReview: true,
      reason: `Handler execution error: ${error.message}`,
      tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
      internalNote: `⚠️ AI Processing Failed - Exception Thrown\n\nIntent: ${intent.intent}\n\nError: ${error.message}\n\nStack:\n${error.stack || 'N/A'}\n\nAn alert email has been sent to the engineering team.\n\nPlease handle this ticket manually.`
    };
  }
}
