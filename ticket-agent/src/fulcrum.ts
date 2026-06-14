// src/fulcrum.ts
// Fulcrum API integration for order tracking

import type {
  FulcrumSalesOrder,
  FulcrumShipment,
  FulcrumShipmentLineItem,
  FulcrumPaginatedResponse,
  FulcrumItemDetails
} from "./types";

const FULCRUM_TOKEN = process.env.FULCRUM_TOKEN!;
const FULCRUM_API_URL = process.env.FULCRUM_API_URL || "https://api.fulcrumpro.com";

function assertFulcrumEnv() {
  if (!FULCRUM_TOKEN) {
    throw new Error("FULCRUM_TOKEN not configured");
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const itemCache = new Map<string, Promise<FulcrumItemDetails>>();

/**
 * Normalize a PO number for fuzzy matching
 * Removes common formatting variations while preserving the core numeric value
 *
 * Examples:
 * - "PO 400203171" → "400203171"
 * - "400203171-XP" → "400203171"
 * - "PO-400203171" → "400203171"
 * - "400 203 171" → "400203171"
 */
export function normalizePO(po: string | null | undefined): string {
  if (!po) return '';

  return po
    .toUpperCase()                    // Case insensitive
    .replace(/^PO[\s-]*/i, '')       // Remove "PO" prefix with optional space/dash
    .replace(/[\s-]/g, '')            // Remove all spaces and dashes
    .replace(/XP$/i, '')              // Remove XP suffix
    .trim();
}

function extractPOBase(po: string | null | undefined): string {
  if (!po) return "";

  const withoutPrefix = po.toUpperCase().replace(/^PO[\s-]*/i, "").trim();
  const leadingToken = withoutPrefix.match(/^([A-Z0-9]+)/)?.[1] ?? "";
  const leadingDigits = withoutPrefix.match(/^(\d{4,})\b/)?.[1] ?? "";

  return normalizePO(leadingDigits || leadingToken);
}

/**
 * Calculate confidence score for PO number match
 * Returns 0.0 to 1.0 score indicating match quality
 *
 * @param po1 - First PO number (e.g., from customer)
 * @param po2 - Second PO number (e.g., from Fulcrum)
 * @returns Confidence score: 1.0 = perfect match, 0.95 = normalized match, 0.0 = no match
 */
export function calculatePOMatchConfidence(po1: string, po2: string): number {
  const norm1 = normalizePO(po1);
  const norm2 = normalizePO(po2);

  if (norm1 === norm2) {
    // Exact match after normalization
    if (po1 === po2) {
      return 1.0;  // Perfect exact match
    }
    return 0.95;   // Normalized match (high confidence)
  }

  const base1 = extractPOBase(po1);
  const base2 = extractPOBase(po2);

  if (base1 && base2 && base1 === base2) {
    return 0.93;
  }

  // No match
  return 0.0;
}

/**
 * Minimum confidence threshold for PO matching
 * Matches below this threshold will be filtered out
 */
export const PO_MATCH_CONFIDENCE_THRESHOLD = 0.9;

/**
 * Base Fulcrum API request with 429 retry handling
 */
async function fulcrumRequest<T = any>(
  method: string,
  endpoint: string,
  body?: any
): Promise<T> {
  assertFulcrumEnv();
  const url = `${FULCRUM_API_URL}${endpoint}`;

  // Simple 429 handling via Retry-After (similar to Zendesk pattern)
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${FULCRUM_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (resp.status !== 429) {
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Fulcrum API error ${resp.status}: ${text}`);
      }
      const text = await resp.text();
      return text ? JSON.parse(text) : ({} as T);
    }

    const ra = resp.headers.get("Retry-After");
    const wait = ra ? Number(ra) * 1000 : 1500 * (attempt + 1);
    console.log(`Rate limited, waiting ${wait}ms before retry ${attempt + 1}/4`);
    await sleep(wait);
  }

  // Final attempt
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${FULCRUM_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Fulcrum API error ${resp.status}: ${text}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : ({} as T);
}

/**
 * Find sales orders by customer PO number
 * NOTE: Fulcrum API does NOT support customerPoNumber as a search filter,
 * so we must fetch orders and filter client-side.
 *
 * OPTIMIZATION: We fetch in batches and stop early if we find a match,
 * assuming most PO lookups will be for recent orders.
 *
 * Returns array of matching sales orders (usually 1, but could be multiple)
 */
export async function findSalesOrdersByPO(
  customerPoNumber: string,
  options: { maxBatches?: number; batchSize?: number } = {}
): Promise<FulcrumSalesOrder[]> {
  const { maxBatches = 100, batchSize = 100 } = options;

  // Normalize the search PO number for fuzzy matching
  const normalizedSearchPO = normalizePO(customerPoNumber);
  console.log(`[Fulcrum] Searching for PO: "${customerPoNumber}" (normalized: "${normalizedSearchPO}")`);

  const matches: FulcrumSalesOrder[] = [];
  let skip = 0;
  let batchCount = 0;
  let batchesAfterFirstMatchRemaining: number | null = null;

  while (batchCount < maxBatches) {
    console.log(`[Fulcrum] Fetching batch ${batchCount + 1}/${maxBatches} (skip=${skip})...`);

    // IMPORTANT: Sort by createdUtc descending to search newest orders first
    // This dramatically improves performance since most tracking requests are for recent orders
    const orders = await fulcrumRequest<FulcrumSalesOrder[]>(
      'POST',
      `/api/sales-orders/list?Skip=${skip}&Take=${batchSize}&Sort.Field=createdUtc&Sort.Dir=descending`,
      {} // Empty body - Fulcrum doesn't support customerPoNumber filter
    );

    if (orders.length === 0) {
      console.log(`[Fulcrum] No more orders to fetch`);
      break;
    }

    // Check this batch for matches using fuzzy matching with confidence threshold
    const batchMatches = orders.filter(o => {
      const confidence = calculatePOMatchConfidence(customerPoNumber, o.customerPoNumber || '');

      if (confidence >= PO_MATCH_CONFIDENCE_THRESHOLD) {
        const normalizedOrderPO = normalizePO(o.customerPoNumber);
        console.log(`[Fuzzy Match] ✓ Matched: "${o.customerPoNumber}" (normalized: "${normalizedOrderPO}") with confidence ${confidence}`);
        return true;
      }

      return false;
    });

    if (batchMatches.length > 0) {
      console.log(`[Fulcrum] Found ${batchMatches.length} match(es) in batch ${batchCount + 1}`);
      matches.push(...batchMatches);

      if (batchesAfterFirstMatchRemaining === null) {
        batchesAfterFirstMatchRemaining = 2;
        console.log(`[Fulcrum] Found match, searching ${batchesAfterFirstMatchRemaining} more batch(es) to be thorough...`);
      }
    }

    // If we got fewer than requested, we've reached the end
    if (orders.length < batchSize) {
      console.log(`[Fulcrum] Reached end of sales orders (got ${orders.length} < ${batchSize})`);
      break;
    }

    if (batchesAfterFirstMatchRemaining !== null) {
      if (batchesAfterFirstMatchRemaining === 0) {
        console.log(`[Fulcrum] Stopping search after finding ${matches.length} match(es)`);
        break;
      }
      batchesAfterFirstMatchRemaining--;
    }

    skip += batchSize;
    batchCount++;
  }

  console.log(`[Fulcrum] Search complete: ${matches.length} order(s) found for PO "${customerPoNumber}" after checking ${skip + (matches.length > 0 ? batchSize : 0)} orders`);
  return matches;
}

/**
 * List shipments for a given sales order
 * Returns paginated response with shipments
 */
export async function listShipmentsForSalesOrder(
  salesOrderId: string,
  options: { includeAll?: boolean } = {}
): Promise<FulcrumShipment[]> {
  console.log(`[Fulcrum] Fetching shipments for SO: ${salesOrderId}`);

  // Fetch all shipments (no status filter if includeAll is true)
  const body: any = { salesOrderId };

  const response = await fulcrumRequest<FulcrumPaginatedResponse<FulcrumShipment>>(
    'POST',
    '/api/shipments/list?Skip=0&Take=50',
    body
  );

  const shipments = response.data || [];
  console.log(`[Fulcrum] Found ${shipments.length} shipments`);

  return shipments;
}

/**
 * List line items for a given shipment
 */
export async function listShipmentLineItems(
  shipmentId: string
): Promise<FulcrumShipmentLineItem[]> {
  console.log(`[Fulcrum] Fetching line items for shipment: ${shipmentId}`);

  const response = await fulcrumRequest<FulcrumPaginatedResponse<FulcrumShipmentLineItem>>(
    'POST',
    '/api/shipment-line-items/list?Skip=0&Take=50',
    { shipmentIds: [shipmentId] }
  );

  const items = response.data || [];
  console.log(`[Fulcrum] Found ${items.length} line items`);

  return items;
}

export async function getSalesOrder(
  salesOrderId: string
): Promise<FulcrumSalesOrder> {
  return fulcrumRequest<FulcrumSalesOrder>(
    'GET',
    `/api/sales-orders/${salesOrderId}`
  );
}

export async function getItemById(
  itemId: string
): Promise<FulcrumItemDetails> {
  const cached = itemCache.get(itemId);
  if (cached) return cached;

  const pending = fulcrumRequest<FulcrumItemDetails>(
    'GET',
    `/api/items/${itemId}`
  );
  itemCache.set(itemId, pending);
  return pending;
}

/**
 * Generate tracking URL based on carrier and tracking number
 */
export function generateTrackingUrl(
  trackingNumber: string,
  carrier?: string | null | any,
  shippingMethod?: string | null | any
): string | null {
  if (!trackingNumber) return null;

  // Normalize carrier/shipping method for matching
  // Handle both string and object types (Fulcrum API inconsistency)
  const carrierStr = typeof carrier === 'string' ? carrier : (carrier?.name || '');
  const methodStr = typeof shippingMethod === 'string' ? shippingMethod : (shippingMethod?.name || '');
  const carrierLower = (carrierStr || methodStr || '').toLowerCase();

  // UPS patterns
  if (
    carrierLower.includes('ups') ||
    carrierLower.includes('united parcel') ||
    trackingNumber.match(/^1Z/i) // UPS tracking numbers start with 1Z
  ) {
    return `https://www.ups.com/track?track=yes&trackNums=${encodeURIComponent(trackingNumber)}&loc=en_US&requester=ST/trackdetails`;
  }

  // FedEx patterns
  if (
    carrierLower.includes('fedex') ||
    carrierLower.includes('federal express')
  ) {
    return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`;
  }

  // USPS patterns
  if (carrierLower.includes('usps') || carrierLower.includes('postal')) {
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`;
  }

  // DHL patterns
  if (carrierLower.includes('dhl')) {
    return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encodeURIComponent(trackingNumber)}`;
  }

  // Unknown carrier - return null (will display tracking number only)
  return null;
}
