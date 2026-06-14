# PoProcessor Lambda - AI Customer Service Representative

## Overview

The PoProcessor Lambda has been generalized from a simple Purchase Order processor into a comprehensive AI-powered customer service representative. It uses GPT-5 to classify ticket intent and route to specialized handlers, with the existing PO processing preserved as one of several intent handlers.

## Architecture

### File Structure

```
src/
├── handler.ts           # Main Lambda orchestrator (5-step flow)
├── types.ts             # TypeScript interfaces
├── zendesk.ts           # Zendesk API interactions + ticket extraction
├── eligibility.ts       # Customer eligibility checking (stubbed)
├── classification.ts    # AI intent classification (GPT-5)
├── routing.ts           # Intent routing + handler implementations
├── ses.ts               # Email notifications
├── openai.ts            # OpenAI API calls (existing + new)
├── matching.ts          # Customer/item matching (existing)
├── pricing.ts           # Pricing validation (existing)
├── s3.ts                # Fulcrum catalog from S3 (existing)
├── config.ts            # Configuration (existing)
└── utils.ts             # Utilities (existing)
```

### Core Data Flow

```
Zendesk Webhook
    ↓
SQS Queue
    ↓
Lambda Worker
    ↓
Step 1: Extract Ticket Context (extractTicketContext)
    ↓
Step 2: Check Customer Eligibility (shouldAiAutoRespond) [STUBBED]
    ↓
Step 3: Classify Intent (classifyTicketIntent)
    ↓
Step 4: Route to Handler (handleTicketIntent)
    ↓
Step 5: Update Ticket + Send Alerts (updateTicketWithResult)
```

## Key Components

### 1. Ticket Context Extraction (`zendesk.ts`)

**Function**: `extractTicketContext(ticketId: number): Promise<TicketContext>`

**What it fetches:**
- Ticket metadata (subject, description, status, priority, tags, custom fields)
- Requester information (id, name, email, organization_id)
- Submitter information (same fields)
- Full comment history with **per-comment attachments preserved**
- Latest public comment (for AI context)
- Private notes (separate from public comments)

**Critical Implementation Detail**: Each `TicketComment` maintains its own `attachments[]` array, ensuring attachment-to-comment associations are preserved even for multi-comment conversations.

**API Calls:**
- `GET /api/v2/tickets/{ticketId}.json?include=users` - Ticket + user data
- `GET /api/v2/tickets/{ticketId}/comments.json` - Full comment history

### 2. Customer Eligibility (`eligibility.ts`)

**Function**: `shouldAiAutoRespond(requesterEmail: string): Promise<EligibilityResult>`

**Current Implementation**: **STUBBED** - Always returns `{ eligible: true }`

**Future Implementation Plan:**
```typescript
// TODO: Implement the following logic:
// 1. Extract domain from email (e.g., "john@acme.com" → "acme.com")
// 2. Query DynamoDB table: customer-pricing-domains-prod
//    - PK: DOMAIN#<domain>
// 3. Check if domain exists and has tier_id (verified customer)
// 4. Optional: Check customer opt-in preferences
// 5. Optional: Check historical AI success rate for this customer
// 6. Return { eligible: true/false, reason: "..." }
```

**Execution Order**: Runs **BEFORE** intent classification to avoid wasting OpenAI credits on ineligible customers.

### 3. Intent Classification (`classification.ts`)

**Function**: `classifyTicketIntent(ticketContext: TicketContext): Promise<IntentClassification>`

**Intent Categories:**
1. **PURCHASE_ORDER** - Customer submitting a new PO (usually with PDF)
2. **ORDER_TRACKING** - Questions about existing order status/shipping
3. **PRODUCT_QUESTION** - Questions about products, specs, pricing, availability
4. **OTHER** - General inquiries that don't fit above

**AI Model**: GPT-5 via OpenAI Responses API

**Confidence Threshold**: 0.8 (80%)
- Below threshold → flags for human review
- Configurable via classification logic

**PO Status Safety Check**:
```typescript
const poAlreadyProcessed = [
  'processing',
  'ready_to_review',
  'review_failed',
  'submitted_to_fulcrum'
].includes(currentPoStatus);
```

If PO already processed AND AI classifies as PURCHASE_ORDER AND `isNewPurchaseOrder === false`, the system:
- Overrides classification to `OTHER`
- Sets `requiresHumanReview: true`
- Prevents duplicate PO processing

**Custom Field Used**: `PO_STATUS_FIELD_ID` (default: 45116435108627)

**Prompt Strategy**:
- Provides ticket subject, description, latest public comment
- Lists attachment types and counts
- Includes current PO status and tags for context
- Requests JSON response with strict schema
- Extracts key entities (PO numbers, order numbers, product SKUs, urgency)

### 4. Intent Routing (`routing.ts`)

**Function**: `handleTicketIntent(ticketContext, intent): Promise<ProcessingResult>`

**Current Handler Implementations:**

#### PURCHASE_ORDER Handler
- **Status**: ✅ **FULLY IMPLEMENTED**
- **Implementation**: `processPurchaseOrderWrapper()`
- **Logic**:
  1. Finds PDF via `getTicketPdfUrl()` (checks comments first, then ticket attachments)
  2. Calls existing PO pipeline:
     - `analyzePdfAndBuildPO()` - GPT-5 Vision extraction
     - `fetchFulcrumData()` - Load S3 catalog
     - `enrichWithFulcrumAndAI()` - Customer/item matching + pricing
     - `updateTicketWithPO()` - Attach JSON + set status to `ready_to_review`
  3. Returns success with friendly draft response
- **Draft Response Example**:
  ```
  Hi {FirstName},

  Thank you for your purchase order! We've received it and are processing your request.
  Our team will review the details and get back to you shortly with confirmation.

  Best regards,
  RSG Security Team
  ```

#### ORDER_TRACKING Handler
- **Status**: ⚠️ **STUBBED**
- **Current Behavior**: Returns `AI_ALERT_HUMAN_REVIEW_REQUIRED` tag + internal note
- **Future Implementation**:
  ```typescript
  // TODO:
  // 1. Extract order number from intent.keyEntities.orderNumber
  // 2. Query Fulcrum API: GET /api/sales-orders/{orderNumber}
  // 3. Extract shipping status, tracking number, delivery date
  // 4. Generate friendly response with status update
  // 5. Return ProcessingResult with publicResponse
  ```

#### PRODUCT_QUESTION Handler
- **Status**: ⚠️ **STUBBED**
- **Current Behavior**: Returns `AI_ALERT_HUMAN_REVIEW_REQUIRED` tag + internal note
- **Future Implementation**:
  ```typescript
  // TODO:
  // 1. Extract product SKUs from intent.keyEntities.productSkus
  // 2. Perform RAG search against Contentful product catalog
  // 3. Use GPT-5 to generate answer based on product data
  // 4. Include specs, pricing, availability
  // 5. Return ProcessingResult with publicResponse
  ```

#### OTHER Handler
- **Status**: ✅ **IMPLEMENTED**
- **Behavior**: Always flags for human review with reasoning from AI

**Error Handling**: All handlers wrapped in try-catch that:
- Logs error to CloudWatch
- Sends alert email to `dreuven@rsgsecurity.com`
- Returns `AI_ALERT_HUMAN_REVIEW_REQUIRED` result
- Does NOT throw (returns gracefully)

### 5. Ticket Updates (`zendesk.ts`)

**Function**: `updateTicketWithResult(ticketId, result, requesterFirstName): Promise<void>`

**What it does:**
1. Builds comment body with optional draft public response
2. Adds tag (`AI_READY_FOR_HUMAN_REVIEW` or `AI_ALERT_HUMAN_REVIEW_REQUIRED`)
3. Posts private comment with internal note

**Draft Response Format**:
```
[DRAFT PUBLIC RESPONSE - DO NOT SEND YET]

Hi {FirstName},

{Friendly customer-facing message}

Best regards,
RSG Security Team

================================================================================

{Internal note with technical details}
```

**Note**: Zendesk API doesn't support true "draft" comments, so we use private notes with a clear prefix. Agents must copy/paste into public response manually.

**Tags Used:**
- `AI_READY_FOR_HUMAN_REVIEW` - Processing succeeded, review before sending to customer
- `AI_ALERT_HUMAN_REVIEW_REQUIRED` - Error occurred or feature not implemented

## Type System

### Core Interfaces

```typescript
// Ticket data with full context
interface TicketContext {
  ticketId: number;
  subject: string;
  description: string;
  status: string;
  priority: string;
  requester: TicketUser;
  submitter: TicketUser;
  comments: TicketComment[];        // Full history
  latestPublicComment?: TicketComment;
  privateNotes: TicketComment[];    // Filtered view
  customFields: Array<{ id: number; value: any }>;
  tags: string[];
}

// Comment with per-comment attachments
interface TicketComment {
  id: number;
  type: 'Comment' | 'VoiceComment';
  author_id: number;
  body: string;
  html_body?: string;
  plain_body?: string;
  public: boolean;
  created_at: string;
  attachments: TicketAttachment[];  // CRITICAL: Per-comment attachments
}

// AI classification result
interface IntentClassification {
  intent: 'PURCHASE_ORDER' | 'ORDER_TRACKING' | 'PRODUCT_QUESTION' | 'OTHER';
  confidence: number;              // 0.0 to 1.0
  reasoning: string;
  isNewPurchaseOrder?: boolean;
  requiresHumanReview?: boolean;
  humanReviewReason?: string;
  keyEntities?: {
    poNumber?: string;
    orderNumber?: string;
    productSkus?: string[];
    urgencyLevel?: 'low' | 'medium' | 'high';
  };
}

// Handler result
interface ProcessingResult {
  success: boolean;
  requiresHumanReview: boolean;
  reason: string;
  tag: 'AI_READY_FOR_HUMAN_REVIEW' | 'AI_ALERT_HUMAN_REVIEW_REQUIRED';
  internalNote: string;            // Always added to ticket
  publicResponse?: string | null;  // Optional draft response
  data?: any;                      // Handler-specific data
}
```

## Error Handling Strategy

### Multi-Layer Error Handling

**Layer 1: Handler-Level** (`routing.ts`)
- Each handler has internal try-catch
- Returns `ProcessingResult` with error details
- Never throws

**Layer 2: Router-Level** (`routing.ts`)
- Wraps all handler calls in try-catch
- Sends email alert to `dreuven@rsgsecurity.com`
- Returns `AI_ALERT_HUMAN_REVIEW_REQUIRED` result

**Layer 3: Main Handler** (`handler.ts`)
- Wraps entire processing flow in try-catch
- Updates ticket with critical error message
- Sends detailed email with stack trace
- Re-throws error for SQS retry logic

### Email Alert Strategy

**Non-Blocking**: Uses `sendAlertEmail()` which catches errors internally

**Alert Triggers:**
1. Customer not eligible (if eligibility check fails in future)
2. Low confidence classification (< 0.8)
3. PO already processed (duplicate prevention)
4. Handler execution error
5. Fatal error in main flow

**Alert Email Contents:**
- Ticket ID and Zendesk link
- Error message and stack trace
- Intent classification details
- Requester information
- Ticket subject

**Recipient**: `dreuven@rsgsecurity.com` (hardcoded)

**SES Configuration**: Uses `SES_FROM` environment variable

## Environment Variables

**Required:**
- `OPENAI_API_KEY` - GPT-5 API access
- `ZENDESK_SUBDOMAIN` - Zendesk subdomain (e.g., "rsgsecurity")
- `ZENDESK_EMAIL` - Zendesk API user email
- `ZENDESK_API_TOKEN` - Zendesk API token
- `SES_FROM` - Email sender address
- `AWS_REGION` - AWS region for SES/S3/DynamoDB

**Optional:**
- `PO_STATUS_FIELD_ID` - Custom field ID for PO status (default: 45116435108627)
- `OPENAI_REQUEST_TIMEOUT_MS` - OpenAI timeout (default: 420000 = 7 minutes)
- `NOTIFY_EMAIL` - Fallback email for legacy notifications

## Key Architecture Decisions

### 1. **Per-Comment Attachment Preservation**
**Decision**: Each `TicketComment` has its own `attachments[]` array
**Rationale**: Multi-turn conversations may have different attachments per comment. Critical for ORDER_TRACKING where customer might upload shipping docs in follow-up.
**Alternative Considered**: Flattened `allAttachments[]` array
**Why Rejected**: Loses comment-to-attachment association, making it impossible to know which comment had which file.

### 2. **Eligibility Check Before Classification**
**Decision**: Run `shouldAiAutoRespond()` before calling OpenAI
**Rationale**: Avoid wasting API credits on ineligible customers
**Trade-off**: Adds latency even when stubbed, but saves cost at scale

### 3. **PO Status Safety Check**
**Decision**: Override AI classification if PO already processed
**Rationale**: Prevents expensive duplicate processing and data corruption
**Implementation**: Checks custom field `po_status` before accepting PURCHASE_ORDER intent
**Edge Case Handling**: If customer submits a NEW PO on same ticket, AI sets `isNewPurchaseOrder: true`

### 4. **Confidence Threshold of 0.8**
**Decision**: Require 80% confidence for autonomous processing
**Rationale**: Balance between automation and safety
**Tunable**: Can be adjusted based on production metrics
**Alternative**: Dynamic threshold based on intent type (e.g., 0.9 for PURCHASE_ORDER, 0.7 for PRODUCT_QUESTION)

### 5. **Draft Responses in Private Notes**
**Decision**: Use private notes with `[DRAFT PUBLIC RESPONSE]` prefix instead of true drafts
**Rationale**: Zendesk API doesn't support draft comments
**Alternatives Considered**:
  - Custom Zendesk app with draft storage
  - DynamoDB table for drafts
  - API endpoint to create drafts
**Why Rejected**: Adds complexity, agents can copy/paste from private note

### 6. **Modular Handler Pattern**
**Decision**: Each intent gets its own handler function, called via switch statement
**Rationale**: Easy to add new intents without touching router logic
**Trade-off**: More files, but better separation of concerns
**Future-Proof**: Can extract handlers to separate Lambda functions if needed

### 7. **Existing PO Logic Preserved**
**Decision**: Wrap existing PO processing instead of refactoring
**Rationale**: Minimize risk, existing code is battle-tested
**Implementation**: `processPurchaseOrderWrapper()` calls original functions
**Benefit**: Can revert to old behavior by switching Lambda versions

### 8. **Non-Blocking Email Alerts**
**Decision**: Email failures don't crash the Lambda
**Rationale**: Ticket updates are more critical than notifications
**Implementation**: `sendAlertEmail()` catches all errors internally
**Trade-off**: Might miss alerts if SES is down, but Lambda continues

## Known Issues & TODOs

### Pre-Existing TypeScript Errors
The codebase has pre-existing TypeScript compilation errors (not introduced by this implementation):

**Files with errors:**
- `src/matching.ts` - Missing properties on FulcrumItem/Customer types
- `src/pricing.ts` - Missing PricingMismatch export
- `src/s3.ts` - Incorrect type extensions (itemCount, customerCount)
- `src/zendesk.ts` - Node module import issues

**Action Required**: These should be fixed separately to ensure clean builds.

### Unused Imports (New Code)
The following unused imports were flagged by TypeScript but are intentional:

**`routing.ts`:**
- `ParsedPO` - Used in type annotation that may be inferred
- `notifyFailure` - Kept for potential future use
- `intent` parameter - Used in wrapper, but not directly in some branches

**Action**: Clean up or suppress warnings with `// @ts-ignore` if intended

### Critical TODOs

#### High Priority

1. **Implement Customer Eligibility** (`eligibility.ts`)
   - Add DynamoDB client
   - Query `customer-pricing-domains-prod` table
   - Extract domain from email using PSL library
   - Handle multi-level TLDs (e.g., `mail.acme.com` → `acme.com`)
   - Add error handling for DynamoDB failures

2. **Fix TypeScript Compilation Errors**
   - Add missing type properties
   - Fix Node module imports
   - Ensure clean build before deployment

3. **Add Integration Tests**
   - Test each intent classification
   - Test PO duplicate prevention
   - Test error handling flows
   - Test email alert delivery

#### Medium Priority

4. **Implement ORDER_TRACKING Handler** (`routing.ts`)
   - Query Fulcrum Sales Orders API
   - Extract tracking info
   - Generate friendly status update
   - Handle "order not found" cases

5. **Implement PRODUCT_QUESTION Handler** (`routing.ts`)
   - Integrate with Contentful API
   - Build RAG pipeline (embeddings + vector search)
   - Use GPT-5 to generate answers
   - Cite sources in response

6. **Add Observability**
   - CloudWatch metrics for intent distribution
   - Confidence score histogram
   - Success/failure rates by intent
   - Email alert delivery tracking

#### Low Priority

7. **Dynamic Confidence Thresholds**
   - Different thresholds per intent type
   - Historical success rate tracking
   - Adaptive thresholds based on performance

8. **Customer Opt-In Management**
   - DynamoDB table for opt-in preferences
   - Admin UI for managing opt-ins
   - Opt-out handling in emails

9. **Multilingual Support**
   - Detect ticket language
   - Use appropriate GPT-5 model
   - Translate draft responses

## Testing Strategy

### Unit Tests (Future)
```typescript
// eligibility.ts
describe('shouldAiAutoRespond', () => {
  it('returns eligible for verified domain');
  it('returns not eligible for unknown domain');
  it('handles DynamoDB errors gracefully');
});

// classification.ts
describe('classifyTicketIntent', () => {
  it('classifies PO submission correctly');
  it('detects duplicate PO attempts');
  it('flags low confidence classifications');
  it('extracts key entities from ticket');
});

// routing.ts
describe('handleTicketIntent', () => {
  it('routes PURCHASE_ORDER to PO handler');
  it('stubs ORDER_TRACKING handler');
  it('handles errors and sends alerts');
});
```

### Integration Tests (Future)
```typescript
describe('End-to-End Flow', () => {
  it('processes new PO ticket successfully');
  it('prevents duplicate PO processing');
  it('handles missing PDF attachment');
  it('sends email alerts on errors');
  it('updates ticket with correct tags');
});
```

### Manual Testing Checklist

**Before Deployment:**
- [ ] Create test ticket with PDF → verify PO processing
- [ ] Create test ticket asking about order → verify ORDER_TRACKING stub
- [ ] Create test ticket asking product question → verify PRODUCT_QUESTION stub
- [ ] Create ticket with existing PO status → verify duplicate prevention
- [ ] Trigger error in handler → verify email alert sent
- [ ] Check ticket tags are applied correctly
- [ ] Check draft responses appear in private notes
- [ ] Verify first name extraction works

**After Deployment:**
- [ ] Monitor CloudWatch logs for errors
- [ ] Check email alerts in dreuven@rsgsecurity.com inbox
- [ ] Verify Zendesk tickets are tagged correctly
- [ ] Confirm agents can see draft responses
- [ ] Check SQS DLQ for failed messages

## Deployment

### Build & Deploy
```bash
cd /Users/dreuven/Projects/RSG/CSDroid

# Install dependencies
npm install

# Build TypeScript
npm run build

# Deploy to AWS
npm run deploy
```

### Serverless Configuration
The Lambda is deployed using Serverless Framework. Key configuration:

**Functions:**
- `ingest` - API Gateway endpoint for Zendesk webhooks
- `worker` - SQS queue consumer (15-minute timeout)

**Resources:**
- SQS Queue: `PoProcessorQueue`
- Dead Letter Queue: `PoProcessorDLQ`

**Environment Variables**: Configured in `serverless.yml`

### Rollback Strategy
If issues occur after deployment:

1. **Quick Rollback**: Deploy previous version
   ```bash
   serverless deploy --stage prod --version <previous-version>
   ```

2. **Partial Rollback**: Comment out new code in `handler.ts`, revert to old flow
   ```typescript
   // Temporarily bypass new flow
   const USE_LEGACY_FLOW = true;
   if (USE_LEGACY_FLOW) {
     // Old processRecord logic here
   }
   ```

3. **Lambda Version**: Use AWS Lambda versioning to revert instantly

## Monitoring & Alerts

### CloudWatch Logs
Key log messages to watch:

```
"Step 1: Extracting ticket context..."
"Step 2: Checking customer eligibility..."
"Step 3: Classifying ticket intent..."
"Step 4: Routing to handler..."
"Step 5: Updating ticket..."
"Processing complete"
```

### Error Patterns
```
"Fatal error processing ticket:"
"Error in handler for intent"
"Failed to send alert email"
```

### Metrics to Track
- Intent distribution (% of each intent type)
- Average confidence scores
- Success rate by intent
- Email alert delivery rate
- SQS DLQ message count
- Lambda execution duration

## Future Enhancements

### Phase 1: Complete Core Features (Q1 2025)
- [ ] Implement customer eligibility checking
- [ ] Implement ORDER_TRACKING handler
- [ ] Implement PRODUCT_QUESTION handler
- [ ] Fix TypeScript compilation errors
- [ ] Add comprehensive tests

### Phase 2: Observability (Q2 2025)
- [ ] CloudWatch dashboards
- [ ] Slack alerts for critical errors
- [ ] Intent classification accuracy tracking
- [ ] A/B testing framework for prompts

### Phase 3: Advanced Features (Q3 2025)
- [ ] Multi-turn conversations (context retention)
- [ ] Proactive suggestions to agents
- [ ] Customer satisfaction scoring
- [ ] Automated responses (no human review)

### Phase 4: Scale & Optimize (Q4 2025)
- [ ] Separate Lambda per intent handler
- [ ] Caching layer for Fulcrum data
- [ ] Batch processing for high volume
- [ ] Cost optimization (smaller models for classification)

## Contributing

When adding new intent handlers:

1. **Add Intent Type** to `IntentClassification` in `types.ts`
2. **Update Classification Prompt** in `classification.ts`
3. **Add Handler Function** in `routing.ts`
4. **Add Switch Case** in `handleTicketIntent()`
5. **Write Tests** for the new handler
6. **Update `SPECS/system-spec.md`** with implementation details

## References

- **Zendesk API Docs**: https://developer.zendesk.com/api-reference/
- **OpenAI Responses API**: https://platform.openai.com/docs/api-reference/responses
- **AWS Lambda Best Practices**: https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html
- **Better Auth Docs**: https://www.better-auth.com/docs
- **Contentful API**: https://www.contentful.com/developers/docs/

---

**Last Updated**: December 23, 2024
**Version**: 1.0.0
**Maintainer**: dreuven@rsgsecurity.com
