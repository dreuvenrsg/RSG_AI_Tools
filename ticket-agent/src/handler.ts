// src/handler.ts
import type { APIGatewayProxyHandlerV2, SQSEvent, SQSRecord, Context } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { extractTicketContext, getRequesterFirstName, updateTicketWithResult, removeReprocessTag, addProcessingTag, removeProcessingTag } from "./zendesk";
import { sendAlertEmail } from "./ses";
import { type IngestPayload } from "./types";
import { runCustomerServiceAgent } from "./agent/orchestrator";

const sqs = new SQSClient({});

/** Utility: JSON response for APIGW v2 */
function okJson(statusCode: number, body: object) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Ingest: quick response for Zendesk webhook.
 * - Verifies Bearer token (ZENDESK_WEBHOOK_TOKEN)
 * - Parses body for ticket_id
 * - Sends message to SQS
 * - Returns 202 immediately
 */
export const ingest: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const expected = process.env.ZENDESK_WEBHOOK_TOKEN;
    const authz = event.headers?.authorization || event.headers?.Authorization;
    if (expected) {
      const provided = (authz || "").replace(/^Bearer\s+/i, "").trim();
      if (!provided || provided !== expected) {
        return okJson(401, { error: "unauthorized" });
      }
    }

    if (!event.body) return okJson(400, { error: "missing body" });
    const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;

    const ticketId = Number(body.ticket_id ?? body.ticketId ?? body.id);
    if (!ticketId || Number.isNaN(ticketId)) {
      return okJson(400, { error: "missing ticket_id" });
    }

    const queueUrl = process.env.PO_QUEUE_URL;
    if (!queueUrl) {
      // Allow local testing without SQS
      console.warn("PO_QUEUE_URL not set; skipping SQS send (local mode).");
      return okJson(202, { enqueued: false, ticket_id: ticketId });
    }

    const msg: IngestPayload = { ticket_id: ticketId, attempt: 1 };
    const send = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(msg),
      })
    );

    return okJson(202, { enqueued: true, messageId: send.MessageId, ticket_id: ticketId });
  } catch (err: any) {
    console.error("ingest error:", err);
    return okJson(500, { error: "internal error" });
  }
};

/**
 * SQS Worker — 15-minute path.
 * Strategy:
 * 1. Mark ticket as PROCESSING (so Zendesk trigger won't re-fire).
 * 2. Get latest PDF content_url from comments or ticket.
 * 3. If no PDF: set HAS_NO_PDF and email sales.
 * 4. Else: call OpenAI to parse → enrich w/ Fulcrum + AI matching → attach JSON (with pdfUrl) → mark READY.
 * 5. On error: mark REVIEW_FAILED and email, then throw to let SQS retry/DLQ.
 */
export const worker = async (event: SQSEvent, _ctx: Context) => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};

export async function processTicketById(ticketId: number): Promise<void> {
  console.log(`Processing ticket: ${ticketId}`);

  await addProcessingTag(ticketId);

  try {
    console.log('Step 1: Extracting ticket context...');
    const ticketContext = await extractTicketContext(ticketId);
    console.log(`Extracted context: ${ticketContext.comments.length} comments, ${ticketContext.comments.flatMap(c => c.attachments).length} attachments`);

    console.log('Step 2: Running customer-service agent...');
    const { result, turn } = await runCustomerServiceAgent(ticketContext, (e) => {
      if (e.type === 'tool_use') console.log(`[agent] tool_use ${e.name}`);
      if (e.type === 'tool_result' && !e.ok) console.log(`[agent] tool_error ${e.name}: ${e.error}`);
    });
    console.log(`Agent result: category=${result.data?.category}, outcome=${result.success ? 'ready' : 'alert'}, tools=${turn.toolCalls.length}, iterations=${turn.iterations}`);

    console.log('Step 3: Updating ticket...');
    await updateTicketWithResult(
      ticketId,
      result,
      getRequesterFirstName(ticketContext.requester)
    );

    if (!result.success) {
      await sendAlertEmail({
        to: 'dreuven@rsgsecurity.com',
        subject: `CSDroid - Ticket ${ticketId} Requires Review`,
        body: `
Ticket ${ticketId} requires human review.

Category: ${result.data?.category || 'unknown'}
Reason: ${result.reason}

Requester: ${ticketContext.requester.name} <${ticketContext.requester.email}>
Subject: ${ticketContext.subject}

Zendesk Link: https://rsgsecurity.zendesk.com/agent/tickets/${ticketId}
        `.trim()
      });
    }

    console.log('Processing complete');
  } finally {
    await removeProcessingTag(ticketId);
    await removeReprocessTag(ticketId);
  }
}

async function processRecord(record: SQSRecord) {
  let payload: IngestPayload | null = null;
  let ticketId: number | undefined;

  try {
    payload = JSON.parse(record.body) as IngestPayload;
    ticketId = Number(payload.ticket_id);
    if (!ticketId) throw new Error("Invalid ticket_id");

    await processTicketById(ticketId);

  } catch (err: any) {
    console.error('Fatal error processing ticket:', err);

    // Detect error type
    const errorMessage = err?.message || String(err);
    const isQuotaError = errorMessage.includes('429') ||
                        errorMessage.includes('quota') ||
                        errorMessage.includes('insufficient_quota');
    const isRateLimitError = errorMessage.includes('rate_limit') ||
                            errorMessage.includes('Rate limit');

    // Get current attempt number from SQS attributes
    const attemptNumber = Number(record.attributes?.ApproximateReceiveCount || 1);
    const isFirstAttempt = attemptNumber === 1;

    console.log(`Error on attempt ${attemptNumber}. Quota/Rate error: ${isQuotaError || isRateLimitError}`);

    // Send detailed alert email (only on first attempt to avoid spam)
    if (isFirstAttempt) {
      await sendAlertEmail({
        to: 'dreuven@rsgsecurity.com',
        subject: `PoProcessor ${isQuotaError ? 'QUOTA' : 'FATAL'} ERROR - Ticket ${ticketId}`,
        body: `
${isQuotaError ? 'OPENAI QUOTA EXCEEDED' : 'FATAL ERROR'} occurred while processing ticket ${ticketId}

Error Message:
${errorMessage}

Stack Trace:
${err?.stack || 'N/A'}

Record ID: ${record.messageId}
Attempt: ${attemptNumber}

${isQuotaError ? 'This error will NOT be retried. Please add credits to OpenAI account.' : 'This error will be retried up to 3 times.'}

Please investigate ${isQuotaError ? 'billing' : 'immediately'}.
        `.trim()
      });
    }

    // Add error comment to ticket (ONLY on first attempt to prevent spam)
    if (ticketId && isFirstAttempt) {
      try {
        await updateTicketWithResult(
          ticketId,
          {
            success: false,
            requiresHumanReview: true,
            reason: `Fatal error: ${errorMessage}`,
            tag: 'AI_ALERT_HUMAN_REVIEW_REQUIRED',
            internalNote: `⚠️⚠️ CRITICAL ERROR - AI Processing Failed ⚠️⚠️\n\nA fatal error occurred while processing this ticket.\n\n${isQuotaError ? '🚫 OpenAI API Quota Exceeded\n\nYour OpenAI account has run out of credits. Please add credits at:\nhttps://platform.openai.com/settings/organization/billing\n\n' : ''}Error: ${errorMessage}\n\nStack:\n${err?.stack || 'N/A'}\n\nAn alert has been sent to the engineering team.\n\nPlease handle this ticket manually with high priority.`
          },
          'there' // Fallback name if we couldn't extract requester
        );
      } catch (updateError) {
        console.error('Could not update ticket after fatal error:', updateError);
      }

      // CRITICAL: Always remove processing tags on fatal error
      // This prevents infinite retries and signals processing is complete (even if failed)
      try {
        await removeProcessingTag(ticketId);  // Remove "AI is working" indicator
        await removeReprocessTag(ticketId);   // Remove reprocess trigger
      } catch (tagError) {
        console.error('Could not remove tags after fatal error:', tagError);
      }
    }

    // Re-throw for Lambda retry logic ONLY if NOT a quota/rate limit error
    if (isQuotaError || isRateLimitError) {
      console.error('Quota/rate limit error detected - NOT retrying (exiting gracefully)');
      return; // Exit gracefully - don't trigger SQS retry
    }

    // For other errors, re-throw to trigger SQS retry (max 3 attempts via SQS config)
    console.error('Retryable error - throwing for SQS retry logic');
    throw err;
  }
}
