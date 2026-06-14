// src/types.ts
// Complete type definitions for the PO pipeline

export const STATUS = {
  PROCESSING: "processing",
  READY: "ready_to_review",
  FAILED: "review_failed",
  NO_PDF: "has_no_pdf",
  SUBMITTED: "submitted_to_fulcrum",
} as const;

export interface IngestPayload {
  ticket_id: number;
  attempt: number;
}

export interface ShippingAddress {
  name?: string | null;
  raw?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  stateProvince?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface PurchaseOrderItem {
  description?: string;
  unit_price?: number | null;
  quantity?: number | null;
  total?: number | null;
  date_scheduled?: string | null;
  matched_item_number?: string | null;
  matched_item_id?: string | null;
  match_confidence?: number | null;
  item_warnings?: string[];
  fulcrum_price?: number | null;
  price_mismatch?: boolean;
  price_difference?: number | null;
  pricing_tier_used?: string | null;
}

export interface MatchedCustomer {
  name: string;
  customer_id: string;
  tier_id: string | null;
  tier_name: string | null;
  confidence: number;
}

export interface ParsedPO {
  company_name?: string;
  mark_for?: string;
  shipping_address?: ShippingAddress;
  delivery_date?: string;
  currency?: string;
  purchase_order?: {
    purchase_order_number?: string;
    currency?: string;
    total_cost?: number | null;
    items?: PurchaseOrderItem[];
  };
  matched_customer?: MatchedCustomer | null;
  warnings?: string[];
  validation?: {
    customer_matched: boolean;
    all_items_matched: boolean;
    all_prices_valid: boolean;
    requires_manual_review: boolean;
  };
  pdfUrl?: string;
  raw_response?: string; // Fallback for unparseable responses
}

export interface CustomerMatchResponse {
  matched_customer_name?: string | null;
  confidence: number;
  reasoning: string;
  warning?: string | null;
}

export interface ItemMatch {
  po_line_description: string;
  matched_item_number?: string | null;
  matched_item_id?: string | null;
  confidence: number;
  reasoning: string;
  warning?: string | null;
}

export interface ItemMatchResponse {
  matches: ItemMatch[];
}

export interface FulcrumCustomer {
  id: string;
  name: string;
  customerTierId?: string | null;
  customerTierName?: string | null;
  tier_id?: string | null;
  tier_name?: string | null;
}

export interface FulcrumItem {
  id: string;
  number: string;
  description: string;
  customerTiers?: Array<{
    customerTier?: {
      id?: string;
      name?: string;
    };
    priceBreaks?: Array<{
      quantity: number;
      price: number;
    }>;
  }>;
  base_price?: number;
  tier_prices?: Record<string, number>;
}

export interface FulcrumCatalog {
  lastSyncedAt?: string;
  Customers: {
    customerCount: number;
    customersByName: Record<string, FulcrumCustomer>;
  };
  SellableItems: {
    itemCount: number;
    itemsByNumber: Record<string, FulcrumItem>;
  };
}

// ============================================================
// New types for generalized AI Customer Service Rep
// ============================================================

/**
 * Ticket attachment (from comment or ticket-level)
 */
export interface TicketAttachment {
  id: number;
  filename: string;
  content_type: string;
  content_url: string;
  size: number;
}

export interface TicketAttachmentDownload {
  attachment: TicketAttachment;
  content: Buffer;
  text?: string;
}

/**
 * Ticket comment with attachments
 */
export interface TicketComment {
  id: number;
  type: 'Comment' | 'VoiceComment';
  author_id: number;
  body: string;
  html_body?: string;
  plain_body?: string;
  public: boolean;
  created_at: string;
  attachments: TicketAttachment[];
}

/**
 * Ticket requester/submitter information
 */
export interface TicketUser {
  id: number;
  name: string;
  email: string;
  organization_id?: number;
}

/**
 * Comprehensive ticket context extracted from Zendesk
 */
export interface TicketContext {
  ticketId: number;
  subject: string;
  description: string;
  status: string;
  priority: string;
  requester: TicketUser;
  submitter: TicketUser;
  comments: TicketComment[];
  latestPublicComment?: TicketComment;
  privateNotes: TicketComment[];
  customFields: Array<{ id: number; value: any }>;
  tags: string[];
}

/**
 * Intent classification result from AI
 */
export interface IntentClassification {
  intent: 'PURCHASE_ORDER' | 'ORDER_TRACKING' | 'PRODUCT_QUESTION' | 'OTHER';
  confidence: number;
  reasoning: string;
  isNewPurchaseOrder?: boolean;
  requiresHumanReview?: boolean;
  humanReviewReason?: string;
  keyEntities?: {
    poNumbers?: string[];  // Array of all PO/order numbers mentioned (supports single or multiple)
    productSkus?: string[];
    urgencyLevel?: 'low' | 'medium' | 'high';
  };
}

/**
 * Processing result from intent handlers
 */
export interface ProcessingResult {
  success: boolean;
  requiresHumanReview: boolean;
  reason: string;
  tag: 'AI_READY_FOR_HUMAN_REVIEW' | 'AI_ALERT_HUMAN_REVIEW_REQUIRED';
  internalNote: string;
  publicResponse?: string | null;
  data?: any;
  additionalTags?: string[]; // Optional additional tags to add to ticket
}

// ============================================================
// Fulcrum API types for ORDER_TRACKING
// ============================================================

/**
 * Fulcrum Sales Order (from /api/sales-orders/list)
 */
export interface FulcrumSalesOrder {
  id: string;
  number: number;
  orderedDate: string;
  customerPoNumber: string;
  customerId: string;
  deliveryDueDate?: string | null;
  status: 'draft' | 'needsApproval' | 'approved' | 'inProgress' | 'complete';
  priority: 'low' | 'moderate' | 'high';
  subtotal: number;
  externalReferences?: Record<string, ExternalReference>;
  customFields?: Record<string, any>;
  billingAddress?: {
    name?: string;
    address1?: string;
    address2?: string;
    address3?: string;
    city?: string;
    stateProvince?: string;
    postalCode?: string;
    country?: string;
    phone?: string;
    email?: string;
  };
  createdUtc: string;
  modifiedUtc: string;
}

/**
 * Fulcrum Shipment (from /api/shipments/list)
 */
export interface FulcrumShipment {
  id: string;
  number: number;
  name: string;
  status: 'pending' | 'open' | 'shipped' | 'cancelled';
  packingStatus: 'notPacked' | 'partiallyPacked' | 'fullyPacked' | 'overPacked';
  trackingNumber?: string | null;
  shippingMethod?: string | { id?: string; name?: string } | null;
  carrier?: string | { id?: string; name?: string } | null;
  shipByDate?: string | null;
  shippedDate?: string | null;
  shippedDateOverride?: string | null;
  notes?: string | null;
  displayNotesToCustomer?: boolean;
  shippingCost?: number;
  shippingCharge?: number | null;
  externalReferences?: Record<string, ExternalReference>;
  customFields?: Record<string, any>;
  address?: {
    name?: string;
    address1?: string;
    address2?: string;
    address3?: string;
    city?: string;
    stateProvince?: string;
    postalCode?: string;
    country?: string;
    phone?: string;
    email?: string;
  };
}

/**
 * Fulcrum Shipment Line Item (from /api/shipment-line-items/list)
 */
export interface FulcrumShipmentLineItem {
  id: string;
  shipmentId: string;
  salesOrderId: string;
  salesOrderLineItemId: string;
  itemId?: string | null;
  quantityShipped: number;
  quantityToShip: number;
  quantityPacked: number;
  quantityInvoiced: number;
  packingStatus: 'notPacked' | 'partiallyPacked' | 'fullyPacked' | 'overPacked';
  shipmentType: 'unknown' | 'standard' | 'outsideProcessing';
  shipmentName?: string;
  shippedFromLocations?: string[];
  shippedFromLots?: string[];
}

export interface FulcrumItemCustomerDetail {
  customerId: string;
  customerItemNumber?: string | null;
  customerItemName?: string | null;
  unitOfMeasureName?: string | null;
  priceBreaks?: Array<{
    quantity?: number;
    price?: number;
  }>;
}

export interface FulcrumItemDetails {
  id: string;
  number: string;
  description: string;
  customerDetails?: FulcrumItemCustomerDetail[];
}

/**
 * External Reference structure (used in externalReferences field)
 */
export interface ExternalReference {
  type: string;
  externalId: string;
  displayId?: string;
  status?: string;
  url?: string;
  modifiedUtc?: string;
}

/**
 * Fulcrum API paginated response
 */
export interface FulcrumPaginatedResponse<T> {
  data: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

/**
 * Order tracking result
 */
export interface TrackingResult {
  salesOrder: FulcrumSalesOrder;
  shipments: FulcrumShipment[];
  shippedShipments: FulcrumShipment[];
  pendingShipments: FulcrumShipment[];
  status: 'FULLY_SHIPPED' | 'PARTIALLY_SHIPPED' | 'NOT_SHIPPED' | 'NOT_FOUND';
  trackingInfo: TrackingInfo[];
  scheduledDeliveryDate?: string | null;
}

/**
 * Tracking information per shipment
 */
export interface TrackingInfo {
  shipmentName: string;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  carrier?: string | null | { id?: string; name?: string };
  shippingMethod?: string | null | { id?: string; name?: string };
  shippedDate?: string | null;
  shipByDate?: string | null;
}

export interface PricingMismatch {
  line_index: number;
  po_line_description: string;
  reason: string;
  po_unit_price: number | null;
  fulcrum_unit_price: number | null;
  tier_name?: string;
}

export interface OpenOrderReportRow {
  purchaseOrderNumber: string;
  orderType: string;
  lineNumber: string;
  itemNumber: string;
  description: string;
  quantityOpen: number | null;
  unitCost: number | null;
  requestDate: string | null;
  promisedDelivery: string | null;
  customerPo: string | null;
  poOrderDate: string | null;
  raw: Record<string, string>;
}

export interface OpenOrderReportParseResult {
  attachment: TicketAttachment;
  filename: string;
  metadataRows: string[][];
  header: string[];
  rows: OpenOrderReportRow[];
}

export interface OpenOrderReportRowEnrichment {
  row: OpenOrderReportRow;
  salesOrder: FulcrumSalesOrder | null;
  shipment: FulcrumShipment | null;
  shipmentLineItem: FulcrumShipmentLineItem | null;
  item: FulcrumItemDetails | null;
  promiseOrShipDate: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  warning?: string | null;
}

export interface OpenOrderReportResult {
  report: OpenOrderReportParseResult;
  rows: OpenOrderReportRowEnrichment[];
  generatedCsv: string;
  attachmentFilename: string;
  unmatchedPurchaseOrders: string[];
  unmatchedRows: number;
}

// ============================================================
// PDF Classification Errors
// ============================================================

/**
 * Error thrown when multiple purchase orders are detected in attachments
 * Requires human review to determine which PO to process
 */
export class MultiplePurchaseOrdersError extends Error {
  constructor(
    public readonly count: number,
    public readonly poNumbers: (string | null)[],
    public readonly filenames: string[]
  ) {
    super(`Multiple purchase orders detected: ${count} POs found`);
    this.name = 'MultiplePurchaseOrdersError';
  }
}

/**
 * Error thrown when multiple PDFs exist but none are identified as purchase orders
 * Requires human review to identify the correct document
 */
export class NoPurchaseOrderFoundError extends Error {
  constructor(
    public readonly pdfCount: number,
    public readonly filenames: string[]
  ) {
    super(`No purchase order found among ${pdfCount} PDF attachments`);
    this.name = 'NoPurchaseOrderFoundError';
  }
}
