// src/order-tracking.ts
// Business logic for order tracking

import type {
  TrackingResult,
  TrackingInfo,
  FulcrumSalesOrder,
  FulcrumShipment
} from "./types";
import {
  findSalesOrdersByPO,
  listShipmentsForSalesOrder,
  generateTrackingUrl,
  normalizePO,
  calculatePOMatchConfidence,
  PO_MATCH_CONFIDENCE_THRESHOLD
} from "./fulcrum";

/**
 * Track an order by PO number
 * Returns comprehensive tracking information including shipment status
 */
export async function trackOrder(poNumber: string): Promise<TrackingResult> {
  console.log(`[OrderTracking] Tracking PO: ${poNumber}`);

  // Step 1: Find sales order by PO number (findSalesOrdersByPO already does fuzzy matching)
  const salesOrders = await findSalesOrdersByPO(poNumber);

  if (salesOrders.length === 0) {
    console.log(`[OrderTracking] No sales order found for PO: ${poNumber}`);
    return {
      salesOrder: null as any, // Will be handled by caller
      shipments: [],
      shippedShipments: [],
      pendingShipments: [],
      status: 'NOT_FOUND',
      trackingInfo: [],
      scheduledDeliveryDate: null
    };
  }

  // Filter for high-confidence matches using fuzzy matching
  // (findSalesOrdersByPO already applies threshold, but we double-check here for safety)
  const normalizedSearchPO = normalizePO(poNumber);
  const highConfidenceMatches = salesOrders.filter(order => {
    const confidence = calculatePOMatchConfidence(poNumber, order.customerPoNumber || '');

    if (confidence >= PO_MATCH_CONFIDENCE_THRESHOLD) {
      const normalizedOrderPO = normalizePO(order.customerPoNumber);
      console.log(`[OrderTracking] ✓ High confidence match: "${order.customerPoNumber}" (normalized: "${normalizedOrderPO}") - confidence: ${confidence}`);
      return true;
    }

    console.log(`[OrderTracking] ✗ Low confidence match (${confidence}): "${order.customerPoNumber}" - filtering out`);
    return false;
  });

  if (highConfidenceMatches.length === 0) {
    console.log(`[OrderTracking] No high-confidence match found for PO: ${poNumber} (normalized: "${normalizedSearchPO}") after checking ${salesOrders.length} orders`);
    return {
      salesOrder: null as any,
      shipments: [],
      shippedShipments: [],
      pendingShipments: [],
      status: 'NOT_FOUND',
      trackingInfo: [],
      scheduledDeliveryDate: null
    };
  }

  // Use the first high-confidence matching sales order
  const salesOrder = highConfidenceMatches[0];
  console.log(`[OrderTracking] Found Sales Order #${salesOrder.number} with PO "${salesOrder.customerPoNumber}"`);

  // Step 2: Get all shipments for this sales order
  const allShipments = await listShipmentsForSalesOrder(salesOrder.id, { includeAll: true });

  // Step 3: Categorize shipments
  const shippedShipments = allShipments.filter(s => s.status === 'shipped');
  const pendingShipments = allShipments.filter(s =>
    s.status === 'pending' || s.status === 'open'
  );

  console.log(`[OrderTracking] Shipments - Total: ${allShipments.length}, Shipped: ${shippedShipments.length}, Pending: ${pendingShipments.length}`);

  // Step 4: Determine overall status
  let status: TrackingResult['status'];
  if (shippedShipments.length === 0 && pendingShipments.length === 0) {
    status = 'NOT_SHIPPED';
  } else if (shippedShipments.length > 0 && pendingShipments.length === 0) {
    status = 'FULLY_SHIPPED';
  } else if (shippedShipments.length > 0 && pendingShipments.length > 0) {
    status = 'PARTIALLY_SHIPPED';
  } else {
    status = 'NOT_SHIPPED';
  }

  // Step 5: Build tracking info for shipped shipments
  const trackingInfo: TrackingInfo[] = shippedShipments.map(shipment => {
    const trackingUrl = shipment.trackingNumber
      ? generateTrackingUrl(shipment.trackingNumber, shipment.carrier, shipment.shippingMethod)
      : null;

    return {
      shipmentName: shipment.name,
      trackingNumber: shipment.trackingNumber || null,
      trackingUrl,
      carrier: shipment.carrier || null,
      shippingMethod: shipment.shippingMethod || null,
      shippedDate: shipment.shippedDate || null,
      shipByDate: shipment.shipByDate || null
    };
  });

  // Sort by shipped date (most recent first)
  trackingInfo.sort((a, b) => {
    if (!a.shippedDate) return 1;
    if (!b.shippedDate) return -1;
    return new Date(b.shippedDate).getTime() - new Date(a.shippedDate).getTime();
  });

  // Step 6: Determine scheduled delivery date
  let scheduledDeliveryDate = salesOrder.deliveryDueDate || null;

  // If there are pending shipments, use the earliest shipByDate
  if (pendingShipments.length > 0) {
    const earliestShipBy = pendingShipments
      .map(s => s.shipByDate)
      .filter(Boolean)
      .sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime())[0];

    if (earliestShipBy) {
      scheduledDeliveryDate = earliestShipBy;
    }
  }

  console.log(`[OrderTracking] Status: ${status}, Tracking Info Count: ${trackingInfo.length}`);

  return {
    salesOrder,
    shipments: allShipments,
    shippedShipments,
    pendingShipments,
    status,
    trackingInfo,
    scheduledDeliveryDate
  };
}

/**
 * Helper to format a date string for customer-facing display
 */
export function formatDateForCustomer(dateString: string | null | undefined): string {
  if (!dateString) return 'N/A';

  try {
    const date = new Date(dateString);
    // Format as: "December 24, 2024"
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  } catch {
    return dateString;
  }
}
