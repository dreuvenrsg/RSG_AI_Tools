# CSDroid Local Instructions

Read this file before changing the repo. Use the local operating rules below, the inherited architecture reference later in this file, [LEARNINGS.md](/Users/dreuven/Projects/RSG/CSDroid/LEARNINGS.md) for accumulated ticket-specific lessons, [index.md](/Users/dreuven/Projects/RSG/CSDroid/index.md) for the file map, and the relevant spec in [SPECS/README.md](/Users/dreuven/Projects/RSG/CSDroid/SPECS/README.md) before materially changing behavior.

## Workflow rules

- Keep changes primitive-driven. The preferred verification ladder is:
  1. read the Zendesk ticket contents,
  2. download and inspect the real attachment,
  3. validate Fulcrum lookup behavior for the extracted identifiers,
  4. run a controlled ticket-copy validation flow,
  5. verify the resulting ticket note and generated attachment.
- When a live ticket is already closed or should not be mutated directly, create a clearly labeled copy, work only on the copy, and always close that copy in a `finally` path even if processing fails.
- Validation copies must be distinguishable in Zendesk. Prefix the subject so agents can immediately recognize them as disposable test tickets.
- Do not leave ambiguous validation tickets open in the queue.
- When you discover a repeatable ticket pattern or failure mode, record it in [LEARNINGS.md](/Users/dreuven/Projects/RSG/CSDroid/LEARNINGS.md) in the same change.
- When behavior or expectations change, update the relevant file in [SPECS/README.md](/Users/dreuven/Projects/RSG/CSDroid/SPECS/README.md) and keep [index.md](/Users/dreuven/Projects/RSG/CSDroid/index.md) in sync.

## Testing expectations

- Prefer live primitives over mock-only confidence.
- Keep regression assertions focused on key elements instead of exact generated prose.
- If a script relies on local environment variables, load them through `src/env.ts` or export them explicitly before invoking Node.
- Before saying a live ticket workflow is done, verify that Fulcrum produced the expected tracking-bearing output and that any copied test ticket has been closed.

## Current focus areas

- Open-order-report CSV attachments must be parsed deterministically instead of extracting arbitrary numbers from filenames.
- Fulcrum order matching must handle customer PO values like `695455 OP 00100 000` when the customer-facing report only shows the base number.
- Generated customer-facing artifacts should stay review-first: attach the enriched report privately and leave a draft response for an agent to send.

## Customer-service agent (current architecture)

- Non-PO tickets are now handled by an **agent-first** flow: `handler.ts → runCustomerServiceAgent` runs a Claude (Opus 4.8, modular via `CSDROID_AGENT_MODEL`) tool-use loop. The deterministic PO pipeline is unchanged and is invoked by the agent as the `run_po_pipeline` tool. Full spec: [SPECS/customer-service-agent.md](/Users/dreuven/Projects/RSG/CSDroid/SPECS/customer-service-agent.md).
- **The central output is `nextAction`** (`draft_reply` | `no_response_needed` | `escalate`) — what we DO with the ticket, kept explicit and separate from the type tags (what the ticket IS). The internal note leads with PRIMARY INTENT + NEXT ACTION + WHY. Keep this distinction sharp in any edit.
- Every ticket is classified into the taxonomy in `src/ticket-categories.ts` and tagged (type tag × the existing `ai_ready/alert` outcome tags) so handling can be measured (`npm run test:analytics`).
- **Multi-label, full-thread:** the agent sees the WHOLE comment thread (labeled CUSTOMER vs RSG) and applies a tag for EVERY type the thread exhibited, not just the latest (one primary category drives the response; the rest go in `additionalTags`). Analytics is a set-membership query, and `test:eval` scores the same way.
- **One-off learnings** for repeatable cases (e.g. a specific sender's templated emails) live in `src/agent/learnings.ts` (injected into the system prompt) — add a bullet there rather than special-casing code.
- **Drafts are internal-only.** All comment writes go through `assertPrivateComment` in `zendesk.ts`, which throws on any public comment. Never add a code path that posts `public:true` on a production ticket. There is no programmatic Zendesk composer-draft API — do not attempt one.
- **Verify with dry-run, never by sending.** Use `CSDROID_DRY_RUN=1` and `npm run test:safety|test:eval|test:backtest`. Dry-run suppresses + records all Zendesk writes while leaving reads intact; the golden set lives in `fixtures/golden-tickets.json`.
- Any category touching a specific customer's data must pass the authorization gate (`src/authorization.ts`) before disclosing anything; `new_customer_inquiry` is exempt.

---

# PoProcessor Lambda Function - Complete System Documentation

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Data Flow](#data-flow)
4. [Core Modules](#core-modules)
5. [External Integrations](#external-integrations)
6. [Processing Pipeline](#processing-pipeline)
7. [Error Handling](#error-handling)
8. [Configuration & Deployment](#configuration--deployment)
9. [Testing](#testing)

---

## Overview

**PoProcessor** is an AWS Lambda-based AI system that intelligently processes and routes customer support tickets from Zendesk. It's designed to be a generalized "AI Customer Service Representative" that can handle multiple types of customer inquiries while maintaining extensibility for future features.

### Key Capabilities

- **Purchase Order Processing**: Extracts structured data from PDF purchase orders using GPT-5 Vision
- **Customer Matching**: Fuzzy matches customer names against Fulcrum ERP database
- **Item Matching**: Intelligently matches line items to product catalog
- **Price Validation**: Compares PO prices against customer tier pricing in DynamoDB
- **Order Tracking**: Tracks orders through Fulcrum ERP and Zendesk integration
- **AI Classification**: Classifies ticket intent (PURCHASE_ORDER, ORDER_TRACKING, PRODUCT_QUESTION, OTHER)
- **Response Generation**: Generates professional customer-facing responses using AI
- **PDF Intelligence**: Automatically identifies purchase orders when multiple PDFs are attached

### Technology Stack

```
Frontend Trigger: Zendesk Webhook
                    ↓
API Gateway (ingest endpoint)
                    ↓
SQS Queue (po-processor-queue)
                    ↓
Lambda Worker (15-minute timeout)
                    ↓
External Services:
  - OpenAI GPT-5 Vision (PDF analysis)
  - Zendesk API (ticket management)
  - Fulcrum ERP (customer/item/order data)
  - S3 (Fulcrum catalog cache)
  - DynamoDB (customer pricing)
  - SES (email notifications)
```

---

## Architecture

### Lambda Functions

The system consists of **two Lambda functions**:

#### 1. **Ingest Function** (`handler.ingest`)
- **Trigger**: HTTP POST to `/ingest` endpoint (from Zendesk webhook)
- **Timeout**: 10 seconds
- **Memory**: 512 MB
- **Responsibility**:
  - Verify Bearer token (ZENDESK_WEBHOOK_TOKEN)
  - Extract ticket_id from request body
  - Send message to SQS queue
  - Return 202 immediately (fast response)
- **Fast Path**: No processing happens here - just queue the message

#### 2. **Worker Function** (`handler.worker`)
- **Trigger**: SQS messages from po-processor-queue
- **Timeout**: 900 seconds (15 minutes)
- **Memory**: 1024 MB
- **Batch Size**: 1 (process one ticket at a time)
- **Responsibility**:
  - Full ticket processing pipeline (extraction, classification, routing, enrichment)
  - Update Zendesk with results
  - Handle errors and failures gracefully
  - Tag management (add/remove processing indicators)

### Queue Configuration

```yaml
Queue Name: po-processor-queue
DLQ Name: po-processor-dlq
Visibility Timeout: 960 seconds (16 minutes)
Max Receive Count: 3 retries
Message Retention: 1 day (queue) / 14 days (DLQ)
```

### Module Organization

```
src/
├── handler.ts                 # Lambda entry points (ingest + worker)
├── types.ts                   # Complete type definitions
├── config.ts                  # Configuration knobs and overrides
├── env.ts                     # Environment variable loading

CORE PIPELINE:
├── zendesk.ts                 # Zendesk API integration
├── classification.ts          # Intent classification (AI)
├── routing.ts                 # Intent routing and handlers
├── eligibility.ts             # Customer eligibility checks

PURCHASE ORDER PROCESSING:
├── openai.ts                  # PDF parsing and AI matching
├── pdf-classification.ts      # Multi-PDF classification
├── matching.ts                # Customer/item fuzzy matching
├── pricing.ts                 # Price validation logic
├── s3.ts                      # Fulcrum catalog loading

ORDER TRACKING:
├── order-tracking.ts          # Order tracking business logic
├── fulcrum.ts                 # Fulcrum API integration
├── response-generation.ts     # AI-powered response generation

UTILITIES:
├── ses.ts                     # Email notifications (SES)
├── utils.ts                   # Helper functions
└── local.ts                   # Local development entry point

DOCUMENTATION:
├── AGENTS.md                  # This file
└── SPECS/fuzzy-po-matching.md # Fuzzy matching implementation
```

---

## Data Flow

### High-Level Processing Pipeline

```
1. WEBHOOK TRIGGER
   Zendesk sends webhook to /ingest
   ↓
2. INGEST (Fast)
   - Verify auth token
   - Extract ticket_id
   - Queue message to SQS
   - Return 202 immediately
   ↓
3. SQS MESSAGE PROCESSING
   - Worker Lambda polls queue
   - Processes 1 message per invocation
   - 3 retry attempts if error occurs
   - Messages go to DLQ if all retries fail
   ↓
4. TICKET EXTRACTION
   - Fetch ticket from Zendesk
   - Extract comments, attachments, user info
   - Build comprehensive TicketContext
   ↓
5. CUSTOMER ELIGIBILITY CHECK
   - Query customer domain (currently stubbed)
   - Return early if not eligible
   ↓
6. INTENT CLASSIFICATION
   - Send ticket content to GPT-5
   - Get classification (PURCHASE_ORDER, ORDER_TRACKING, etc.)
   - Check confidence threshold (0.8+)
   - Return early if low confidence
   ↓
7. INTENT ROUTING
   - Route to appropriate handler based on intent
   - Handle each intent type differently
   ↓
8. PROCESSING RESULT
   - Generate ProcessingResult object
   - Include public response draft (if applicable)
   - Include internal note
   - Mark tags for categorization
   ↓
9. ZENDESK UPDATE
   - Attach result to ticket (as private JSON)
   - Update PO status custom field
   - Add tags
   - Add internal note comment
   - Include draft public response (if applicable)
   ↓
10. TAG CLEANUP
    - Remove 'ai_processing_active' tag
    - Remove 'reprocess' tag (if manually retriggered)
    - Signals to agents that AI processing is complete
```

### State Transitions

The `po_status` custom field (ID: 45116435108627) tracks processing state:

```
[Start]
  ↓
needs_processing → (webhook trigger)
  ↓
processing → (ingest adds tag, worker starts)
  ↓
ready_to_review ← (successful processing, ready for human review)
  ├→ submitted_to_fulcrum (admin submits to ERP)
  └→ review_failed ← (processing error, needs manual handling)
```

### Tag Management

**Processing Tags** (set at start, removed at end):
- `ai_processing_active` - Signals AI is actively working

**Trigger Tags** (manual):
- `reprocess` - Manually retrigger AI processing (removed after processing)

**Result Tags** (set by AI):
- `AI_READY_FOR_HUMAN_REVIEW` - Successful processing, ready for review
- `AI_ALERT_HUMAN_REVIEW_REQUIRED` - Processing completed but flagged for review
- `multiple_pos_detected` - Multiple POs found, needs clarification
- `purchase_order` - Tagged as PO processing
- `ready_to_review` - Status indicator

---

## Core Modules

### 1. **handler.ts** - Lambda Entry Points

#### `ingest(event)` - HTTP Handler
```typescript
POST /ingest
Content-Type: application/json
Authorization: Bearer {ZENDESK_WEBHOOK_TOKEN}

Body: { ticket_id: number }
Response: { statusCode: 202, body: { enqueued: true, messageId, ticket_id } }
```

**Responsibilities**:
- Validate Bearer token
- Parse ticket_id from body
- Send to SQS queue
- Return immediately with 202 status

**Error Handling**:
- 401: Invalid/missing token
- 400: Missing ticket_id or body
- 500: Internal error (still returns gracefully)

#### `worker(event, context)` - SQS Handler

**Main Processing Loop**:
```typescript
for each SQSRecord:
  1. Parse payload
  2. Add processing tag
  3. Try: Extract context → Check eligibility → Classify intent → Route handler
  4. Update ticket with result
  5. Finally: Remove processing tags (all exit points)
  6. On error: Send alert email, update ticket, remove tags, retry logic
```

**Critical Feature: Tag Cleanup**
- Uses try-finally to ensure tags are removed at **all exit points**
- Prevents infinite webhook re-triggering
- Signals to agents that processing is complete (success or failure)
- Removes both `ai_processing_active` and `reprocess` tags

**Error Differentiation**:
- **Quota/Rate Limit Errors** (429, insufficient_quota): Exit gracefully (no retry)
- **Retryable Errors**: Re-throw for SQS retry logic (max 3 attempts)

### 2. **types.ts** - Type Definitions

#### Core Enums

```typescript
STATUS {
  PROCESSING: "processing"
  READY: "ready_to_review"
  FAILED: "review_failed"
  NO_PDF: "has_no_pdf"
  SUBMITTED: "submitted_to_fulcrum"
}

IntentClassification {
  intent: 'PURCHASE_ORDER' | 'ORDER_TRACKING' | 'PRODUCT_QUESTION' | 'OTHER'
  confidence: 0.0-1.0
  reasoning: string
  isNewPurchaseOrder?: boolean
  requiresHumanReview?: boolean
  humanReviewReason?: string
  keyEntities?: {
    poNumbers?: string[]      // Array of ALL PO numbers (supports multi-PO)
    productSkus?: string[]
    urgencyLevel?: 'low' | 'medium' | 'high'
  }
}

ProcessingResult {
  success: boolean
  requiresHumanReview: boolean
  reason: string
  tag: 'AI_READY_FOR_HUMAN_REVIEW' | 'AI_ALERT_HUMAN_REVIEW_REQUIRED'
  internalNote: string
  publicResponse?: string | null
  data?: any
  additionalTags?: string[]
}
```

#### Ticket Context Types

```typescript
TicketContext {
  ticketId: number
  subject: string
  description: string
  status: string
  priority: string
  requester: TicketUser
  submitter: TicketUser
  comments: TicketComment[]         // Full history with attachments
  latestPublicComment?: TicketComment
  privateNotes: TicketComment[]
  customFields: Array<{ id, value }>
  tags: string[]
}

TicketComment {
  id: number
  type: 'Comment' | 'VoiceComment'
  author_id: number
  body: string
  public: boolean
  created_at: string
  attachments: TicketAttachment[]
}

TicketAttachment {
  id: number
  filename: string
  content_type: string
  content_url: string              // Direct download URL
  size: number
}
```

#### Purchase Order Types

```typescript
ParsedPO {
  company_name: string
  mark_for?: string | null
  shipping_address: ShippingAddress (camelCase)
  delivery_date: string (ISO 8601)
  currency: string
  purchase_order: {
    purchase_order_number: string
    currency: string
    total_cost: number | null
    items: PurchaseOrderItem[]
  }
  matched_customer?: MatchedCustomer | null
  warnings?: string[]
  validation?: {
    customer_matched: boolean
    all_items_matched: boolean
    all_prices_valid: boolean
    requires_manual_review: boolean
  }
  pdfUrl?: string                  // Filled by zendesk.ts
  raw_response?: string            // Fallback if unparseable
}

PurchaseOrderItem {
  description: string
  unit_price: number | null
  quantity: number | null
  total: number | null
  date_scheduled: string | null    // Can be null if not specified
  matched_item_number?: string
  matched_item_id?: string | null
  match_confidence?: number
  item_warnings?: string[]
  fulcrum_price?: number | null
  price_mismatch?: boolean
  price_difference?: number | null
  pricing_tier_used?: string | null
}
```

#### Order Tracking Types

```typescript
FulcrumSalesOrder {
  id: string
  number: number
  orderedDate: string
  customerPoNumber: string          // KEY: Matched against incoming PO
  customerId: string
  deliveryDueDate?: string | null
  status: 'draft' | 'needsApproval' | 'approved' | 'inProgress' | 'complete'
  priority: 'low' | 'moderate' | 'high'
  subtotal: number
  externalReferences?: Record<string, ExternalReference>
  customFields?: Record<string, any>
  billingAddress?: Address
}

TrackingResult {
  salesOrder: FulcrumSalesOrder
  shipments: FulcrumShipment[]
  shippedShipments: FulcrumShipment[]
  pendingShipments: FulcrumShipment[]
  status: 'FULLY_SHIPPED' | 'PARTIALLY_SHIPPED' | 'NOT_SHIPPED' | 'NOT_FOUND'
  trackingInfo: TrackingInfo[]
  scheduledDeliveryDate?: string | null
}

TrackingInfo {
  shipmentName: string
  trackingNumber?: string | null
  trackingUrl?: string | null
  carrier?: string | null
  shippingMethod?: string | null
  shippedDate?: string | null
  shipByDate?: string | null
}
```

#### Error Types

```typescript
class MultiplePurchaseOrdersError extends Error {
  count: number
  poNumbers: (string | null)[]
  filenames: string[]
}

class NoPurchaseOrderFoundError extends Error {
  pdfCount: number
  filenames: string[]
}
```

### 3. **config.ts** - Configuration & Overrides

```typescript
// Customer name mapping overrides
CUSTOMER_NAME_OVERRIDES = {
  "ADI GLOBAL DISTRIBUTION": "ADI Global Distribution",
  "RESIDEO LLC": "ADI Global Distribution",
  "NYC ALARM": "NEW YORK CITY ALARM",
  "JCI": "JOHNSON CONTROLS",
  "JOHNSON CONTROLS INC": "JOHNSON CONTROLS"
}

// Extraction prompts with context
getExtractionOverrides() → string  // Returns special handling rules

// Matching thresholds
CUSTOMER_MATCH_THRESHOLD = 70        // Min confidence for customer match
ITEM_MATCH_THRESHOLD = 60            // Min confidence for item match

// Retry policy
DEFAULT_RETRIES = 2                  // For email sending

// Prompt context
PROMPT_HINTS {
  customer: "Consider legal vs operating names; abbreviations..."
  item: "Consider terminal config, color, labels, weather rating..."
}
```

### 4. **zendesk.ts** - Zendesk Integration

#### Authentication
```typescript
Base Auth: Basic {base64(email/token:apiToken)}
Endpoints: https://{ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/...
Rate Limiting: 429 handled with Retry-After header
```

#### Key Functions

**`extractTicketContext(ticketId)`**
- Fetches ticket details, comments, attachments, users
- Builds comprehensive TicketContext object
- Includes all public comments, private notes, and user information

**`getTicketPdfUrl(ticketId)`**
- Single PDF: Fast path, returns immediately
- Multiple PDFs: AI classification to identify which is PO
- Zero PDFs: Returns null
- Multiple POs: Throws MultiplePurchaseOrdersError
- No POs found: Throws NoPurchaseOrderFoundError

**`updateTicketWithResult(ticketId, result, requesterFirstName)`**
- Adds internal note comment
- Adds tags (primary + additional)
- Includes optional draft public response
- All updates as private comments to avoid customer confusion

**`updateTicketWithPO(ticketId, poJson, pdfUrl)`**
- Uploads parsed PO as JSON attachment
- Sets po_status to "ready_to_review"
- Optionally stores SHA256 hash for deduplication

**`setPoStatus(ticketId, value)`**
- Updates custom field (ID: 45116435108627)
- Values: processing, ready_to_review, review_failed, has_no_pdf, submitted_to_fulcrum

**`addProcessingTag(ticketId)`** & **`removeProcessingTag(ticketId)`**
- Signals when AI is actively working
- Used to prevent webhook re-triggering
- Best-effort (doesn't throw on failure)

**`removeReprocessTag(ticketId)`**
- Clears manual reprocess trigger tag
- Allows manual re-triggering by adding "reprocess" tag

#### Rate Limiting
```typescript
zdFetch() implements automatic retry:
- Checks for 429 status
- Reads Retry-After header
- Waits exponentially: 1500ms × (attempt + 1)
- Maximum 4 attempts
```

### 5. **classification.ts** - Intent Classification

#### Purpose
Classifies ticket into one of 4 categories using GPT-5

#### Classification Logic
```typescript
Model: gpt-5
Prompt: Analyzes ticket subject, description, comments, attachments
Output: {
  intent: 'PURCHASE_ORDER' | 'ORDER_TRACKING' | 'PRODUCT_QUESTION' | 'OTHER'
  confidence: 0.0-1.0
  reasoning: string
  isNewPurchaseOrder: boolean
  keyEntities: {
    poNumbers: string[]      // ALL PO numbers found
    productSkus: string[]
    urgencyLevel: 'low' | 'medium' | 'high'
  }
}
```

#### Confidence Threshold
- **0.8+**: Proceed with processing
- **<0.8**: Flag for human review (too risky)

#### Safety Checks
- If PO already processed AND AI still says PURCHASE_ORDER but not new → flag for review
- Checks current po_status to avoid duplicate processing
- Tracks ticket history to detect new submissions vs inquiries about existing POs

#### Multi-PO Support
- Extracts ALL PO numbers mentioned in ticket
- Returns as array in keyEntities.poNumbers
- Supports tracking for multiple orders in single ticket

### 6. **routing.ts** - Intent Routing

#### Router Function
```typescript
handleTicketIntent(ticketContext, intent) → ProcessingResult

Switch on intent:
  PURCHASE_ORDER → processPurchaseOrderWrapper()
  ORDER_TRACKING → handleOrderTracking()
  PRODUCT_QUESTION → Stub (returns for human review)
  OTHER → Stub (returns for human review)
```

#### PURCHASE_ORDER Handler

**Steps**:
1. Get PDF URL (handles multi-PDF classification)
2. Parse PDF with OpenAI
3. Load Fulcrum catalog
4. Enrich with customer/item matching & pricing validation
5. Attach JSON to ticket
6. Update status to "ready_to_review"

**Error Handling**:
- Multiple POs: Returns success=true, requiresHumanReview=true
- No PDFs: Returns success=true, requiresHumanReview=true
- PDF parsing failure: Returns success=false, requiresHumanReview=true

#### ORDER_TRACKING Handler

**Single-PO Path**:
1. Extract PO number from intent
2. Track order in Fulcrum
3. Generate AI response
4. Check confidence threshold (0.85)
5. Return result with draft response

**Multi-PO Path**:
1. Extract ALL PO numbers from intent
2. Track all orders in parallel
3. Categorize results (successful, not found, errors)
4. Generate consolidated response
5. Return result with summary

**Confidence Threshold**: 0.85 (configurable via ORDER_TRACKING_CONFIDENCE_THRESHOLD)

---

## External Integrations

### 1. OpenAI GPT-5 Vision

#### Endpoints
- `https://api.openai.com/v1/responses` (Responses API)

#### Key Features
- **PDF Analysis**: Extracts structured data from purchase orders
- **Intent Classification**: Classifies customer intent with reasoning
- **PDF Classification**: Identifies which PDFs are purchase orders
- **Response Generation**: Generates customer-facing responses
- **JSON Schema**: Enforces response structure with JSON Schema validation

#### Usage Pattern
```typescript
// Common pattern across all AI calls
POST /v1/responses
Headers: {
  Authorization: Bearer {OPENAI_API_KEY}
  Content-Type: application/json
}
Body: {
  model: "gpt-5"
  text: {
    format: {
      name: "schema_name"
      type: "json_schema"
      schema: { /* JSON Schema */ }
    }
  }
  input: [
    {
      role: "user"
      content: [
        { type: "input_text", text: prompt }
        { type: "input_file", file_url: pdfUrl }  // For PDF analysis
      ]
    }
  ]
  max_output_tokens: 5000
}
```

#### Timeout
- OPENAI_REQUEST_TIMEOUT_MS: 420 seconds (7 minutes) default
- Configurable via environment variable

#### Retry Logic
- Max 2 retries on error
- Exponential backoff: 500ms × attempt
- AbortController for timeout enforcement

#### Error Handling
- **429 (Quota Exceeded)**: Exit gracefully, don't retry
- **Other Errors**: Retry, then throw for Lambda retry logic

### 2. Zendesk

#### Base URL
```
https://{ZENDESK_SUBDOMAIN}.zendesk.com/api/v2
```

#### Authentication
```
Authorization: Basic {base64(email/token:apiToken)}
```

#### Key Endpoints

**Get Ticket**
```
GET /tickets/{id}.json?include=users
Response: { ticket, users }
```

**Get Comments**
```
GET /tickets/{id}/comments.json?sort_order=desc
Response: { comments: TicketComment[] }
```

**Update Ticket**
```
PUT /tickets/{id}.json
Body: {
  ticket: {
    custom_fields: [{ id, value }]
    comment: { body, public: false }
    tags: [...]
  }
}
```

**Upload File**
```
POST /uploads.json?filename={name}
Body: Raw JSON content
Response: { upload: { token } }
```

**Manage Tags**
```
PUT /tickets/{id}/tags.json     (Add tags)
DELETE /tickets/{id}/tags.json  (Remove tags)
```

#### Custom Fields
- **PO_STATUS_FIELD_ID** (45116435108627): Processing status
- **PO_RESULT_SHA_FIELD_ID** (optional): SHA256 of parsed PO (for deduplication)
- **PO_JSON_ATTACHMENT_ID_FIELD_ID** (optional): ID of attached JSON file

#### Rate Limiting
- 429 status with Retry-After header
- Automatic retry with exponential backoff
- Max 4 attempts per request

### 3. Fulcrum ERP

#### Base URL
```
https://api.fulcrumpro.com
```

#### Authentication
```
Authorization: Bearer {FULCRUM_TOKEN}
```

#### Key Endpoints (from order-tracking)

**Find Sales Orders**
```
GET /api/sales-orders/list?page={page}&pageSize=100
Response: FulcrumPaginatedResponse<FulcrumSalesOrder>

// Client-side filtering by customerPoNumber (API doesn't support filter)
```

**Get Shipments**
```
GET /api/shipments/list?page={page}&filters[salesOrderId]={id}
Response: FulcrumPaginatedResponse<FulcrumShipment>
```

**Get Shipment Line Items**
```
GET /api/shipment-line-items/list?filters[shipmentId]={id}
Response: FulcrumPaginatedResponse<FulcrumShipmentLineItem>
```

#### Key Features
- **Fuzzy PO Matching**: Handles formatting variations (PO 400203171 vs 400203171-XP)
- **Normalization**: Removes common formatting before comparison
- **Confidence Scoring**: 1.0 for exact, 0.95 for normalized, 0.0 for no match
- **Threshold Filtering**: Only matches with confidence ≥ 0.9

#### Rate Limiting
- 429 status with Retry-After header
- Automatic retry with exponential backoff
- Max 4 attempts per request

#### Pagination
- Default: 100 items per page
- Max 100 pages (10,000 items before stopping)
- Early exit optimization: Stops after finding match

### 4. AWS S3 - Fulcrum Catalog

#### Bucket
- Name: FULCRUM_ITEMS_BUCKET (env var, default: `fulcrum-items-sync-prod`)
- Key: FULCRUM_ITEMS_KEY (env var, default: `items.json`)
- **CRITICAL**: Must be in same AWS region as Lambda

#### File Format
```json
{
  "lastSyncedAt": "2024-12-29T...",
  "SellableItems": {
    "itemCount": 1500,
    "itemsByNumber": {
      "ED-500": {
        "id": "item-uuid",
        "number": "ED-500",
        "description": "Manual Dump Terminal",
        "customerTiers": [
          {
            "customerTier": { "id": "tier-1", "name": "Distributor" },
            "priceBreaks": [
              { "quantity": 1, "price": 450.00 },
              { "quantity": 10, "price": 425.00 }
            ]
          }
        ]
      }
    }
  },
  "Customers": {
    "customerCount": 500,
    "customersByName": {
      "ACME CORP": {
        "id": "cust-uuid",
        "name": "ACME CORP",
        "customerTierId": "tier-1",
        "customerTierName": "Distributor"
      }
    }
  }
}
```

#### Access Pattern
1. Check if FULCRUM_ITEMS_PATH env var set (local file)
2. Otherwise fetch from S3
3. Normalize both legacy and new key names
4. Return FulcrumCatalog with safe defaults

### 5. AWS DynamoDB - Customer Pricing (Future)

#### Tables
- **customer-pricing-domains-prod**: Email domain → customer mapping
- **customer-pricing-prod**: Product pricing by tier

#### Currently Stubbed
- `eligibility.ts`: Returns eligible=true for all customers
- Future implementation will query DynamoDB for verified domains

### 6. AWS SES - Email Notifications

#### Configuration
- Region: SES_REGION (env var, defaults to AWS_REGION)
- From Address: SES_FROM (env var)
- Retry Policy: DEFAULT_RETRIES (2 retries) for notifications

#### Functions

**`sendAlertEmail(opts)`**
- Non-blocking alert email
- Used for quota exceeded, fatal errors, tracking issues
- Doesn't throw on failure (best-effort)
- To: 'dreuven@rsgsecurity.com' (configured in handler)

**`notifyFailure(opts)`** (Currently unused)
- Blocking notification
- Would throw if sending ultimately fails
- Available for future use

#### Email Types
1. **Quota Exceeded**: OpenAI account out of credits
2. **Fatal Errors**: Unexpected exceptions during processing
3. **Handler Errors**: Issues in routing/response generation
4. **Tracking Issues**: Problems finding sales orders

### 7. AWS SQS - Queue Management

#### Queue Details
```
Queue URL: PoQueue (managed by Serverless)
DLQ: PoQueueDLQ
Visibility Timeout: 960 seconds (16 minutes)
Message Retention: 1 day
DLQ Retention: 14 days
Max Receives: 3 (before moving to DLQ)
```

#### Message Format
```json
{
  "ticket_id": 21083,
  "attempt": 1
}
```

#### Lambda Integration
- Ingest sends message: `SendMessage` permission
- Worker polls: `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`
- Automatic batching: batchSize=1, maximumBatchingWindow=0

---

## Processing Pipeline

### Detailed Step-by-Step Walkthrough

#### Step 1: Webhook & Ingest

```
Customer's email arrives in Zendesk
  ↓
Zendesk webhook fires
  ↓
POST /ingest with ticket_id and Bearer token
  ↓
Handler.ingest():
  - Verify token
  - Parse ticket_id
  - Send to SQS: { ticket_id, attempt: 1 }
  - Return 202 immediately
```

#### Step 2: Worker Startup & Tag Management

```
SQS message received by worker Lambda
  ↓
Parse { ticket_id }
  ↓
ADD 'ai_processing_active' tag to ticket
  ↓
TRY: entire processing pipeline
  ↓
FINALLY: REMOVE tags (guaranteed at all exit points)
  - Remove 'ai_processing_active'
  - Remove 'reprocess' (if manually triggered)
```

#### Step 3: Ticket Context Extraction

```
extractTicketContext(ticketId):
  1. GET /api/v2/tickets/{id}.json?include=users
  2. GET /api/v2/tickets/{id}/comments.json
  3. Parse comments with attachments
  4. Build TicketContext {
       ticketId
       subject
       description
       requester/submitter
       comments[]
       latestPublicComment
       privateNotes[]
       customFields
       tags
     }
```

#### Step 4: Eligibility Check

```
shouldAiAutoRespond(requesterEmail):
  - Extract domain from email
  - STUB: Return eligible=true for all
  - Future: Query DynamoDB for verified domains

If not eligible:
  - Update ticket with human review required
  - Exit early (no retry)
```

#### Step 5: Intent Classification

```
classifyTicketIntent(ticketContext):
  - Build AI prompt with:
    * Ticket subject, description, comments
    * Attachment count and types
    * Current PO status (for deduplication)
    * Tags
  - Send to GPT-5 with JSON schema
  - Parse response
  - Check confidence ≥ 0.8
  - Apply safety check for duplicate POs
  - Extract keyEntities.poNumbers as array

Output:
  {
    intent: PURCHASE_ORDER | ORDER_TRACKING | PRODUCT_QUESTION | OTHER
    confidence: 0.0-1.0
    reasoning: string
    keyEntities: { poNumbers: [], productSkus: [], urgencyLevel }
  }
```

#### Step 6a: PURCHASE_ORDER Processing

```
processPurchaseOrderWrapper(ticketContext, intent):

  1. GET PDF URL (handles 0, 1, or multiple PDFs)
     - 0 PDFs: Return "no PDF found"
     - 1 PDF: Return URL immediately (fast path)
     - 2+ PDFs: Use AI to classify which is PO
       * 0 POs: Throw NoPurchaseOrderFoundError
       * 1 PO: Return URL
       * 2+ POs: Throw MultiplePurchaseOrdersError

  2. ANALYZE PDF (if URL found)
     - Send to GPT-5 with extraction instructions
     - Return ParsedPO schema
     - Includes: company_name, items[], shipping_address, delivery_date

  3. LOAD FULCRUM CATALOG
     - From S3: s3://{bucket}/{key}
     - Normalize legacy keys
     - Extract: customers by name, items by number

  4. ENRICH WITH AI MATCHING
     enrichWithFulcrumAndAI(parsedPO, catalog):
       a. Match customer name (with overrides):
          - Check CUSTOMER_NAME_OVERRIDES
          - Fall back to AI fuzzy matching (70% threshold)

       b. Match each item:
          - Use AI to find best match in catalog (60% threshold)
          - Include match_confidence

       c. Validate pricing:
          - Get customer tier from matched customer
          - For each item: find tier price breaks
          - Compare PO price vs Fulcrum price
          - Flag price_mismatch if not equal

  5. UPDATE ZENDESK
     updateTicketWithPO(ticketId, enriched, pdfUrl):
       - Upload JSON as private attachment
       - Store SHA256 (optional, for deduplication)
       - Set po_status → "ready_to_review"

  6. RETURN SUCCESS RESULT
     {
       success: true
       requiresHumanReview: false
       reason: "PO processed successfully"
       tag: AI_READY_FOR_HUMAN_REVIEW
       additionalTags: ['purchase_order', 'ready_to_review']
       internalNote: "✅ Purchase Order Processed..."
       publicResponse: "Hi {name}, Thank you for your PO..."
     }
```

#### Step 6b: ORDER_TRACKING Processing

**Single-PO Path**:
```
handleOrderTracking(ticketContext, intent):

  1. EXTRACT PO NUMBER
     - Get from intent.keyEntities.poNumbers[0]
     - Or return human review required

  2. TRACK ORDER
     trackOrder(poNumber):
       a. Find sales orders by fuzzy-matching customerPoNumber
          - Normalize both sides
          - Filter by confidence ≥ 0.9

       b. If not found: Return status=NOT_FOUND

       c. Get shipments for sales order
          - Fetch from Fulcrum API
          - Categorize: shipped vs pending

       d. Determine status:
          - FULLY_SHIPPED: All shipped, none pending
          - PARTIALLY_SHIPPED: Some shipped, some pending
          - NOT_SHIPPED: None shipped

       e. Build tracking URLs for each shipment
          - Use carrier-specific tracking URL builder

  3. GENERATE RESPONSE
     generateTrackingResponse(ticketContext, trackingResult, intent, name):
       - Send tracking data to GPT-5
       - Generate friendly email response
       - Return confidence score

  4. CHECK CONFIDENCE
     - If confidence < 0.85: Return for human review (draft response included)
     - If confidence ≥ 0.85: Ready for review

  5. RETURN RESULT
     {
       success: true
       requiresHumanReview: false
       reason: "Order tracking retrieved successfully"
       tag: AI_READY_FOR_HUMAN_REVIEW
       internalNote: "✅ Order Tracking Retrieved..."
       publicResponse: "Hi {name}, Here's the status of your order..."
       data: trackingResult
     }
```

**Multi-PO Path**:
```
handleMultipleOrderTracking(ticketContext, intent, poNumbers):

  1. TRACK ALL ORDERS IN PARALLEL
     - Create Promise for each PO
     - trackOrder(po) for each
     - Catch errors gracefully

  2. CATEGORIZE RESULTS
     - successful: found and tracked
     - notFound: not in Fulcrum
     - errors: API failures

  3. IF ALL FAILED
     - Return human review required with failure details

  4. GENERATE CONSOLIDATED RESPONSE
     generateMultiTrackingResponse(...):
       - Format all tracking info
       - Include summary of successful/failed
       - Generate consolidated response

  5. CHECK CONFIDENCE
     - If < 0.85: Return for review (draft included)
     - If ≥ 0.85: Ready for review

  6. BUILD SUMMARY NOTE
     - Table with PO | Sales Order | Status | Shipped | Pending
     - List not found orders
     - List errors with messages

  7. RETURN RESULT
     {
       success: true
       requiresHumanReview: false
       reason: "Successfully tracked 2/3 orders"
       tag: AI_READY_FOR_HUMAN_REVIEW
       internalNote: "✅ Multiple Order Tracking Results..."
       publicResponse: "Hi {name}, Here's the status of your orders..."
       data: {
         trackingResults: TrackingResult[]
         notFound: string[]
         errors: Array<{ poNumber, message }>
         poNumbers: string[]
       }
     }
```

#### Step 7: Update Zendesk with Result

```
updateTicketWithResult(ticketId, result, requesterFirstName):

  1. BUILD COMMENT BODY
     If publicResponse provided:
       - Add "[DRAFT PUBLIC RESPONSE - DO NOT SEND YET]" header
       - Include response
       - Add separator line
     Add internal note

  2. UPDATE TICKET
     PUT /api/v2/tickets/{id}.json
     Body: {
       ticket: {
         tags: [ result.tag, ...result.additionalTags ]
         comment: {
           body: commentBody
           public: false
         }
       }
     }

  3. IF ERROR
     - Update with error note and human review tag
```

#### Step 8: Error Handling & Cleanup

```
TRY-FINALLY ensures:
  1. On success: Remove tags
  2. On early return: Remove tags
  3. On error:
     - Log error details
     - Send alert email (first attempt only)
     - Update ticket with error note
     - Remove tags (always)
     - Decide retry vs exit:
       * Quota/429: Exit gracefully (no retry)
       * Other errors: Re-throw for SQS retry
```

---

## Error Handling

### Error Classification

#### 1. **User/Data Errors** (Success=true, but for review)
These are handled gracefully and returned as ProcessingResult:
- No PDF found
- Customer not eligible
- Low confidence classification
- Multiple POs detected
- PO not found in Fulcrum
- Invalid customer/item data

**Response**: `success=true, requiresHumanReview=true, tag=AI_ALERT_HUMAN_REVIEW_REQUIRED`

**Behavior**: Update ticket and return gracefully (no retry)

#### 2. **Processing Errors** (Success=false)
These require human review:
- PDF parsing failure
- Customer matching failure
- Item matching failure
- AI response generation failure
- Zendesk API errors

**Response**: `success=false, requiresHumanReview=true, tag=AI_ALERT_HUMAN_REVIEW_REQUIRED`

**Behavior**: Update ticket with error note, optionally retry

#### 3. **Fatal System Errors**
These require immediate attention:
- OpenAI quota exceeded (429)
- Rate limit exceeded
- Configuration missing
- Unexpected exceptions

**Response**: Alert email + error note in ticket

**Behavior**:
- Quota/Rate Limit: Exit gracefully (no retry)
- Other: Throw for SQS retry (max 3 attempts)

### Quota/Rate Limit Handling

```typescript
// In worker error handler
const isQuotaError = errorMessage.includes('429') ||
                     errorMessage.includes('quota') ||
                     errorMessage.includes('insufficient_quota');

if (isQuotaError || isRateLimitError) {
  // Send alert email
  await sendAlertEmail({
    subject: `PoProcessor QUOTA ERROR - Ticket ${ticketId}`,
    body: "OPENAI QUOTA EXCEEDED\n\nPlease add credits..."
  });

  // Update ticket (first attempt only)
  if (isFirstAttempt) {
    await updateTicketWithResult(ticketId, {
      success: false
      internalNote: "🚫 OpenAI API Quota Exceeded\n\nAdd credits at..."
    });
  }

  // Exit gracefully - do NOT retry
  return; // No throw
}

// For other errors, throw to trigger SQS retry
throw err;
```

### Error Alert Emails

**First Attempt Only** (to avoid spam):
- Quota exceeded errors
- Fatal exceptions
- Handler failures

**Email To**: dreuven@rsgsecurity.com (hardcoded)

**Email Content**:
- Error type and message
- Stack trace
- Ticket ID and message ID
- Zendesk link
- Retry status
- Action required

### Tag Cleanup Guarantees

```typescript
addProcessingTag(ticketId) at START
  ↓
TRY: entire processing
  ↓
FINALLY: (guaranteed to run)
  removeProcessingTag(ticketId)      // Always removed
  removeReprocessTag(ticketId)       // Clears manual trigger
  ↓
Prevents:
  1. Infinite webhook re-triggering
  2. Ambiguous processing state
  3. Locked tickets waiting for timeout
```

---

## Configuration & Deployment

### Environment Variables

#### Zendesk Configuration
```
ZENDESK_SUBDOMAIN        # e.g., "rsgsecurity"
ZENDESK_EMAIL            # API user email
ZENDESK_API_TOKEN        # API token
ZENDESK_WEBHOOK_TOKEN    # Bearer token for webhook auth (custom)

PO_STATUS_FIELD_ID       # Custom field ID (45116435108627)
PO_RESULT_SHA_FIELD_ID   # Optional: SHA256 hash field
PO_JSON_ATTACHMENT_ID_FIELD_ID  # Optional: JSON attachment ID field
```

#### OpenAI Configuration
```
OPENAI_API_KEY           # GPT-5 API key
OPENAI_REQUEST_TIMEOUT_MS  # Timeout in ms (default: 420000 = 7 min)
```

#### Fulcrum Configuration
```
FULCRUM_TOKEN            # API token
FULCRUM_DOMAIN           # API domain (unused, API_URL set to default)
FULCRUM_ITEMS_BUCKET     # S3 bucket name
FULCRUM_ITEMS_KEY        # S3 object key (default: items.json)
FULCRUM_ITEMS_PATH       # Optional: local file path (for dev)
```

#### AWS Configuration
```
AWS_REGION               # e.g., "us-west-1"
SES_REGION               # Email region (defaults to AWS_REGION)
SES_FROM                 # Sender email address
NOTIFY_EMAIL             # Alert recipient (optional, handler hardcodes to dreuven)
NOTIFY_SUBJECT_PREFIX    # Email prefix (default: "[PO Pipeline]")
```

#### SQS Configuration
```
PO_QUEUE_URL             # Auto-injected by Serverless
```

#### Feature Flags
```
ORDER_TRACKING_CONFIDENCE_THRESHOLD  # Min confidence for order tracking (default: 0.85)
```

### Serverless Deployment

**File**: `serverless.yml`

```yaml
service: po-processor
runtime: nodejs20.x
region: us-west-1 (default)
memorySize: 512 MB (ingest), 1024 MB (worker)
timeout: 10 seconds (ingest), 900 seconds (worker)
logRetention: 7 days

Functions:
  ingest:
    - HTTP POST /ingest
    - 10 second timeout
    - 512 MB memory

  worker:
    - SQS trigger (batchSize: 1)
    - 900 second timeout
    - 1024 MB memory

Queue:
  po-processor-queue-prod
  ├─ Visibility: 960 seconds
  ├─ Max Receives: 3
  └─ DLQ: po-processor-dlq-prod

IAM Permissions:
  - sqs:SendMessage (ingest)
  - sqs:ReceiveMessage, DeleteMessage, ChangeMessageVisibility (worker)
  - s3:GetObject, ListBucket (worker)
  - ses:SendEmail, SendRawEmail (worker)
```

**Deploy**:
```bash
npm run build      # Compile TypeScript
npm run deploy     # Deploy to AWS
npm run remove     # Tear down resources
npm run logs:worker # View worker logs
```

**Development**:
```bash
npm run dev        # Local testing with tsx
npm run dev -- --worker --ticket 21083  # Test specific ticket
```

### Build Configuration

**TypeScript** (`tsconfig.json`):
```json
{
  "target": "ES2022"
  "module": "ESNext"
  "moduleResolution": "Bundler"
  "strict": true
  "outDir": "dist"
}
```

**Serverless esbuild**:
```yaml
esbuild:
  bundle: true
  minify: false          # Keep readable in Lambda logs
  sourcemap: true       # CloudWatch debugging
  target: node20
  define:
    "require.resolve": undefined  # Avoid runtime errors
```

### Local Development

**File**: `src/local.ts`

Allows testing without AWS:
```bash
# Test ingest
npm run dev

# Test worker with specific ticket
npm run dev -- --worker --ticket 21083

# Test without SQS (simulates local queue)
FULCRUM_ITEMS_PATH=./items-local.json npm run dev -- --worker --ticket 21083
```

---

## Testing

### Test Files

```
test-env.ts              # Environment variable loading
test-fuzzy-matching.ts   # Fuzzy PO matching unit tests (21 cases)
test-fuzzy-fulcrum.ts    # Integration tests with real Fulcrum API
test-order-tracking.ts   # Order tracking logic tests
test-fulcrum-order.ts    # Fulcrum sales order fetching
test-sorted-search.ts    # Paginated search logic
test-pdf-classification.ts  # Multi-PDF classification
test-po263601.ts         # Specific PO processing test
```

### Test Coverage

#### Fuzzy Matching (`test-fuzzy-matching.ts`)
- 21 unit tests covering:
  - Exact matches (1.0 confidence)
  - Prefix variations (PO, PO-, PO )
  - Suffix variations (-XP, XP)
  - Combined variations
  - Whitespace variations
  - Bidirectional matching
  - Non-matches
  - Empty strings

**Results**: ✅ 21/21 passed

#### Integration Tests (`test-fuzzy-fulcrum.ts`)
- Real Fulcrum API calls with 6 PO formats:
  - `"400203171"` → Order #6273 (1.0)
  - `"PO 400203171"` → Order #6273 (0.95)
  - `"PO-400203171"` → Order #6273 (0.95)
  - `"400203171-XP"` → Order #6273 (0.95)
  - `"PO 400203171-XP"` → Order #6273 (0.95)
  - `"400 203 171"` → Order #6273 (0.95)

**Results**: ✅ All formats matched correctly

### How to Run Tests

```bash
# Run specific test
npm run dev -- test-fuzzy-matching.ts

# Run with env vars
FULCRUM_TOKEN=... npm run dev -- test-fuzzy-fulcrum.ts

# Test specific functionality
npm run dev -- --worker --ticket 21083
```

---

## Key Patterns & Conventions

### 1. Error Handling

**Graceful Degradation Pattern**:
- User errors → ProcessingResult with requiresHumanReview=true
- System errors → Throw for retry or alert email
- Quota errors → Alert email + exit gracefully (no retry)

**Tag Cleanup Pattern**:
- Always use try-finally for tag removal
- Remove at all exit points (success, early return, error)
- Prevents webhook re-triggering and stuck tickets

### 2. AI Integration

**Consistent API Pattern**:
```typescript
postJsonWithRetry<T>(
  url: string,
  body: any,
  maxRetries = 2,
  timeoutMs = OPENAI_REQUEST_TIMEOUT_MS
): Promise<T>
```

All AI calls use same pattern:
- Timeout enforcement via AbortController
- Exponential backoff: 500ms × attempt
- Max 2 retries
- Extract output text from Responses API format

### 3. Data Flow

**Transformation Pattern**:
```
Raw Data → Type Definition → Enrichment → Validation → Result
  PDF        ParsedPO        Fulcrum    Pricing       UpdateTicket
  Ticket     TicketContext   AI Matching Confidence   ProcessingResult
```

### 4. Naming Conventions

**Functions**:
- `get*`: Fetch data (e.g., `getTicketPdfUrl`)
- `fetch*`: Remote API call (e.g., `fetchFulcrumData`)
- `extract*`: Parse/transform (e.g., `extractTicketContext`)
- `handle*`: Process logic (e.g., `handleOrderTracking`)
- `update*`: Zendesk write (e.g., `updateTicketWithResult`)

**Variables**:
- `po*`: Purchase order related
- `*Customer`: Customer data
- `*Item`: Product item data
- `*Shipment`: Shipment/delivery data

### 5. Configuration

All configurable knobs in `config.ts`:
- Thresholds: CUSTOMER_MATCH_THRESHOLD, ITEM_MATCH_THRESHOLD
- Overrides: CUSTOMER_NAME_OVERRIDES
- Retry policy: DEFAULT_RETRIES
- Prompt context: PROMPT_HINTS

### 6. Logging

Consistent log prefixes for easy filtering:
- `[addProcessingTag]`
- `[getTicketPdfUrl]`
- `[OrderTracking]`
- `[PDF Classification]`
- `[Fuzzy Match]`
- `[ResponseGeneration]`

---

## Implementation Notes

### Critical Design Decisions

1. **Per-Ticket State Isolation**
   - Handler processes 1 SQS message (1 ticket) at a time
   - No shared state between tickets
   - Atomic processing: succeed or fail completely

2. **Graceful Queue Integration**
   - Ingest returns 202 immediately (not waiting for processing)
   - Worker takes up to 15 minutes
   - Failed messages go to DLQ after 3 retries
   - Operator intervention required for DLQ messages

3. **AI as Decision Maker**
   - Intent classification determines routing
   - Confidence thresholds prevent risky auto-responses
   - Draft responses included for human review
   - No email sent to customer without human approval

4. **Fulcrum Catalog Caching**
   - Uses S3 (not Fulcrum API) for catalog
   - Updated daily by FulcrumItemSync Lambda
   - Reduces API calls and latency
   - Region-locked: Must be same region as Lambda

5. **Fuzzy Matching**
   - Conservative: Only removes known formatting
   - Bidirectional: Normalizes both sides before comparison
   - Confidence-based: 1.0 exact, 0.95 normalized, 0.0 no match
   - Framework ready for Levenshtein distance (future)

6. **Multi-PO Support**
   - Intent classification extracts ALL PO numbers
   - ORDER_TRACKING can handle 1 or many
   - Results summarized in single response
   - Parallel tracking for performance

### Known Limitations

1. **PRODUCT_QUESTION Handler**: Not yet implemented (returns for human review)
2. **Eligibility Check**: Stubbed (returns eligible for all customers)
3. **DynamoDB Integration**: Not yet implemented (pricing uses S3 Fulcrum data)
4. **Levenshtein Distance**: Not yet implemented (only exact + normalized matching)
5. **Ticket History**: Only processes current ticket (no cross-ticket context)

### Future Enhancements

- [ ] Implement PRODUCT_QUESTION handler with knowledge base integration
- [ ] Implement real customer eligibility checks (DynamoDB + domain verification)
- [ ] Add Levenshtein distance for typo handling in PO numbers
- [ ] Store conversation history for multi-turn interactions
- [ ] Customer-specific confidence thresholds
- [ ] A/B testing framework for response generation
- [ ] Sentiment analysis for escalation detection
- [ ] Automatic DLQ re-queuing with exponential backoff

---

## Monitoring & Observability

### CloudWatch Logs

**Log Groups**:
- `/aws/lambda/po-processor-ingest-prod`
- `/aws/lambda/po-processor-worker-prod`

**Key Log Patterns**:
```
[getTicketPdfUrl] Fetching PDFs for ticket {id}
[getTicketPdfUrl] Found {n} PDF(s)
[OrderTracking] Tracking PO: {po}
[Fulcrum] Searching for PO: "{po}" (normalized: "{normalized}")
[PDF Classification] Analyzing: {filename}
[ResponseGeneration] Generating tracking response
```

### Metrics to Monitor

**SQS**:
- ApproximateNumberOfMessagesVisible (messages in queue)
- ApproximateNumberOfMessagesNotVisible (processing)
- SqsLargestMessageSize
- NumberOfMessagesSent

**Lambda**:
- Duration (worker: should be <900s for graceful shutdown)
- Errors (fatal exceptions)
- Throttles (capacity issues)
- Concurrent Executions

**DLQ**:
- Message Count (should be zero; indicates persistent errors)

### Alert Conditions

**Critical**:
- DLQ message count > 0
- Worker Lambda errors > 5 per hour
- Worker Lambda duration > 800 seconds (running out of time)
- SQS queue depth > 50 (backlog building up)

**Warning**:
- OpenAI quota alerts (from email notifications)
- Zendesk API 429 errors (rate limiting)
- Fulcrum API connection failures

---

## Appendix: File Reference

### Source Files

| File | Purpose | Lines | Key Functions |
|------|---------|-------|---|
| handler.ts | Lambda entry points | 301 | ingest(), worker(), processRecord() |
| types.ts | Type definitions | 386 | STATUS, IntentClassification, ParsedPO, TrackingResult |
| config.ts | Configuration | 40 | CUSTOMER_NAME_OVERRIDES, thresholds, hints |
| env.ts | Env loading | 5 | dotenv.config() |
| zendesk.ts | Zendesk API | 549 | extractTicketContext(), getTicketPdfUrl(), updateTicketWithResult() |
| classification.ts | Intent classification | 222 | classifyTicketIntent() |
| routing.ts | Intent routing | 446 | handleTicketIntent(), processPurchaseOrderWrapper(), handleOrderTracking() |
| openai.ts | GPT-5 integration | 200+ | analyzePdfAndBuildPO(), callCustomerMatchAI() |
| pdf-classification.ts | PDF classification | 242 | classifyPdfAttachments() |
| matching.ts | Fuzzy matching | 150+ | matchCustomer(), enrichWithFulcrumAndAI() |
| pricing.ts | Price validation | 151 | validatePricing() |
| s3.ts | S3 catalog loading | 85 | fetchFulcrumData() |
| fulcrum.ts | Fulcrum API | 150+ | findSalesOrdersByPO(), normalizePO(), calculatePOMatchConfidence() |
| order-tracking.ts | Order tracking | 100+ | trackOrder() |
| response-generation.ts | Response generation | 150+ | generateTrackingResponse(), generateMultiTrackingResponse() |
| ses.ts | Email notifications | 61 | sendAlertEmail(), notifyFailure() |
| utils.ts | Utilities | 6 | toFixed2(), isNonEmpty() |
| local.ts | Development | 50+ | Local testing helpers |

### Configuration Files

| File | Purpose |
|------|---------|
| serverless.yml | Lambda deployment & IaC |
| package.json | Dependencies & scripts |
| tsconfig.json | TypeScript compilation |
| dummy.env | Example environment variables |

### Documentation

| File | Purpose |
|------|---------|
| AGENTS.md | This comprehensive guide and repo operating rules |
| SPECS/fuzzy-po-matching.md | Fuzzy matching implementation details |

---

## Summary

The **PoProcessor Lambda** is a sophisticated, production-grade system that:

1. **Intelligently routes** customer tickets using AI intent classification
2. **Processes purchase orders** by extracting data from PDFs and matching customers/items
3. **Tracks orders** through Fulcrum ERP with fuzzy matching for formatting variations
4. **Generates responses** using GPT-5 with confidence-based human review gating
5. **Handles errors gracefully** with quota detection, tag cleanup, and alert emails
6. **Scales efficiently** with SQS queue, parallel Fulcrum requests, and S3 caching

Key architectural strengths:
- **Modular design**: Each concern isolated in separate module
- **Type safety**: Comprehensive TypeScript type definitions
- **Error resilience**: Quota detection, retry logic, graceful degradation
- **Observability**: Consistent logging, CloudWatch integration
- **Extensibility**: Framework ready for new intent types and features
- **Testing**: Unit and integration tests covering critical paths

The system is in active production use, processing purchase orders and order tracking requests for RSG Security customers with high reliability and user satisfaction.
