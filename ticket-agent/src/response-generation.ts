// src/response-generation.ts
// AI-powered response generation for order tracking

import type { TicketContext, IntentClassification, TrackingResult } from "./types";
import { formatDateForCustomer } from "./order-tracking";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENAI_REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? "420000");
const MODEL = "gpt-5";

/**
 * Sleep utility
 */
async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Post JSON to OpenAI with retry logic
 */
async function postJsonWithRetry<T>(
  url: string,
  body: any,
  maxRetries = 2,
  timeoutMs = OPENAI_REQUEST_TIMEOUT_MS
): Promise<T> {
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`OpenAI API error ${resp.status}: ${errText}`);
      }
      return (await resp.json()) as T;
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) throw err;
      await sleep(500 * attempt);
    } finally {
      clearTimeout(to);
    }
  }
}

/**
 * Extract output text from OpenAI Responses API
 */
function extractOutputText(data: any): string {
  const message = (data.output || []).find((o: any) => o.type === "message");
  if (!message) return "";
  const block = (message.content || []).find(
    (c: any) => c.type === "output_text" && typeof c.text === "string"
  );
  return block?.text || "";
}

/**
 * Generate a friendly tracking response using AI
 */
export async function generateTrackingResponse(
  ticketContext: TicketContext,
  trackingResult: TrackingResult,
  intent: IntentClassification,
  requesterFirstName: string
): Promise<{ publicResponse: string; confidence: number; reasoning: string }> {
  console.log('[ResponseGeneration] Generating tracking response with AI');

  // Build structured tracking data for the AI
  const trackingData = buildTrackingDataSummary(trackingResult);

  const prompt = `You are a friendly and professional customer service representative for RSG Security, a fire safety equipment manufacturer.

CUSTOMER INFORMATION:
- Name: ${requesterFirstName || 'there'}
- Original Question: "${ticketContext.subject}"
- Latest Comment: "${ticketContext.latestPublicComment?.body || ticketContext.description}"

ORDER INFORMATION:
PO Number: ${trackingResult.salesOrder.customerPoNumber}
Sales Order #: ${trackingResult.salesOrder.number}
Order Status: ${trackingResult.salesOrder.status}
Delivery Due Date: ${formatDateForCustomer(trackingResult.salesOrder.deliveryDueDate)}

SHIPMENT STATUS: ${trackingResult.status}

${trackingData}

INSTRUCTIONS:
1. Generate a warm, professional response to the customer's inquiry
2. Use the customer's first name if provided (otherwise use "there")
3. Use clean, simple text formatting - keep it concise and professional
4. DO NOT use emojis or special symbols
5. For orders with tracking: Include plain text URLs (https://...) not markdown links
6. Include ONLY essential information: PO #, Sales Order #, Carrier, Status, Tracking URL
7. DO NOT include internal shipment references (like SHP-SO3561-1)
8. For orders not yet shipped: Include expected ship/delivery dates
9. For partially shipped orders: Briefly explain shipped vs pending
10. Keep the tone friendly but professional - avoid being too verbose
11. End with: "If there's anything we can assist with, please let us know and we'd be happy to help!"
12. Sign off with: "Thank you,"

CONFIDENCE SCORING:
- Return confidence 0.95+ if: All shipments have tracking, clear status
- Return confidence 0.80-0.95 if: Some shipments lack tracking, but dates are clear
- Return confidence 0.65-0.80 if: Multiple shipments with complex status
- Return confidence <0.65 if: Missing critical info or ambiguous situation

Return your response in JSON format:
{
  "response": "The complete email response to the customer",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of confidence score"
}`;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      response: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reasoning: { type: "string" }
    },
    required: ["response", "confidence", "reasoning"]
  };

  const body = {
    model: MODEL,
    text: {
      format: {
        name: "tracking_response",
        type: "json_schema",
        schema
      }
    },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt }
        ]
      }
    ],
    max_output_tokens: 2000
  };

  const data = await postJsonWithRetry<any>("https://api.openai.com/v1/responses", body, 2);
  const outputText = extractOutputText(data);

  let result: { response: string; confidence: number; reasoning: string };
  try {
    result = JSON.parse(outputText);
  } catch {
    // Fallback if parsing fails
    return {
      publicResponse: `Hi ${requesterFirstName},\n\nI apologize, but I encountered an error generating your tracking update. Please contact our team directly for assistance with PO ${trackingResult.salesOrder.customerPoNumber}.\n\nBest regards,\nRSG Security Team`,
      confidence: 0,
      reasoning: 'Failed to parse AI response'
    };
  }

  console.log(`[ResponseGeneration] Generated response with confidence: ${result.confidence}`);

  return {
    publicResponse: result.response,
    confidence: result.confidence,
    reasoning: result.reasoning
  };
}

/**
 * Build a structured summary of tracking data for the AI prompt
 */
function buildTrackingDataSummary(trackingResult: TrackingResult): string {
  const lines: string[] = [];

  if (trackingResult.status === 'FULLY_SHIPPED') {
    lines.push('SHIPPED ITEMS:');
    trackingResult.trackingInfo.forEach((info, idx) => {
      lines.push(`\nShipment ${idx + 1}:`);
      lines.push(`   Shipped Date: ${formatDateForCustomer(info.shippedDate)}`);
      if (info.carrier || info.shippingMethod) {
        lines.push(`   Carrier: ${info.carrier || info.shippingMethod}`);
      }
      if (info.trackingNumber && info.trackingUrl) {
        lines.push(`   Tracking: ${info.trackingUrl}`);
      } else if (info.trackingNumber) {
        lines.push(`   Tracking Number: ${info.trackingNumber}`);
      } else {
        lines.push(`   Tracking: Not available`);
      }
    });
  } else if (trackingResult.status === 'PARTIALLY_SHIPPED') {
    if (trackingResult.shippedShipments.length > 0) {
      lines.push('SHIPPED ITEMS:');
      trackingResult.trackingInfo.forEach((info, idx) => {
        lines.push(`\nShipment ${idx + 1}:`);
        lines.push(`   Shipped Date: ${formatDateForCustomer(info.shippedDate)}`);
        if (info.carrier || info.shippingMethod) {
          lines.push(`   Carrier: ${info.carrier || info.shippingMethod}`);
        }
        if (info.trackingNumber && info.trackingUrl) {
          lines.push(`   Tracking: ${info.trackingUrl}`);
        } else if (info.trackingNumber) {
          lines.push(`   Tracking Number: ${info.trackingNumber}`);
        }
      });
    }

    if (trackingResult.pendingShipments.length > 0) {
      lines.push('\n\nPENDING SHIPMENTS:');
      trackingResult.pendingShipments.forEach((shipment, idx) => {
        lines.push(`\nShipment ${idx + 1}:`);
        lines.push(`   Status: ${shipment.status}`);
        lines.push(`   Scheduled Ship Date: ${formatDateForCustomer(shipment.shipByDate)}`);
      });
    }
  } else if (trackingResult.status === 'NOT_SHIPPED') {
    lines.push('ORDER NOT YET SHIPPED');
    lines.push(`Scheduled Delivery Date: ${formatDateForCustomer(trackingResult.scheduledDeliveryDate)}`);
    if (trackingResult.pendingShipments.length > 0) {
      lines.push(`\nNumber of Pending Shipments: ${trackingResult.pendingShipments.length}`);
      trackingResult.pendingShipments.forEach((shipment, idx) => {
        lines.push(`Shipment ${idx + 1} - Expected Ship Date: ${formatDateForCustomer(shipment.shipByDate)}`);
      });
    }
  }

  return lines.join('\n');
}

/**
 * Generate a friendly tracking response for MULTIPLE PO numbers using AI
 * Consolidates results into a single cohesive response with table formatting
 */
export async function generateMultiTrackingResponse(
  ticketContext: TicketContext,
  trackingResults: TrackingResult[],
  notFoundPOs: string[],
  errors: Array<{ poNumber: string; message: string }>,
  intent: IntentClassification,
  requesterFirstName: string
): Promise<{ publicResponse: string; confidence: number; reasoning: string }> {
  console.log(`[Multi-ResponseGeneration] Generating response for ${trackingResults.length} successful, ${notFoundPOs.length} not found, ${errors.length} errors`);

  // Build structured tracking data for each successful PO
  const trackingDataList = trackingResults.map(result => ({
    poNumber: result.salesOrder.customerPoNumber,
    salesOrderNumber: result.salesOrder.number,
    orderStatus: result.salesOrder.status,
    trackingStatus: result.status,
    deliveryDueDate: formatDateForCustomer(result.salesOrder.deliveryDueDate),
    shippedCount: result.shippedShipments.length,
    pendingCount: result.pendingShipments.length,
    summary: buildTrackingDataSummary(result)
  }));

  const prompt = `You are a friendly and professional customer service representative for RSG Security, a fire safety equipment manufacturer.

CUSTOMER INFORMATION:
- Name: ${requesterFirstName || 'there'}
- Original Question: "${ticketContext.subject}"
- Latest Comment: "${ticketContext.latestPublicComment?.body || ticketContext.description}"

MULTIPLE ORDERS REQUESTED - TRACKING INFORMATION:

${trackingDataList.map((data, idx) => `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ORDER ${idx + 1}:
PO Number: ${data.poNumber}
Sales Order #: ${data.salesOrderNumber}
Order Status: ${data.orderStatus}
Delivery Due Date: ${data.deliveryDueDate}

SHIPMENT STATUS: ${data.trackingStatus}

${data.summary}
`).join('\n')}

${notFoundPOs.length > 0 ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NOT FOUND IN SYSTEM:
The following PO numbers could not be found in our system:
${notFoundPOs.map(po => `- ${po}`).join('\n')}
` : ''}

${errors.length > 0 ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ERRORS:
The following PO numbers encountered errors:
${errors.map(err => `- ${err.poNumber}: ${err.message}`).join('\n')}
` : ''}

INSTRUCTIONS:
1. Generate a warm, professional response covering ALL orders in ONE cohesive message
2. Use the customer's first name if provided (otherwise use "there")
3. For multiple orders, use this EXACT format:

   Thank you for reaching out! Here's the tracking information for your orders:

   ORDER SUMMARY:
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   PO #12345 - Sales Order #67890 - SHIPPED
   Carrier: FedEx Ground
   Tracking: https://www.fedex.com/fedextrack/?tracknumbers=123456789

   PO #12346 - Sales Order #67891 - PENDING
   Expected Ship Date: December 28, 2024

   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

4. CRITICAL: Put the tracking details BETWEEN the lines, NOT after them
5. DO NOT include any redundant summary text inside the ORDER SUMMARY section
6. DO NOT include shipment reference names (like SHP-SO3561-1) - these are internal only
7. DO NOT use emojis or special symbols
8. Include ONLY: Customer PO #, Sales Order #, Carrier, Status, Tracking URL
9. Keep it concise and professional - don't add extra verbose details
10. If any POs were not found, mention them briefly at the end
11. Use plain text URLs (NOT markdown links)
12. End with: "If there's anything we can assist with, please let us know and we'd be happy to help!"
13. Sign off with: "Thank you,"

CONFIDENCE SCORING:
- Return confidence 0.95+ if: All orders found, complete tracking info, clear formatting
- Return confidence 0.85-0.95 if: Most orders found, some missing tracking details
- Return confidence 0.70-0.85 if: Some orders not found or errors occurred
- Return confidence <0.70 if: Multiple errors or missing critical information

Return your response in JSON format:
{
  "response": "The complete email response to the customer with clean text formatting (NO markdown tables)",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of confidence score"
}`;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      response: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reasoning: { type: "string" }
    },
    required: ["response", "confidence", "reasoning"]
  };

  const body = {
    model: MODEL,
    text: {
      format: {
        name: "multi_tracking_response",
        type: "json_schema",
        schema
      }
    },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt }
        ]
      }
    ],
    max_output_tokens: 3000  // Increased for multiple orders
  };

  const data = await postJsonWithRetry<any>("https://api.openai.com/v1/responses", body, 2);
  const outputText = extractOutputText(data);

  let result: { response: string; confidence: number; reasoning: string };
  try {
    result = JSON.parse(outputText);
  } catch {
    // Fallback if parsing fails
    const poList = trackingResults.map(r => r.salesOrder.customerPoNumber).join(', ');
    const notFoundList = notFoundPOs.length > 0 ? `\n\nNote: The following POs were not found: ${notFoundPOs.join(', ')}` : '';

    return {
      publicResponse: `Hi ${requesterFirstName},\n\nI apologize, but I encountered an error generating your tracking update for POs: ${poList}.${notFoundList}\n\nPlease contact our team directly for assistance.\n\nBest regards,\nRSG Security Team`,
      confidence: 0,
      reasoning: 'Failed to parse AI response'
    };
  }

  console.log(`[Multi-ResponseGeneration] Generated response with confidence: ${result.confidence}`);

  return {
    publicResponse: result.response,
    confidence: result.confidence,
    reasoning: result.reasoning
  };
}
