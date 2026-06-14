// src/pricing.ts
import type {
  FulcrumCatalog,
  ParsedPO,
  PricingMismatch
} from "./types";

/**
 * Given parsed PO, the item matches from AI, and Fulcrum data,
 * produce a list of PricingMismatch entries and a simple summary boolean.
 *
 * Strategy:
 * - If we have a matched customer name, read their tier from Fulcrum.
 * - For each PO line:
 *   - Find its matched item number from itemMatches by description.
 *   - Look up the item in Fulcrum; find the customer's tier price breaks.
 *   - Choose the best price break by quantity (<= ordered qty, highest quantity).
 *   - Compare PO unit_price vs Fulcrum unit price; flag mismatch if not equal.
 *   - If any lookup fails, return a descriptive reason.
 */
export function validatePricing(opts: {
  parsed: ParsedPO;
  fulcrum: FulcrumCatalog;
  matchedCustomerName?: string;
  itemMatches: Array<{
    po_line_description: string;
    matched_item_number: string | null;
  }>;
}): { allPricesValid: boolean; mismatches: PricingMismatch[] } {
  if ("raw_response" in opts.parsed || !opts.parsed.purchase_order?.items) {
    return { allPricesValid: true, mismatches: [] }; // nothing to validate
  }

  const { parsed, fulcrum, matchedCustomerName, itemMatches } = opts;

  // Customer & tier lookup
  const customer =
    matchedCustomerName
      ? fulcrum.Customers.customersByName[matchedCustomerName]
      : undefined;

  const tierId = customer?.customerTierId ?? null;
  const tierName = customer?.customerTierName ?? null;
  const poItems = parsed.purchase_order?.items ?? [];

  const mismatches: PricingMismatch[] = [];

  poItems.forEach((line, idx) => {
    const desc = line.description || "";
    const match = itemMatches.find((m) => m.po_line_description === desc);
    if (!match || !match.matched_item_number) {
      mismatches.push({
        line_index: idx,
        po_line_description: desc,
        reason: "No confident item match for pricing comparison",
        po_unit_price: line.unit_price ?? null,
        fulcrum_unit_price: null,
        tier_name: tierName ?? undefined
      });
      return;
    }

    const item = fulcrum.SellableItems.itemsByNumber[match.matched_item_number];
    if (!item) {
      mismatches.push({
        line_index: idx,
        po_line_description: desc,
        reason: `Matched item ${match.matched_item_number} not found in Fulcrum catalog`,
        po_unit_price: line.unit_price ?? null,
        fulcrum_unit_price: null,
        tier_name: tierName ?? undefined
      });
      return;
    }

    if (!tierId) {
      mismatches.push({
        line_index: idx,
        po_line_description: desc,
        reason: "Cannot validate price: matched customer has no tier assigned",
        po_unit_price: line.unit_price ?? null,
        fulcrum_unit_price: null,
        tier_name: tierName ?? undefined
      });
      return;
    }

    const tierEntry = (item.customerTiers || []).find(
        (ct: any) => ct.customerTier?.id === tierId
    );
    if (!tierEntry) {
      mismatches.push({
        line_index: idx,
        po_line_description: desc,
        reason: `No pricing found for customer tier '${tierName ?? "unknown"}'`,
        po_unit_price: line.unit_price ?? null,
        fulcrum_unit_price: null,
        tier_name: tierName ?? undefined
      });
      return;
    }

    // Determine applicable price break
    const qty = typeof line.quantity === "number" && !Number.isNaN(line.quantity) ? line.quantity : 1;
    const priceBreaks = tierEntry.priceBreaks || [];
    const applicable = [...priceBreaks]
      .filter((pb) => typeof pb.quantity === "number" && pb.quantity <= qty)
      .sort((a, b) => b.quantity - a.quantity)[0]
      ?? [...priceBreaks].sort((a, b) => a.quantity - b.quantity)[0];

    if (!applicable) {
      mismatches.push({
        line_index: idx,
        po_line_description: desc,
        reason: "No price breaks defined for tier; cannot validate",
        po_unit_price: line.unit_price ?? null,
        fulcrum_unit_price: null,
        tier_name: tierName ?? undefined
      });
      return;
    }

    const poPrice = typeof line.unit_price === "number" ? line.unit_price : null;
    const fPrice = typeof applicable.price === "number" ? applicable.price : null;

    if (poPrice === null || fPrice === null) {
      mismatches.push({
        line_index: idx,
        po_line_description: desc,
        reason: "Missing price (PO or Fulcrum); cannot compare",
        po_unit_price: poPrice,
        fulcrum_unit_price: fPrice,
        tier_name: tierName ?? undefined
      });
      return;
    }

    // Flag ANY mismatch (no tolerance)
    if (poPrice !== fPrice) {
      mismatches.push({
        line_index: idx,
        po_line_description: desc,
        reason: `Price mismatch: PO=${poPrice} vs Fulcrum=${fPrice}`,
        po_unit_price: poPrice,
        fulcrum_unit_price: fPrice,
        tier_name: tierName ?? undefined
      });
    }
  });

  return { allPricesValid: mismatches.length === 0, mismatches };
}
