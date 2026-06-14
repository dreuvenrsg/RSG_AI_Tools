// src/agent/orchestrator.ts
// Drives the customer-service Claude agent for a single ticket and maps its
// structured finalize output onto the legacy ProcessingResult the Zendesk write
// layer expects.

import type { TicketContext, ProcessingResult } from "../types";
import { CATEGORIES } from "../ticket-categories";
import { resolveAnthropicClient, runAgentTurn } from "./agentLoop";
import { buildSystemPrompt } from "./systemPrompt";
import { AGENT_TOOLS } from "./tools";
import { FulcrumReadClient } from "./fulcrumClient";
import type { AgentContext, AgentEvent, AgentTurnResult, FinalizeResult } from "./types";

export interface AgentRunOutcome {
  result: ProcessingResult;
  turn: AgentTurnResult;
}

const MAX_THREAD_COMMENTS = 16;
const MAX_COMMENT_CHARS = 1400;

/** Build the textual user message describing the ticket for the agent. */
function buildUserMessage(ticket: TicketContext): string {
  const attachments = ticket.comments
    .flatMap((c) => c.attachments)
    .map((a) => `${a.filename} (${a.content_type})`);
  const poStatusField = ticket.customFields.find((f) => String(f.value || "").length > 0 && typeof f.value === "string");

  // Full conversation, oldest → newest, labeled by author. The CUSTOMER's
  // messages are what we classify and respond to; RSG's own prior replies are
  // context only. Keep the most recent comments if the thread is long.
  const comments = ticket.comments.slice(-MAX_THREAD_COMMENTS);
  const omitted = ticket.comments.length - comments.length;
  const thread = comments
    .map((c, i) => {
      const who = c.author_id === ticket.requester.id ? "CUSTOMER" : "RSG (agent — context only)";
      const vis = c.public ? "" : " [internal note]";
      const body = (c.plain_body || c.body || "").replace(/\s+/g, " ").trim().slice(0, MAX_COMMENT_CHARS);
      return `[${i + 1 + omitted}] ${who}${vis}: ${body}`;
    })
    .join("\n\n");

  return [
    `TICKET #${ticket.ticketId}`,
    `Requester (the CUSTOMER): ${ticket.requester.name || "(unknown)"} <${ticket.requester.email || "(no email)"}>`,
    `Existing tags: ${ticket.tags.join(", ") || "(none)"}`,
    `Attachments: ${attachments.length ? attachments.join("; ") : "(none)"}`,
    poStatusField ? `po_status custom field: ${poStatusField.value}` : "",
    "",
    `SUBJECT: ${ticket.subject}`,
    "",
    omitted > 0 ? `CONVERSATION (oldest → newest; ${omitted} earlier comment(s) omitted):` : "CONVERSATION (oldest → newest):",
    thread,
    "",
    "Classify and handle based on what the CUSTOMER is asking for — read the WHOLE thread (a later customer message may change the request, e.g. a cancellation after a status update). Treat RSG's own replies as context only. Drafts are internal only.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

const ACTION_LABEL: Record<FinalizeResult["nextAction"], string> = {
  draft_reply: "✍️ DRAFT REPLY — review & send the draft below",
  no_response_needed: "🟡 NO RESPONSE NEEDED — tagged; nothing to send",
  escalate: "⛔ ESCALATE — a human needs to act",
};

function buildInternalNote(finalize: FinalizeResult): string {
  const cat = CATEGORIES[finalize.category];
  const otherTags = (finalize.additionalTags || []).filter((t) => t !== cat.tag);
  // Lead with the central decision so a reviewer sees what the AI is doing at a glance.
  const lines = [
    `🤖 AI Customer Service`,
    `PRIMARY INTENT: ${cat.label} (${cat.tag})`,
    `NEXT ACTION: ${ACTION_LABEL[finalize.nextAction]}`,
    finalize.actionReason ? `WHY: ${finalize.actionReason}` : "",
    finalize.authorizationLevel ? `Requester authorization: ${finalize.authorizationLevel}` : "",
    otherTags.length ? `Also tagged (analytics): ${otherTags.join(", ")}` : "",
    "",
    finalize.internalNote,
  ].filter(Boolean);
  return lines.join("\n");
}

function toProcessingResult(finalize: FinalizeResult): ProcessingResult {
  const catTag = CATEGORIES[finalize.category].tag;
  const tags = Array.from(new Set([catTag, ...(finalize.additionalTags || [])]));
  // The outcome tag follows the NEXT ACTION: only an escalation needs a human to act.
  const needsHuman = finalize.nextAction === "escalate";
  return {
    success: !needsHuman,
    requiresHumanReview: needsHuman,
    reason: `${finalize.category} → ${finalize.nextAction}`,
    tag: needsHuman ? "AI_ALERT_HUMAN_REVIEW_REQUIRED" : "AI_READY_FOR_HUMAN_REVIEW",
    internalNote: buildInternalNote(finalize),
    publicResponse: finalize.nextAction === "draft_reply" ? finalize.draftReply ?? null : null,
    additionalTags: tags,
    data: {
      category: finalize.category,
      nextAction: finalize.nextAction,
      authorizationLevel: finalize.authorizationLevel,
    },
  };
}

/** Fallback when the agent never produced a finalize (error / max iterations). */
function fallbackResult(turn: AgentTurnResult, ctx: AgentContext): ProcessingResult {
  const cat = ctx.category ? CATEGORIES[ctx.category] : null;
  const tags = cat ? [cat.tag] : [];
  return {
    success: false,
    requiresHumanReview: true,
    reason: `Agent did not finalize (stopReason: ${turn.stopReason})`,
    tag: "AI_ALERT_HUMAN_REVIEW_REQUIRED",
    internalNote: `🤖 AI Customer Service — could not complete\n\nThe agent stopped without finalizing (stopReason: ${turn.stopReason}, iterations: ${turn.iterations}). Please handle manually.`,
    additionalTags: tags,
  };
}

/**
 * Run the customer-service agent for a ticket. Performs NO Zendesk write itself
 * beyond what the tools do (classify_and_tag applies the type tag; run_po_pipeline
 * writes the PO artifacts) — the caller posts the returned ProcessingResult.
 */
export async function runCustomerServiceAgent(
  ticket: TicketContext,
  onEvent: (e: AgentEvent) => void = () => {}
): Promise<AgentRunOutcome> {
  const client = await resolveAnthropicClient();
  const fulcrum = FulcrumReadClient.create();
  const ctx: AgentContext = { ticket, fulcrum };

  const turn = await runAgentTurn({
    client,
    system: buildSystemPrompt(ticket),
    messages: [{ role: "user", content: buildUserMessage(ticket) }],
    tools: AGENT_TOOLS,
    ctx,
    onEvent,
  });

  const result = turn.finalize ? toProcessingResult(turn.finalize) : fallbackResult(turn, ctx);
  return { result, turn };
}
