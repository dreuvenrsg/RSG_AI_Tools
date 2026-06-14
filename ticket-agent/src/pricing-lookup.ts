// src/pricing-lookup.ts
// Modular item-pricing lookup. Primary source is the Fulcrum S3 catalog
// snapshot (fetchFulcrumData) which carries per-tier price breaks. The
// interface is narrow so the source can later be swapped for the DynamoDB
// customer-pricing table without changing callers.

import { fetchFulcrumData } from "./s3";
import type { FulcrumItem } from "./types";

export interface PriceQuery {
  itemNumber: string;
  tierId?: string | null;
  tierName?: string | null;
  quantity?: number | null;
}

export interface PriceResult {
  itemNumber: string;
  found: boolean;
  description?: string;
  basePrice?: number | null;
  /** Resolved unit price for the requested tier+quantity, when determinable. */
  unitPrice?: number | null;
  tierUsed?: string | null;
  priceBreaks?: Array<{ quantity: number; price: number }>;
  availableTiers?: string[];
  source: "s3_catalog" | "not_found";
  note?: string;
}

function findItem(catalogItems: Record<string, FulcrumItem>, itemNumber: string): FulcrumItem | null {
  const direct = catalogItems[itemNumber];
  if (direct) return direct;
  const target = itemNumber.trim().toUpperCase();
  for (const key of Object.keys(catalogItems)) {
    if (key.trim().toUpperCase() === target) return catalogItems[key];
  }
  return null;
}

function pickPriceForQuantity(
  breaks: Array<{ quantity: number; price: number }>,
  quantity: number | null | undefined
): number | null {
  if (!breaks || breaks.length === 0) return null;
  const sorted = [...breaks].sort((a, b) => a.quantity - b.quantity);
  const qty = quantity && quantity > 0 ? quantity : 1;
  let chosen: number | null = sorted[0].price ?? null;
  for (const b of sorted) {
    if (qty >= b.quantity) chosen = b.price;
  }
  return chosen;
}

export async function lookupItemPrice(query: PriceQuery): Promise<PriceResult> {
  const catalog = await fetchFulcrumData();
  const item = findItem(catalog.SellableItems?.itemsByNumber || {}, query.itemNumber);

  if (!item) {
    return {
      itemNumber: query.itemNumber,
      found: false,
      source: "not_found",
      note: "Item number not found in the Fulcrum catalog snapshot.",
    };
  }

  const availableTiers = (item.customerTiers || [])
    .map((t) => t.customerTier?.name || t.customerTier?.id || "")
    .filter(Boolean);

  // Resolve a tier's price breaks if a tier was specified.
  let tierUsed: string | null = null;
  let breaks: Array<{ quantity: number; price: number }> | undefined;
  if (query.tierId || query.tierName) {
    const match = (item.customerTiers || []).find((t) => {
      const id = t.customerTier?.id;
      const name = (t.customerTier?.name || "").toLowerCase();
      return (
        (query.tierId && id === query.tierId) ||
        (query.tierName && name === query.tierName.toLowerCase())
      );
    });
    if (match?.priceBreaks) {
      tierUsed = match.customerTier?.name || match.customerTier?.id || null;
      breaks = match.priceBreaks
        .filter((b) => typeof b.quantity === "number" && typeof b.price === "number")
        .map((b) => ({ quantity: b.quantity, price: b.price }));
    }
  }

  const unitPrice = breaks ? pickPriceForQuantity(breaks, query.quantity) : item.base_price ?? null;

  return {
    itemNumber: item.number,
    found: true,
    description: item.description,
    basePrice: item.base_price ?? null,
    unitPrice,
    tierUsed,
    priceBreaks: breaks,
    availableTiers,
    source: "s3_catalog",
    note: tierUsed
      ? undefined
      : "No tier specified or matched; returned base price and the list of available tiers.",
  };
}
