// src/agent/types.ts
// Shared types for the customer-service Claude agent.

import type { TicketContext } from "../types";
import type { CategoryKey } from "../ticket-categories";
import type { AuthLevel } from "../authorization";
import type { FulcrumReadClient } from "./fulcrumClient";

/** A tool the agent can call: an Anthropic tool definition + an async handler. */
export interface AgentTool {
  definition: {
    name: string;
    description: string;
    input_schema: Record<string, any>;
  };
  run(input: any, ctx: AgentContext): Promise<any>;
}

/** Mutable context handed to every tool during a run. */
export interface AgentContext {
  ticket: TicketContext;
  fulcrum: FulcrumReadClient;
  /** Set by classify_and_tag so later steps/orchestrator know the category. */
  category?: CategoryKey;
  /** Set by finalize_ticket — the terminal structured result. */
  finalize?: FinalizeResult;
  /** Accumulated authorization result, if resolved during the run. */
  authorization?: AuthLevel;
}

/**
 * THE central decision: what should happen next with this ticket.
 * - draft_reply       — a customer reply is drafted (privately) for a human to review & send.
 * - no_response_needed — tag only; nothing to send (spam, notifications, resolved threads).
 * - escalate          — a human must act (can't auto-handle, unverified requester, ambiguous, etc.).
 */
export type NextAction = "draft_reply" | "no_response_needed" | "escalate";

/**
 * The agent's terminal structured output (via the finalize_ticket tool).
 * Maps directly onto the legacy ProcessingResult for the Zendesk write layer.
 */
export interface FinalizeResult {
  /** Primary actionable intent — the one category that drives the NEXT ACTION. */
  category: CategoryKey;
  /** THE central decision: what we do next with this ticket. */
  nextAction: NextAction;
  /** One sentence: why this next action (shown to the human reviewer). */
  actionReason?: string;
  /** Draft customer reply (posted PRIVATELY). Required for draft_reply, null otherwise. */
  draftReply?: string | null;
  /** Internal explanation/summary for the agent reviewing the ticket. */
  internalNote: string;
  /** All OTHER type tags the thread exhibited (multi-label) + aux tags — analytics only. */
  additionalTags?: string[];
  authorizationLevel?: AuthLevel;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: any }
  | { type: "tool_result"; name: string; ok: boolean; error?: string }
  | { type: "done"; stopReason: string | null }
  | { type: "error"; error: string };

export interface AgentTurnResult {
  finalize: FinalizeResult | null;
  stopReason: string | null;
  toolCalls: Array<{ name: string; input: any; ok: boolean; error?: string }>;
  iterations: number;
}
