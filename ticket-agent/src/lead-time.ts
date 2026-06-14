// src/lead-time.ts
// Modular lead-time resolution. Today this is a simple rules table (door-holder
// / extension-rod items get the standard reply); the interface is deliberately
// narrow so it can later be backed by a smarter source (live availability,
// per-SKU lead times) without touching callers.

import {
  DOOR_HOLDER_SKU_PREFIXES,
  DOOR_HOLDER_KEYWORDS,
  STANDARD_DOOR_HOLDER_LEAD_TIME,
} from "./config";

export interface LeadTimeQuery {
  itemNumbers?: string[];
  /** Free text (subject + body) used for keyword detection. */
  text?: string;
}

export interface LeadTimeResult {
  isDoorHolder: boolean;
  leadTime: string;
  /** True when we have a confident standard answer; false → escalate to a human. */
  hasStandardAnswer: boolean;
  /** Suggested reply body (greeting + signature added by caller/agent). */
  replyBody: string;
  reason: string;
}

function looksLikeDoorHolder(query: LeadTimeQuery): boolean {
  const skuHit = (query.itemNumbers || []).some((n) =>
    DOOR_HOLDER_SKU_PREFIXES.some((p) => n.trim().toUpperCase().startsWith(p))
  );
  const text = (query.text || "").toLowerCase();
  const kwHit = DOOR_HOLDER_KEYWORDS.some((k) => text.includes(k));
  return skuHit || kwHit;
}

export function resolveLeadTime(query: LeadTimeQuery): LeadTimeResult {
  if (looksLikeDoorHolder(query)) {
    return {
      isDoorHolder: true,
      leadTime: STANDARD_DOOR_HOLDER_LEAD_TIME,
      hasStandardAnswer: true,
      replyBody:
        `Our standard lead time for door holder items is ${STANDARD_DOOR_HOLDER_LEAD_TIME} but if needed sooner, ` +
        `we can expedite the order. Please note the required date on the purchase order when it is submitted.\n\n` +
        `Reach out to us if you have any questions; we are happy to help.`,
      reason: "Matched door-holder / extension-rod rule.",
    };
  }
  return {
    isDoorHolder: false,
    leadTime: "",
    hasStandardAnswer: false,
    replyBody: "",
    reason:
      "No standard lead-time rule matched (not a door-holder/extension-rod item). Escalate for a human to confirm availability.",
  };
}
