// src/zendesk.ts
import crypto from "node:crypto";
import {
  STATUS,
  type ParsedPO,
  type TicketContext,
  type TicketComment,
  type TicketUser,
  type TicketAttachment,
  type TicketAttachmentDownload,
  type ProcessingResult,
  MultiplePurchaseOrdersError,
  NoPurchaseOrderFoundError
} from "./types";
import { classifyPdfAttachments, type PdfAttachment } from "./pdf-classification";
import { isDryRun, recordWrite } from "./dry-run";

/**
 * SAFETY CHOKEPOINT: every customer-reachable comment write must go through a
 * path that asserts the comment is private. We never message a customer
 * programmatically — only internal notes / drafts. This throws loudly if any
 * code path ever tries to post a public comment on a production ticket.
 */
function assertPrivateComment(isPublic: boolean | undefined): void {
  if (isPublic === true) {
    throw new Error(
      "[safety] Refused to post a PUBLIC comment. CSDroid only writes private internal notes/drafts."
    );
  }
}

const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN!;
const ZD_EMAIL = process.env.ZENDESK_EMAIL!;
const ZD_API_TOKEN = process.env.ZENDESK_API_TOKEN!;
const AUTH =
  "Basic " +
  Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString("base64");
const PO_STATUS_FIELD_ID = Number(process.env.PO_STATUS_FIELD_ID ?? 45116435108627);
const PO_RESULT_SHA_FIELD_ID = Number(process.env.PO_RESULT_SHA_FIELD_ID ?? 0);
const PO_JSON_ATTACHMENT_ID_FIELD_ID = Number(process.env.PO_JSON_ATTACHMENT_ID_FIELD_ID ?? 0);

function assertZendeskEnv() {
  if (!ZD_SUBDOMAIN || !ZD_EMAIL || !ZD_API_TOKEN) {
    console.log(`In assertZendeskEnv, ZD_SUBDOMAIN: ${ZD_SUBDOMAIN} , ZD_EMAIL: ${ZD_EMAIL}, ZD_API_TOKEN: ${ZD_API_TOKEN}`)
    throw new Error("Zendesk env not configured");
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function zdFetch(url: string, init?: RequestInit): Promise<Response> {
  assertZendeskEnv();
  const full = url.startsWith("http")
    ? url
    : `https://${ZD_SUBDOMAIN}.zendesk.com${url}`;

  // Simple 429 handling via Retry-After
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(full, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        Authorization: AUTH,
      },
    });
    if (resp.status !== 429) return resp;

    const ra = resp.headers.get("Retry-After");
    const wait = ra ? Number(ra) * 1000 : 1500 * (attempt + 1);
    await sleep(wait);
  }
  // last try
  return fetch(full, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: AUTH },
  });
}

/**
 * Helper function to collect all PDF attachments from a ticket
 * Searches both comments and ticket-level attachments
 */
async function getAllPdfAttachments(ticketId: number): Promise<PdfAttachment[]> {
  const allPdfs: PdfAttachment[] = [];

  // Collect from comments (sorted newest first)
  const c = await zdFetch(`/api/v2/tickets/${ticketId}/comments.json?sort_order=desc`);
  if (c.ok) {
    const j = await c.json();
    const comments: any[] = j?.comments || [];
    for (const cm of comments) {
      const atts: any[] = cm?.attachments || [];
      for (const att of atts) {
        if (att?.content_type === "application/pdf" && att?.content_url) {
          allPdfs.push({
            url: att.content_url,
            filename: att.file_name || att.filename || "unknown.pdf"
          });
        }
      }
    }
  }

  // Fallback: ticket-level attachments (not always populated)
  const t = await zdFetch(`/api/v2/tickets/${ticketId}.json`);
  if (t.ok) {
    const j = await t.json();
    const atts: any[] = j?.ticket?.attachments || [];
    for (const att of atts) {
      if (att?.content_type === "application/pdf" && att?.content_url) {
        // Avoid duplicates
        if (!allPdfs.find(p => p.url === att.content_url)) {
          allPdfs.push({
            url: att.content_url,
            filename: att.file_name || att.filename || "unknown.pdf"
          });
        }
      }
    }
  }

  return allPdfs;
}

/**
 * Returns the PDF URL for purchase order processing.
 *
 * Logic:
 * - If 1 PDF: Returns URL immediately (fast path, no AI classification)
 * - If 2+ PDFs: Uses AI to classify each PDF
 *   - 0 POs found: Throws NoPurchaseOrderFoundError (needs human review)
 *   - 1 PO found: Returns that PO's URL
 *   - 2+ POs found: Throws MultiplePurchaseOrdersError (needs human review)
 * - If 0 PDFs: Returns null
 *
 * @throws MultiplePurchaseOrdersError when multiple POs are detected
 * @throws NoPurchaseOrderFoundError when multiple PDFs exist but none are POs
 */
export async function getTicketPdfUrl(ticketId: number): Promise<string | null> {
  console.log(`[getTicketPdfUrl] Fetching PDFs for ticket ${ticketId}`);

  const allPdfs = await getAllPdfAttachments(ticketId);

  console.log(`[getTicketPdfUrl] Found ${allPdfs.length} PDF(s)`);

  // No PDFs found
  if (allPdfs.length === 0) {
    return null;
  }

  // Single PDF - fast path, no AI classification needed
  if (allPdfs.length === 1) {
    console.log(`[getTicketPdfUrl] Single PDF found: ${allPdfs[0].filename}`);
    return allPdfs[0].url;
  }

  // Multiple PDFs - need AI classification to identify which is the PO
  console.log(`[getTicketPdfUrl] Multiple PDFs detected, starting classification...`);
  const classified = await classifyPdfAttachments(allPdfs);

  const poCount = classified.purchaseOrders.length;
  console.log(`[getTicketPdfUrl] Classification complete: ${poCount} PO(s) identified`);

  // No purchase orders found among multiple PDFs
  if (poCount === 0) {
    const filenames = classified.allClassified.map(c =>
      `${c.filename} (${c.isPurchaseOrder ? 'low confidence' : 'not a PO'})`
    );
    throw new NoPurchaseOrderFoundError(allPdfs.length, filenames);
  }

  // Single purchase order found - return it
  if (poCount === 1) {
    const po = classified.purchaseOrders[0];
    console.log(`[getTicketPdfUrl] Single PO identified: ${po.filename} (confidence: ${po.confidence})`);
    return po.url;
  }

  // Multiple purchase orders found - needs human review
  const poNumbers = classified.purchaseOrders.map(po => po.extractedPoNumber || null);
  const filenames = classified.purchaseOrders.map(po => po.filename);
  throw new MultiplePurchaseOrdersError(poCount, poNumbers, filenames);
}

/**
 * Update the PO status custom field to one of our supported values.
 */
export async function setPoStatus(ticketId: number, value: string): Promise<void> {
  if (recordWrite({ fn: "setPoStatus", ticketId, detail: { value } })) return;
  const body = {
    ticket: {
      custom_fields: [{ id: PO_STATUS_FIELD_ID, value }],
    },
  };
  const resp = await zdFetch(`/api/v2/tickets/${ticketId}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Zendesk setPoStatus failed ${resp.status}: ${text}`);
  }
}

/**
 * Upload a small JSON file and attach it to the ticket via a private comment.
 * - Step 1: POST /uploads.json?filename=... -> returns token
 * - Step 2: PUT /tickets/{id}.json with comment.uploads=[token]
 */
export async function attachJsonToTicket(ticketId: number, filename: string, jsonObj: any): Promise<{ uploadToken: string; attachmentId?: number }> {
  const json = JSON.stringify(jsonObj, null, 2);
  const { uploadToken: token, attachmentId: attId } = await attachFileToTicket(
    ticketId,
    filename,
    json,
    "application/json",
    `Attached parsed PO JSON: ${filename}`
  );

  // Optionally store the attachment id in a custom field
  if (PO_JSON_ATTACHMENT_ID_FIELD_ID && attId) {
    await zdFetch(`/api/v2/tickets/${ticketId}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket: {
          custom_fields: [{ id: PO_JSON_ATTACHMENT_ID_FIELD_ID, value: String(attId) }],
        },
      }),
    });
  }

  return { uploadToken: token, attachmentId: attId };
}

async function uploadFileToken(
  filename: string,
  content: string | Buffer,
  contentType: string
): Promise<string> {
  const upload = await zdFetch(`/api/v2/uploads.json?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: content as any,
  });
  if (!upload.ok) {
    const text = await upload.text().catch(() => "");
    throw new Error(`Zendesk upload failed ${upload.status}: ${text}`);
  }
  const uploadJson = await upload.json();
  const token = uploadJson?.upload?.token as string | undefined;
  if (!token) throw new Error("Zendesk upload: missing token");
  return token;
}

export async function attachFileToTicket(
  ticketId: number,
  filename: string,
  content: string | Buffer,
  contentType: string,
  commentBody: string,
  options: { public?: boolean } = {}
): Promise<{ uploadToken: string; attachmentId?: number }> {
  assertPrivateComment(options.public);
  if (recordWrite({ fn: "attachFileToTicket", ticketId, detail: { filename, contentType } })) {
    return { uploadToken: "dry-run", attachmentId: undefined };
  }
  const token = await uploadFileToken(filename, content, contentType);

  const update = await zdFetch(`/api/v2/tickets/${ticketId}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ticket: {
        comment: {
          public: options.public === true,
          body: commentBody,
          uploads: [token],
        },
      },
    }),
  });
  if (!update.ok) {
    const text = await update.text().catch(() => "");
    throw new Error(`Zendesk attach failed ${update.status}: ${text}`);
  }
  const updateJson = await update.json();
  const lastComment = updateJson?.audit?.events?.find?.((event: any) => event?.type === "Comment");
  const attachmentId = lastComment?.attachments?.[0]?.id;
  return { uploadToken: token, attachmentId };
}

/**
 * Full update flow after successful parse:
 * - attach JSON file (now includes pdfUrl)
 * - update status to ready_to_review
 * - optionally store SHA256 of JSON in a custom field (if configured)
 */
export async function updateTicketWithPO(
  ticketId: number, 
  poJson: ParsedPO, 
  pdfUrl: string  // NEW: Include PDF URL so frontend can access it
): Promise<void> {
  // CHANGED: Include PDF URL in the JSON payload
  const enrichedJson = { ...poJson, pdfUrl };
  
  // Attach JSON payload
  await attachJsonToTicket(ticketId, `po-${ticketId}.json`, enrichedJson);

  // Optional: store short hash for idempotency/debug
  if (PO_RESULT_SHA_FIELD_ID && !isDryRun()) {
    const sha = crypto.createHash("sha256").update(JSON.stringify(poJson)).digest("hex");
    await zdFetch(`/api/v2/tickets/${ticketId}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket: { custom_fields: [{ id: PO_RESULT_SHA_FIELD_ID, value: sha }] },
      }),
    });
  }

  // Move ticket into READY state
  await setPoStatus(ticketId, STATUS.READY);
}

// ============================================================
// New functions for generalized AI Customer Service Rep
// ============================================================

/**
 * Extract comprehensive ticket context from Zendesk
 * Fetches ticket details, requester/submitter info, and full comment history
 */
export async function extractTicketContext(ticketId: number): Promise<TicketContext> {
  // Fetch ticket details with user information
  const ticketResp = await zdFetch(`/api/v2/tickets/${ticketId}.json?include=users`);
  if (!ticketResp.ok) {
    const text = await ticketResp.text().catch(() => "");
    throw new Error(`Failed to fetch ticket ${ticketId}: ${ticketResp.status} ${text}`);
  }
  const ticketData = await ticketResp.json();
  const ticket = ticketData.ticket;

  // Fetch comments
  const commentsResp = await zdFetch(`/api/v2/tickets/${ticketId}/comments.json`);
  if (!commentsResp.ok) {
    const text = await commentsResp.text().catch(() => "");
    throw new Error(`Failed to fetch comments for ticket ${ticketId}: ${commentsResp.status} ${text}`);
  }
  const commentsData = await commentsResp.json();

  // Parse comments with attachments
  const comments: TicketComment[] = (commentsData.comments || []).map((cm: any) => ({
    id: cm.id,
    type: cm.type || 'Comment',
    author_id: cm.author_id,
    body: cm.body || '',
    html_body: cm.html_body,
    plain_body: cm.plain_body,
    public: cm.public !== false, // Default to true if not specified
    created_at: cm.created_at,
    attachments: (cm.attachments || []).map((att: any) => ({
      id: att.id,
      filename: att.file_name || att.filename,
      content_type: att.content_type,
      content_url: att.content_url,
      size: att.size || 0
    }))
  }));

  // Find latest public comment
  const publicComments = comments.filter(c => c.public);
  const latestPublicComment = publicComments.length > 0 ? publicComments[publicComments.length - 1] : undefined;

  // Find private notes
  const privateNotes = comments.filter(c => !c.public);

  // Extract requester from included users or fetch separately
  const users = ticketData.users || [];
  let requester: TicketUser;
  let submitter: TicketUser;

  const requesterUser = users.find((u: any) => u.id === ticket.requester_id);
  const submitterUser = users.find((u: any) => u.id === ticket.submitter_id);

  if (requesterUser) {
    requester = {
      id: requesterUser.id,
      name: requesterUser.name || '',
      email: requesterUser.email || '',
      organization_id: requesterUser.organization_id
    };
  } else {
    // Fallback: basic info from ticket
    requester = {
      id: ticket.requester_id,
      name: 'Unknown',
      email: ''
    };
  }

  if (submitterUser) {
    submitter = {
      id: submitterUser.id,
      name: submitterUser.name || '',
      email: submitterUser.email || '',
      organization_id: submitterUser.organization_id
    };
  } else {
    submitter = {
      id: ticket.submitter_id,
      name: 'Unknown',
      email: ''
    };
  }

  return {
    ticketId,
    subject: ticket.subject || '',
    description: ticket.description || '',
    status: ticket.status || '',
    priority: ticket.priority || '',
    requester,
    submitter,
    comments,
    latestPublicComment,
    privateNotes,
    customFields: ticket.custom_fields || [],
    tags: ticket.tags || []
  };
}

/**
 * Read-only: search tickets and return their ids (for the verification harness /
 * analytics). Pages until `limit` ids are collected.
 */
export async function searchTicketIds(query: string, limit = 100): Promise<number[]> {
  const ids: number[] = [];
  let url: string | null = `/api/v2/search.json?query=${encodeURIComponent(query)}&per_page=100`;
  while (url && ids.length < limit) {
    const resp = await zdFetch(url);
    if (!resp.ok) break;
    const j: any = await resp.json();
    for (const r of j.results || []) if (r?.id) ids.push(r.id);
    url = j.next_page || null;
  }
  return ids.slice(0, limit);
}

export function listTicketAttachments(ticketContext: TicketContext): TicketAttachment[] {
  return ticketContext.comments.flatMap((comment) => comment.attachments);
}

export function findLatestAttachment(
  ticketContext: TicketContext,
  predicate: (attachment: TicketAttachment) => boolean
): TicketAttachment | null {
  const attachments = listTicketAttachments(ticketContext).filter(predicate);
  return attachments.length > 0 ? attachments[attachments.length - 1] : null;
}

export async function downloadTicketAttachment(
  attachment: TicketAttachment
): Promise<TicketAttachmentDownload> {
  const response = await zdFetch(attachment.content_url);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to download attachment ${attachment.filename}: ${response.status} ${text}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const content = Buffer.from(arrayBuffer);
  const text =
    attachment.content_type.includes("text") ||
    /\.csv$/i.test(attachment.filename)
      ? content.toString("utf8")
      : undefined;

  return { attachment, content, text };
}

export async function createTicketCopy(
  sourceTicketId: number,
  options: { subjectPrefix?: string } = {}
): Promise<number> {
  if (isDryRun()) {
    throw new Error("createTicketCopy is disabled in dry-run mode (it would create a real Zendesk ticket).");
  }
  const ticketContext = await extractTicketContext(sourceTicketId);
  const subjectPrefix = options.subjectPrefix ?? "[PoProcessor Copy]";
  const sourceBody =
    ticketContext.latestPublicComment?.body ||
    ticketContext.description ||
    ticketContext.subject;

  const uploads: string[] = [];
  for (const attachment of listTicketAttachments(ticketContext)) {
    const downloaded = await downloadTicketAttachment(attachment);
    uploads.push(
      await uploadFileToken(
        attachment.filename,
        downloaded.content,
        attachment.content_type || "application/octet-stream"
      )
    );
  }

  const createResp = await zdFetch(`/api/v2/tickets.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ticket: {
        subject: `${subjectPrefix} ${sourceTicketId} - ${ticketContext.subject}`,
        comment: {
          public: true,
          body: `Copied from ticket ${sourceTicketId} for PoProcessor validation.\n\n${sourceBody}`,
          uploads,
        },
        requester: {
          name: ticketContext.requester.name,
          email: ticketContext.requester.email,
        },
        status: "new",
        tags: ["po_processor_test_copy", `source_ticket_${sourceTicketId}`],
      },
    }),
  });
  if (!createResp.ok) {
    const text = await createResp.text().catch(() => "");
    throw new Error(`Failed to create ticket copy for ${sourceTicketId}: ${createResp.status} ${text}`);
  }

  const created = await createResp.json();
  const createdId = Number(created?.ticket?.id);
  if (!createdId) {
    throw new Error(`Zendesk ticket copy for ${sourceTicketId} did not return an id`);
  }

  return createdId;
}

export async function closeTicketForTesting(
  ticketId: number,
  commentBody = "Closing PoProcessor validation copy."
): Promise<void> {
  if (recordWrite({ fn: "closeTicketForTesting", ticketId })) return;
  const attempts = ["closed", "solved"] as const;

  for (const status of attempts) {
    const response = await zdFetch(`/api/v2/tickets/${ticketId}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket: {
          status,
          comment: {
            public: false,
            body: commentBody,
          },
        },
      }),
    });

    if (response.ok) {
      return;
    }
  }

  throw new Error(`Failed to close validation ticket ${ticketId}`);
}

/**
 * Extract first name from a user's full name
 */
export function getRequesterFirstName(requester: TicketUser): string {
  const nameParts = requester.name.split(' ');
  return nameParts[0] || 'there'; // Fallback to 'there' if no name
}

/**
 * Update ticket with processing result, including tags and internal notes
 * If publicResponse is provided, adds it as a DRAFT (private note with prefix)
 */
export async function updateTicketWithResult(
  ticketId: number,
  result: ProcessingResult,
  requesterFirstName: string
): Promise<void> {
  // Build comment body
  let commentBody = '';

  // If there's a draft public response, add it first
  if (result.publicResponse) {
    commentBody += `[DRAFT PUBLIC RESPONSE - DO NOT SEND YET]\n\n`;
    commentBody += `${result.publicResponse}\n\n`;
    commentBody += `${'='.repeat(80)}\n\n`;
  }

  // Add internal note
  commentBody += result.internalNote;

  // Build tags array (primary tag + any additional tags)
  const tags: string[] = [result.tag];
  if (result.additionalTags && result.additionalTags.length > 0) {
    tags.push(...result.additionalTags);
  }

  // SAFETY: this comment is always private. Assert it and never relax.
  const commentIsPublic = false;
  assertPrivateComment(commentIsPublic);

  if (recordWrite({ fn: "updateTicketWithResult", ticketId, detail: { tags, hasDraft: !!result.publicResponse } })) {
    return;
  }

  // Update ticket with tag and comment
  const resp = await zdFetch(`/api/v2/tickets/${ticketId}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ticket: {
        tags, // Will be added to existing tags
        comment: {
          body: commentBody,
          public: false // Always private
        }
      }
    })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Failed to update ticket ${ticketId}: ${resp.status} ${text}`);
  }
}

/**
 * Add the 'ai_processing_active' tag to a ticket.
 * This signals to agents that the AI is actively working on this ticket.
 *
 * CRITICAL: This should be called at the START of ticket processing,
 * and removed at ALL exit points (success, failure, early returns).
 *
 * Uses dedicated PUT /api/v2/tickets/{ticketId}/tags endpoint which appends tags
 * without replacing existing ones.
 */
/**
 * Append arbitrary tags to a ticket (without removing existing tags).
 * Used to apply the ticket-type/category tag as soon as it's known, so the
 * type x outcome analytics is complete even if later steps fail.
 */
export async function addTags(ticketId: number, tags: string[]): Promise<void> {
  const clean = tags.map((t) => t.trim()).filter(Boolean);
  if (clean.length === 0) return;
  if (recordWrite({ fn: "addTags", ticketId, detail: { tags: clean } })) return;
  try {
    const resp = await zdFetch(`/api/v2/tickets/${ticketId}/tags.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: clean }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(`[addTags] Failed to add tags ${clean.join(",")}: ${resp.status} ${text}`);
    }
  } catch (error: any) {
    console.error(`[addTags] Error adding tags:`, error.message);
  }
}

export async function addProcessingTag(ticketId: number): Promise<void> {
  if (recordWrite({ fn: "addProcessingTag", ticketId })) return;
  try {
    console.log(`[addProcessingTag] Adding 'ai_processing_active' tag to ticket ${ticketId}`);

    const resp = await zdFetch(`/api/v2/tickets/${ticketId}/tags.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tags: ['ai_processing_active']
      })
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(`[addProcessingTag] Failed to add tag: ${resp.status} ${text}`);
      // Don't throw - tagging failure shouldn't block processing
    } else {
      console.log(`[addProcessingTag] Successfully added 'ai_processing_active' tag`);
    }
  } catch (error: any) {
    // Log but don't throw - tag addition is best-effort
    console.error(`[addProcessingTag] Error adding tag:`, error.message);
  }
}

/**
 * Remove the 'ai_processing_active' tag from a ticket.
 * This signals that the AI has finished processing (success or failure).
 *
 * CRITICAL: This should be called at ALL exit points of the worker lambda,
 * including success, failure, early returns, and catch blocks.
 *
 * Uses dedicated DELETE /api/v2/tickets/{ticketId}/tags endpoint which removes
 * specified tags without affecting other tags.
 */
export async function removeProcessingTag(ticketId: number): Promise<void> {
  if (recordWrite({ fn: "removeProcessingTag", ticketId })) return;
  try {
    console.log(`[removeProcessingTag] Removing 'ai_processing_active' tag from ticket ${ticketId}`);

    const resp = await zdFetch(`/api/v2/tickets/${ticketId}/tags.json`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tags: ['ai_processing_active']
      })
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(`[removeProcessingTag] Failed to remove tag: ${resp.status} ${text}`);
      // Don't throw - this is cleanup, shouldn't break the main flow
    } else {
      console.log(`[removeProcessingTag] Successfully removed 'ai_processing_active' tag`);
    }
  } catch (error: any) {
    // Log but don't throw - tag removal is best-effort cleanup
    console.error(`[removeProcessingTag] Error removing tag:`, error.message);
  }
}

/**
 * Remove the 'reprocess' tag from a ticket.
 * This prevents the webhook from re-triggering after processing completes.
 *
 * CRITICAL: This should be called at ALL exit points of the worker lambda,
 * including success, failure, and catch blocks.
 *
 * Uses dedicated DELETE /api/v2/tickets/{ticketId}/tags endpoint which removes
 * specified tags without affecting other tags.
 */
export async function removeReprocessTag(ticketId: number): Promise<void> {
  if (recordWrite({ fn: "removeReprocessTag", ticketId })) return;
  try {
    console.log(`[removeReprocessTag] Removing 'reprocess' tag from ticket ${ticketId}`);

    const resp = await zdFetch(`/api/v2/tickets/${ticketId}/tags.json`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tags: ['reprocess']
      })
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(`[removeReprocessTag] Failed to remove tag: ${resp.status} ${text}`);
      // Don't throw - this is cleanup, shouldn't break the main flow
    } else {
      console.log(`[removeReprocessTag] Successfully removed 'reprocess' tag`);
    }
  } catch (error: any) {
    // Log but don't throw - tag removal is best-effort cleanup
    console.error(`[removeReprocessTag] Error removing tag:`, error.message);
  }
}
