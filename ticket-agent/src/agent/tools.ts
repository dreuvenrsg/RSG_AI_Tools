// src/agent/tools.ts
// The customer-service agent's tool registry. Each tool wraps an existing,
// tested primitive (order tracking, pricing, lead-time, authorization, the
// deterministic PO pipeline) behind a small Anthropic tool definition.

import type { AgentTool, AgentContext, FinalizeResult } from "./types";
import { CATEGORIES, toCategoryKey } from "../ticket-categories";
import { addTags } from "../zendesk";
import { resolveRequesterAuthorization } from "../authorization";
import { trackOrder } from "../order-tracking";
import { lookupItemPrice } from "../pricing-lookup";
import { resolveLeadTime } from "../lead-time";
import { findCustomerOnFile } from "../customer-lookup";
import { fetchFulcrumData } from "../s3";
import { isClassifyOnly } from "../dry-run";
import { processPurchaseOrderWrapper } from "../routing";
import { fitForModel } from "./fulcrumClient";
import type { ProcessingResult } from "../types";

const CATEGORY_ENUM = Object.keys(CATEGORIES);

// 1) classify_and_tag — must be called first; records type + tags for analytics.
const classifyAndTag: AgentTool = {
  definition: {
    name: "classify_and_tag",
    description:
      "Record the ticket's single best category and tag it. Call this FIRST, before any other tool. The tag is applied immediately so the ticket-type analytics is complete even if later steps fail.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: CATEGORY_ENUM, description: "The single best category for this ticket." },
        reasoning: { type: "string", description: "One or two sentences explaining the choice." },
        poNumbers: { type: "array", items: { type: "string" }, description: "Any PO/order numbers referenced." },
        confidence: { type: "number", description: "0.0–1.0 confidence in the classification." },
      },
      required: ["category", "reasoning"],
    },
  },
  async run(input, ctx: AgentContext) {
    const category = toCategoryKey(input.category);
    ctx.category = category;
    const def = CATEGORIES[category];
    await addTags(ctx.ticket.ticketId, [def.tag]);
    return {
      ok: true,
      category,
      tagApplied: def.tag,
      autoDraft: def.autoDraft,
      requiresAuthorization: def.requiresAuthorization,
      tagOnly: def.tagOnly,
      guidance: def.description,
    };
  },
};

// 2) verify_requester_authorization — the generalized identity gate.
const verifyAuthorization: AgentTool = {
  definition: {
    name: "verify_requester_authorization",
    description:
      "Verify whether the ticket requester is associated with the customer whose data the request concerns. Pass knownCustomerEmails (e.g. the contact/billing emails from the order you looked up) for the strongest check. Returns level: 'authorized' | 'domain_match' | 'unknown'. Never disclose customer-specific data when level is 'unknown'.",
    input_schema: {
      type: "object",
      properties: {
        knownCustomerEmails: {
          type: "array",
          items: { type: "string" },
          description: "Contact/billing emails known to belong to the customer this request is about.",
        },
        knownCustomerId: { type: "string" },
        knownCustomerName: { type: "string" },
        knownTierId: { type: "string" },
      },
    },
  },
  async run(input, ctx: AgentContext) {
    const result = await resolveRequesterAuthorization(ctx.ticket.requester.email, {
      knownCustomerEmails: input.knownCustomerEmails,
      knownCustomerId: input.knownCustomerId,
      knownCustomerName: input.knownCustomerName,
      knownTierId: input.knownTierId,
    });
    ctx.authorization = result.level;
    return result;
  },
};

// 3) lookup_order_tracking — wraps trackOrder; exposes customer contact for auth.
const lookupOrderTracking: AgentTool = {
  definition: {
    name: "lookup_order_tracking",
    description:
      "Look up an order in Fulcrum by its customer PO number and return shipment/tracking status. status NOT_FOUND means the PO is not in Fulcrum (consider the po_not_entered tag). The result includes the order's customer contact email — pass it to verify_requester_authorization.",
    input_schema: {
      type: "object",
      properties: {
        poNumber: { type: "string", description: "The customer PO / order number to look up." },
      },
      required: ["poNumber"],
    },
  },
  async run(input, _ctx: AgentContext) {
    const r = await trackOrder(String(input.poNumber));
    if (r.status === "NOT_FOUND" || !r.salesOrder) {
      return { status: "NOT_FOUND", poNumber: input.poNumber, note: "No matching sales order found in Fulcrum." };
    }
    return {
      status: r.status,
      poNumber: input.poNumber,
      salesOrderNumber: r.salesOrder.number,
      customerId: r.salesOrder.customerId,
      customerContactEmail: r.salesOrder.billingAddress?.email || null,
      scheduledDeliveryDate: r.scheduledDeliveryDate || null,
      shippedShipments: r.trackingInfo.map((t) => ({
        shipment: t.shipmentName,
        trackingNumber: t.trackingNumber,
        trackingUrl: t.trackingUrl,
        shippedDate: t.shippedDate,
      })),
      pendingShipmentCount: r.pendingShipments.length,
    };
  },
};

// 4) lookup_item_pricing — tier pricing from the catalog (modular).
const lookupPricing: AgentTool = {
  definition: {
    name: "lookup_item_pricing",
    description:
      "Look up an item's price from the Fulcrum catalog. Provide a tierId/tierName (from authorization) and quantity to get the tier/quantity price; otherwise returns base price and the available tiers. Only disclose pricing after authorization is 'authorized' or 'domain_match'.",
    input_schema: {
      type: "object",
      properties: {
        itemNumber: { type: "string" },
        tierId: { type: "string" },
        tierName: { type: "string" },
        quantity: { type: "number" },
      },
      required: ["itemNumber"],
    },
  },
  async run(input, _ctx: AgentContext) {
    return lookupItemPrice({
      itemNumber: String(input.itemNumber),
      tierId: input.tierId ?? null,
      tierName: input.tierName ?? null,
      quantity: input.quantity ?? null,
    });
  },
};

// 5) get_item_info — description/specs lookup from the catalog.
const getItemInfo: AgentTool = {
  definition: {
    name: "get_item_info",
    description: "Get an item's number and description from the Fulcrum catalog by item number.",
    input_schema: {
      type: "object",
      properties: { itemNumber: { type: "string" } },
      required: ["itemNumber"],
    },
  },
  async run(input, _ctx: AgentContext) {
    const catalog = await fetchFulcrumData();
    const items = catalog.SellableItems?.itemsByNumber || {};
    const target = String(input.itemNumber).trim().toUpperCase();
    const key = Object.keys(items).find((k) => k.trim().toUpperCase() === target);
    if (!key) return { found: false, itemNumber: input.itemNumber };
    const it = items[key];
    return { found: true, itemNumber: it.number, description: it.description };
  },
};

// 6) lead_time_answer — modular lead-time resolution.
const leadTimeAnswer: AgentTool = {
  definition: {
    name: "lead_time_answer",
    description:
      "Resolve the appropriate lead-time wording for a lead-time/availability request. Door-holder / extension-rod items have a standard answer; other items return hasStandardAnswer=false (escalate).",
    input_schema: {
      type: "object",
      properties: {
        itemNumbers: { type: "array", items: { type: "string" } },
      },
    },
  },
  async run(input, ctx: AgentContext) {
    const text = `${ctx.ticket.subject}\n${ctx.ticket.description}`;
    return resolveLeadTime({ itemNumbers: input.itemNumbers, text });
  },
};

// 7) run_po_pipeline — the deterministic PO processor, as a tool. Terminal.
const runPoPipeline: AgentTool = {
  definition: {
    name: "run_po_pipeline",
    description:
      "Run the deterministic purchase-order pipeline on this ticket (PDF extraction → Fulcrum match → attach parsed JSON → set po_status). Use this when the ticket is a NEW purchase order. This finalizes the ticket; do not call finalize_ticket afterward.",
    input_schema: { type: "object", properties: {} },
  },
  async run(_input, ctx: AgentContext) {
    // Classification-only (eval) mode: prove the routing without executing the
    // real pipeline. The PO is already (or will be) in Fulcrum — no need to
    // re-run GPT-5 Vision extraction during a classification test.
    if (isClassifyOnly()) {
      ctx.finalize = {
        category: "PURCHASE_ORDER",
        nextAction: "draft_reply",
        actionReason: "Classification-only mode: routed to the deterministic PO pipeline (not executed).",
        draftReply: null,
        internalNote: "PO ticket — would run the deterministic PO pipeline (skipped in classification-only mode).",
        additionalTags: ["ready_to_review"],
      };
      return { ok: true, finalized: true, classifyOnly: true, note: "PO pipeline skipped (classification-only mode)." };
    }
    const result: ProcessingResult = await processPurchaseOrderWrapper(ctx.ticket, {
      intent: "PURCHASE_ORDER",
      confidence: 1,
      reasoning: "Agent routed ticket to the deterministic PO pipeline.",
    });
    const ok = result.success && !result.requiresHumanReview;
    const finalize: FinalizeResult = {
      category: "PURCHASE_ORDER",
      nextAction: ok ? "draft_reply" : "escalate",
      actionReason: ok
        ? "PO parsed and staged; acknowledgement drafted for review."
        : "PO pipeline needs human review.",
      draftReply: result.publicResponse ?? null,
      internalNote: result.internalNote,
      additionalTags: result.additionalTags || [],
    };
    ctx.finalize = finalize;
    return {
      ok: true,
      finalized: true,
      nextAction: finalize.nextAction,
      poProcessed: result.success,
      note: "PO pipeline complete and ticket finalized. Stop here.",
    };
  },
};

// 7a) check_customer_on_file — distinguishes a NEW customer from an existing one.
const checkCustomerOnFile: AgentTool = {
  definition: {
    name: "check_customer_on_file",
    description:
      "Check whether the requester's company is an existing RSG customer in Fulcrum (by company name and/or the requester's email domain). Use this to tell a NEW customer from an existing one — e.g. before finalizing a general inquiry / product question, or when a new-customer or credit application is attached. If onFile is false, the ticket is likely a NEW_CUSTOMER_INQUIRY.",
    input_schema: {
      type: "object",
      properties: {
        companyName: { type: "string", description: "The company name as it appears in the ticket/signature." },
      },
    },
  },
  async run(input, ctx: AgentContext) {
    return findCustomerOnFile({ companyName: input.companyName, email: ctx.ticket.requester.email });
  },
};

// 7b) fulcrum_sales_request — generic READ-ONLY Fulcrum access for the long
// tail (customer lookups, order/shipment detail the wrapped tools don't cover,
// and a fallback when lookup_order_tracking misses). Read-only is enforced by
// the client (GET + POST .../list only).
const fulcrumSalesRequest: AgentTool = {
  definition: {
    name: "fulcrum_sales_request",
    description:
      "Make a READ-ONLY Fulcrum ERP request for sales/customer/shipping data the other tools don't cover. " +
      "Conventions: search is POST /<entity>/list?Skip=<n>&Take=<n> (Take caps at 50) with an optional JSON " +
      "filter body; details are GET /<entity>/{id}. Useful endpoints: POST /sales-orders/list, " +
      "POST /customers/list, GET /customers/{id}, POST /shipments/list (trackingNumber lives here), " +
      "POST /sales-orders/{id}/part-line-items/list, POST /quotes/list. Only GET and POST .../list are allowed.",
    input_schema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST"] },
        endpoint: { type: "string", description: "Path under /api, e.g. /customers/list?Skip=0&Take=20" },
        body: { type: "object", description: "JSON filter body for POST /list requests" },
      },
      required: ["method", "endpoint"],
    },
  },
  async run(input, ctx: AgentContext) {
    const data = await ctx.fulcrum.request(input.method, input.endpoint, input.body || null);
    return fitForModel(data);
  },
};

// 8) finalize_ticket — terminal structured output for all non-PO categories.
const finalizeTicket: AgentTool = {
  definition: {
    name: "finalize_ticket",
    description:
      "Finalize the ticket. Call EXACTLY ONCE as your last action (except when you used run_po_pipeline). The CENTRAL field is nextAction — be explicit about what happens next. Also give the primary category, a one-sentence actionReason, the internal note, the draft reply (only when nextAction is draft_reply), and the multi-label additionalTags.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: CATEGORY_ENUM,
          description: "The PRIMARY actionable intent — the one category that drives the next action.",
        },
        nextAction: {
          type: "string",
          enum: ["draft_reply", "no_response_needed", "escalate"],
          description:
            "THE central decision. draft_reply = you wrote a customer reply for a human to review & send. no_response_needed = tag only, nothing to send (spam, notifications, already-resolved). escalate = a human must act (can't auto-handle, requester unverified, ambiguous).",
        },
        actionReason: {
          type: "string",
          description: "One sentence explaining why this next action (shown to the human reviewer).",
        },
        draftReply: {
          type: ["string", "null"],
          description: "REQUIRED when nextAction is draft_reply: the internal DRAFT customer reply (first-name greeting, polite, signed RSG Security Team). Null otherwise.",
        },
        internalNote: { type: "string", description: "Internal explanation/summary for the agent." },
        additionalTags: {
          type: "array",
          items: { type: "string" },
          description:
            "Canonical lowercase tags for EVERY OTHER category this thread exhibited at any point (multi-label), plus aux tags like po_not_entered. E.g. a thread that was a new-customer onboarding and a product question → ['new_customer_inquiry','product_question']. Analytics only — does not change the next action.",
        },
      },
      required: ["category", "nextAction", "actionReason", "internalNote"],
    },
  },
  async run(input, ctx: AgentContext) {
    const category = toCategoryKey(input.category);
    const nextAction: FinalizeResult["nextAction"] =
      input.nextAction === "draft_reply" || input.nextAction === "no_response_needed"
        ? input.nextAction
        : "escalate";
    const finalize: FinalizeResult = {
      category,
      nextAction,
      actionReason: input.actionReason ? String(input.actionReason) : undefined,
      draftReply: nextAction === "draft_reply" ? input.draftReply ?? null : null,
      internalNote: String(input.internalNote || ""),
      additionalTags: Array.isArray(input.additionalTags) ? input.additionalTags : [],
      authorizationLevel: ctx.authorization,
    };
    ctx.finalize = finalize;
    return { ok: true, finalized: true, category, nextAction };
  },
};

export const AGENT_TOOLS: AgentTool[] = [
  classifyAndTag,
  verifyAuthorization,
  lookupOrderTracking,
  lookupPricing,
  getItemInfo,
  leadTimeAnswer,
  checkCustomerOnFile,
  fulcrumSalesRequest,
  runPoPipeline,
  finalizeTicket,
];
