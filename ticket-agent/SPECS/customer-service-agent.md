# Customer-Service Agent Spec

Status: active. Covers the agent-first handling of non-PO support tickets, the
ticket-type taxonomy/tagging, the requester-authorization gate, the draft-reply
mechanism, and the verification harness. The deterministic PO pipeline is
unchanged and is invoked by the agent as a tool.

## 1. Architecture (agent-first)

`handler.ts → processTicketById` now:

1. `addProcessingTag` (unchanged).
2. `runCustomerServiceAgent(ticketContext)` (`src/agent/orchestrator.ts`) — a
   Claude (Opus 4.8, modular via `CSDROID_AGENT_MODEL`) tool-use loop
   (`src/agent/agentLoop.ts`, ported from RSG_AI_Tools).
3. `updateTicketWithResult` posts the result as a PRIVATE note (+ tags).
4. `finally`: remove processing/reprocess tags (unchanged).

The agent must call `classify_and_tag` first, then act per category, then call
`finalize_ticket` exactly once (or `run_po_pipeline`, which finalizes itself).
The terminal `FinalizeResult` maps onto the legacy `ProcessingResult`.

### The next action — THE central element

Classification/tags describe **what a ticket is**; `nextAction` is **what we do**,
and it is the most important output. Every ticket resolves to exactly one
explicit `nextAction` (`src/agent/types.ts`):

- **`draft_reply`** — a customer reply is drafted (privately) for a human to
  review & send (`draftReply` required).
- **`no_response_needed`** — tag only; nothing to send (spam, automated
  notifications, an already-resolved thread).
- **`escalate`** — a human must act (can't safely auto-handle, requester
  unverified, ambiguous, or no handler yet).

`finalize_ticket` requires `nextAction` + a one-sentence `actionReason`. The
internal note LEADS with it so a reviewer sees the decision at a glance:

```
🤖 AI Customer Service
PRIMARY INTENT: Cancellation Request (cancellation_request)
NEXT ACTION: ✍️ DRAFT REPLY — review & send the draft below
WHY: Order already shipped; drafted an "already shipped + tracking" reply.
Requester authorization: authorized
Also tagged (analytics): order_tracking
```

The outcome tag follows the action: `escalate → ai_alert_human_review_required`;
everything else → `ai_ready_for_human_review`. `nextAction` is carried on
`ProcessingResult.data.nextAction` and surfaced in the backtest report.

Tools (`src/agent/tools.ts`): `classify_and_tag`, `verify_requester_authorization`,
`lookup_order_tracking` (wraps `trackOrder`), `lookup_item_pricing` (modular,
`src/pricing-lookup.ts`), `get_item_info`, `lead_time_answer` (modular,
`src/lead-time.ts`), `check_customer_on_file` (new vs existing customer, via
`src/customer-lookup.ts`), `fulcrum_sales_request` (generic read-only Fulcrum for
the long tail / tracking fallback), `run_po_pipeline` (wraps the deterministic
`processPurchaseOrderWrapper`), `finalize_ticket`.

### Conversation context (`buildUserMessage` in `orchestrator.ts`)

The agent is given the FULL comment thread, oldest → newest, each line labeled
`CUSTOMER` vs `RSG (agent — context only)` (by `author_id` vs `requester.id`), so
it classifies the customer's actual request — including a later customer message
that changes it (e.g. a cancellation after a status update). It must NOT treat a
ticket as resolved just because RSG already replied. (Long threads keep the most
recent `MAX_THREAD_COMMENTS`.) This replaced an earlier bug where only the first
+ last comment were sent, so mid-thread customer intent was invisible.

## 2. Taxonomy & tagging (`src/ticket-categories.ts`)

Single source of truth. Every category declares its lowercase Zendesk tag,
`autoDraft`, `requiresAuthorization`, and `tagOnly`. Categories:
`purchase_order`, `order_tracking`, `cancellation_request`, `price_confirmation`,
`lead_time_request`, `expedite_request`, `shipment_on_hold`, `product_question`,
`product_issue`, `new_customer_inquiry`, `no_response_expected`, `spam`, `other`.
Aux tag `po_not_entered` co-occurs (e.g. an order-related request whose PO is not
in Fulcrum). Outcome tags `ai_ready_for_human_review` / `ai_alert_human_review_required`
are retained — analytics = type-tag × outcome-tag (`test-analytics.ts`).

The category tag is applied by `classify_and_tag` immediately, so analytics is
complete even if later steps fail.

**Multi-label tagging.** A ticket can be more than one type over its life, so the
agent applies a tag for EVERY type the thread exhibited — not just the latest. It
picks ONE primary category (latest actionable intent) for `classify_and_tag` and
the response, then lists the canonical tags of every OTHER category the thread
touched (plus aux tags like `po_not_entered`) in `finalize_ticket.additionalTags`.
Example: a thread that opens as a product question, becomes a new-customer
onboarding, then an order → primary may be the latest intent but the ticket also
carries `product_question` and `new_customer_inquiry`. Analytics is therefore a
set-membership query ("tickets that were EVER a new-customer inquiry").

### Agent learnings (`src/agent/learnings.ts`)

One-off, repeatable handling rules are kept in `AGENT_LEARNINGS` and injected into
the system prompt — the place to capture specific cases the agent keeps getting
wrong (e.g. "Potter 'Late Purchase Orders' notices from processing@pottersignal.com
are order-status requests, not no_response_expected"). Kept as a bundled TS string
(not a stray `.md`) so it always ships to Lambda. Add a bullet → it immediately
shapes behavior.

## 3. Authorization gate (`src/authorization.ts`)

`resolveRequesterAuthorization(email, opts)` → level `authorized | domain_match |
unknown`. Applied to any category touching a specific customer's data (PO,
tracking, cancellation, pricing); skipped for `new_customer_inquiry`. Sources, in
order: (1) the requester's domain matching a contact on the SPECIFIC order being
asked about (strongest, no extra config — the order lookup already exposes the
customer contact email); (2) the DynamoDB `customer-pricing-domains` table when
`CUSTOMER_PRICING_DOMAINS_TABLE` is set; (3) otherwise `unknown`. On `unknown`,
the agent must NOT disclose customer-specific data — it finalizes as `alert`.

**New vs existing customer** is a separate, lighter check: `check_customer_on_file`
(`src/customer-lookup.ts`) matches the requester's company name / email-domain core
against the Fulcrum catalog snapshot. Not on file (or a New Customer / credit
application attached) → `new_customer_inquiry` (flag for a manager). This is a
classification aid, not an identity gate.

## 4. Tone & draft mechanism

Drafts greet by first name, are polite/courteous/not over-the-top, plain text, no
emojis, signed "RSG Security Team" (`src/response-style.ts`, system prompt).

**Draft = a PRIVATE Zendesk internal note** (`public:false`). There is no reliable
Zendesk API for the agent-composer draft, so we never attempt it. The safety
chokepoint in `zendesk.ts` (`assertPrivateComment`) throws if any code path tries
to post a public comment — the system structurally cannot message a customer.

## 5. Verification harness (never sends to customers)

- **Dry-run kill-switch** (`src/dry-run.ts`, `CSDROID_DRY_RUN=1` / `setDryRun`):
  every mutating Zendesk call is suppressed + recorded. Read paths
  (`extractTicketContext`, `searchTicketIds`) are unaffected.
- **Classification-only mode** (`CSDROID_CLASSIFY_ONLY=1` / `setClassifyOnly`,
  enabled by `test:eval`): `run_po_pipeline` short-circuits — the agent still
  ROUTES a PO ticket to the pipeline (proving classification) but does NOT execute
  the real deterministic pipeline (PDF fetch + GPT-5 Vision extraction + Fulcrum
  match). The PO classification is decided at `classify_and_tag`; re-processing
  POs already in Fulcrum during a classification test would be pure cost/latency.
- `npm run test:safety` — asserts public comments throw and dry-run suppresses writes.
- `npm run test:eval [-- --limit N | all]` — runs the full agent over the
  hand-labeled golden set (`fixtures/golden-tickets.json`), prints accuracy +
  confusion matrix. Gate: ≥70%. **Multi-label scoring:** a fixture counts as
  correct if its expected category tag appears anywhere in the ticket's applied
  tag set (primary + additionalTags), matching how the analytics is queried.
- `npm run test:backtest [-- --limit N]` — runs the agent over recent
  Support-group tickets in dry-run; writes `reports/report.{jsonl,csv}`; asserts
  zero real writes.
- `npm run test:analytics` — read-only type × outcome tag report.
- Live-copy mode: the existing `createTicketCopy`/`closeTicketForTesting` pattern
  (disabled in dry-run) for a handful of full end-to-end runs.

## 6. Results & follow-ups

Full golden-set eval (`test:eval all`, multi-label scoring): **100% (27/27)** —
every fixture's expected type appears in the ticket's applied tags. The journey:
70.4% → 88.9% (single-label) → 100% (multi-label), driven by three fixes:
1. **Full-thread context** — the agent now sees the whole conversation; mid-thread
   customer intent (e.g. 34110's "I submitted a cancel") is no longer invisible.
2. **Agent learnings** (`learnings.ts`) — e.g. Potter "Late Purchase Orders" notices
   classify as `order_tracking`, not `no_response_expected`.
3. **Multi-label tagging** — a thread that evolved (34150 lead-time→order;
   33457 product-question→new-customer) carries every type it touched.

Caveats / follow-ups:
- 40-ticket dry-run backtest: 0 errors, 0 writes; cancellation-with-shipped-check,
  price-with-authorization, and unverified→escalate-no-disclosure confirmed.
- `po_not_entered` aux recall 0/2 is a fixture-staleness artifact: 34243/34185's
  POs are now live in Fulcrum (entered after the original ticket), so the agent
  reads current state and correctly does not flag them. The tag still fires when a
  referenced PO is genuinely absent.
- The golden labels capture each ticket's primary/opening intent; the eval feeds
  fully-resolved historical threads, so a "primary=" prediction may reflect the
  thread's end-state while the expected type is carried as a secondary tag (e.g.
  34150 primary `order_tracking`, expected `lead_time_request` present in tags).
  Verified separately that on the bare opening inbound, 34150 → `lead_time_request`
  and 33457 → `product_question`.
- Tune-ups still worthwhile: keep adding real misses to the golden set; wire
  `CUSTOMER_PRICING_DOMAINS_TABLE` for full domain-based authorization (today,
  order-tied contact matching is the primary path); reconcile `findSalesOrdersByPO`
  batch cap vs deep paging (cf. 34177).
