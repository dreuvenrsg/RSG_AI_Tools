// src/ticket-categories.ts
// Single source of truth for the customer-service ticket taxonomy.
//
// Every category declares: its canonical (lowercased) Zendesk tag, whether the
// AI should draft an internal reply for it, whether handling it requires
// resolving the requester's authorization to a customer, and a one-line
// description used both in the classifier system prompt and in analytics.
//
// This registry drives classification, tagging, agent routing, and the
// type x outcome analytics. Add a category here and it flows everywhere.

export type CategoryKey =
  | "PURCHASE_ORDER"
  | "ORDER_TRACKING"
  | "CANCELLATION_REQUEST"
  | "PRICE_CONFIRMATION"
  | "LEAD_TIME_REQUEST"
  | "EXPEDITE_REQUEST"
  | "SHIPMENT_ON_HOLD"
  | "PRODUCT_QUESTION"
  | "PRODUCT_ISSUE"
  | "NEW_CUSTOMER_INQUIRY"
  | "NO_RESPONSE_EXPECTED"
  | "SPAM"
  | "OTHER";

export interface CategoryDef {
  key: CategoryKey;
  /** Canonical lowercased Zendesk tag (Zendesk lowercases tags anyway). */
  tag: string;
  label: string;
  /** One-line guidance shown to the classifier and used in analytics. */
  description: string;
  /** Whether the agent should draft an internal customer reply for this type. */
  autoDraft: boolean;
  /**
   * Whether handling this type touches a specific customer's data (orders,
   * pricing, shipments) and therefore requires resolving the requester's
   * authorization before disclosing anything. New-customer inquiries are
   * intentionally false.
   */
  requiresAuthorization: boolean;
  /**
   * Tag-only categories: the agent records the type + a short internal note and
   * escalates to a human instead of drafting a customer reply.
   */
  tagOnly: boolean;
}

export const CATEGORIES: Record<CategoryKey, CategoryDef> = {
  PURCHASE_ORDER: {
    key: "PURCHASE_ORDER",
    tag: "purchase_order",
    label: "Purchase Order",
    description:
      "Customer is submitting a NEW purchase order (usually a PDF attachment) to be entered. Handled by the deterministic PO pipeline.",
    autoDraft: true, // the PO pipeline produces its own acknowledgement draft
    requiresAuthorization: true,
    tagOnly: false,
  },
  ORDER_TRACKING: {
    key: "ORDER_TRACKING",
    tag: "order_tracking",
    label: "Order Tracking",
    description:
      "Customer is asking about the status/shipment/tracking of an EXISTING order (by PO or order number), in any format.",
    autoDraft: true,
    requiresAuthorization: true,
    tagOnly: false,
  },
  CANCELLATION_REQUEST: {
    key: "CANCELLATION_REQUEST",
    tag: "cancellation_request",
    label: "Cancellation Request",
    description:
      "Customer wants to cancel an order/PO. Look up the PO: if already shipped, politely say so and provide tracking; otherwise escalate for the cancellation to be actioned.",
    autoDraft: true,
    requiresAuthorization: true,
    tagOnly: false,
  },
  PRICE_CONFIRMATION: {
    key: "PRICE_CONFIRMATION",
    tag: "price_confirmation",
    label: "Price Confirmation / Quote",
    description:
      "Customer is asking to confirm pricing or get a quote for one or more items. Verify the requester is authorized for the customer, then look up tier pricing.",
    autoDraft: true,
    requiresAuthorization: true,
    tagOnly: false,
  },
  LEAD_TIME_REQUEST: {
    key: "LEAD_TIME_REQUEST",
    tag: "lead_time_request",
    label: "Lead Time / Availability",
    description:
      "Customer is asking about lead time, availability, or stock for products (not tied to a specific existing order). For door-holder items / extension rods there is a standard reply.",
    autoDraft: true,
    requiresAuthorization: false,
    tagOnly: false,
  },
  EXPEDITE_REQUEST: {
    key: "EXPEDITE_REQUEST",
    tag: "expedite_request",
    label: "Expedite Request",
    description:
      "Customer (or their expediting team) is asking to speed up / pull in an existing order. Tag and escalate for a human to action with operations.",
    autoDraft: false,
    requiresAuthorization: true,
    tagOnly: true,
  },
  SHIPMENT_ON_HOLD: {
    key: "SHIPMENT_ON_HOLD",
    tag: "shipment_on_hold",
    label: "Shipment On Hold",
    description:
      "A carrier (e.g. UPS/FedEx) reports a shipment is on hold and needs a response, or the customer asks to hold a shipment. Tag and escalate.",
    autoDraft: false,
    requiresAuthorization: true,
    tagOnly: true,
  },
  PRODUCT_QUESTION: {
    key: "PRODUCT_QUESTION",
    tag: "product_question",
    label: "Product Question",
    description:
      "General questions about product specs, datasheets, configuration, or documentation (not pricing, not an order). Tag and escalate for now.",
    autoDraft: false,
    requiresAuthorization: false,
    tagOnly: true,
  },
  PRODUCT_ISSUE: {
    key: "PRODUCT_ISSUE",
    tag: "product_issue",
    label: "Product Issue",
    description:
      "Customer reports a defective/damaged/malfunctioning product, a return, warranty, or RMA. Tag and escalate.",
    autoDraft: false,
    requiresAuthorization: false,
    tagOnly: true,
  },
  NEW_CUSTOMER_INQUIRY: {
    key: "NEW_CUSTOMER_INQUIRY",
    tag: "new_customer_inquiry",
    label: "New Customer Inquiry",
    description:
      "An inquiry from someone whose company is NOT an existing customer on file (no domain/company match). Do NOT run the authorization gate; flag for a manager.",
    autoDraft: false,
    requiresAuthorization: false,
    tagOnly: true,
  },
  NO_RESPONSE_EXPECTED: {
    key: "NO_RESPONSE_EXPECTED",
    tag: "no_response_expected",
    label: "No Response Expected",
    description:
      "Automated notifications/confirmations needing no reply: carrier confirmations, verification codes, order-confirmation receipts, 'reminder of non-shipped orders', system emails. Tag + private note, no reply.",
    autoDraft: false,
    requiresAuthorization: false,
    tagOnly: true,
  },
  SPAM: {
    key: "SPAM",
    tag: "spam",
    label: "Spam",
    description:
      "Unsolicited marketing / phishing / irrelevant solicitation (SEO, web design, loans, etc.). Tag + private note, no reply.",
    autoDraft: false,
    requiresAuthorization: false,
    tagOnly: true,
  },
  OTHER: {
    key: "OTHER",
    tag: "other",
    label: "Other / Unclassified",
    description:
      "Does not fit any category above, or is ambiguous. Tag and escalate for a human.",
    autoDraft: false,
    requiresAuthorization: false,
    tagOnly: true,
  },
};

export const CATEGORY_KEYS = Object.keys(CATEGORIES) as CategoryKey[];

/**
 * Auxiliary (co-occurring) tags that are NOT a primary category. These layer on
 * top of a category — e.g. a cancellation whose PO was never entered in Fulcrum
 * is `cancellation_request` + `po_not_entered`.
 */
export const AUX_TAGS = {
  /** Order-related request whose PO is not (yet) in Fulcrum at processing time. */
  PO_NOT_ENTERED: "po_not_entered",
} as const;

/** Outcome tags retained for the type x outcome analytics. */
export const OUTCOME_TAGS = {
  READY: "ai_ready_for_human_review",
  ALERT: "ai_alert_human_review_required",
} as const;

export function getCategory(key: CategoryKey): CategoryDef {
  return CATEGORIES[key] ?? CATEGORIES.OTHER;
}

/** Normalize an arbitrary string to a known CategoryKey, falling back to OTHER. */
export function toCategoryKey(value: string | null | undefined): CategoryKey {
  if (!value) return "OTHER";
  const upper = value.trim().toUpperCase();
  return (CATEGORY_KEYS as string[]).includes(upper) ? (upper as CategoryKey) : "OTHER";
}

/** Compact catalog block for the classifier/agent system prompt. */
export function categoryCatalogForPrompt(): string {
  return CATEGORY_KEYS.map((k) => {
    const c = CATEGORIES[k];
    const flags = [
      c.autoDraft ? "drafts-reply" : "tag-only",
      c.requiresAuthorization ? "needs-auth" : "no-auth",
    ].join(", ");
    return `- ${c.key} (tag: ${c.tag}) [${flags}]: ${c.description}`;
  }).join("\n");
}
