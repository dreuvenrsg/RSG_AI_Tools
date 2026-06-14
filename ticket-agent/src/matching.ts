// src/matching.ts
// Enrich a base ParsedPO with customer/item matching and pricing validation.

import {
  type ParsedPO,
  type FulcrumCatalog,
  type FulcrumItem,
  type CustomerMatchResponse,
  type ItemMatchResponse,
} from "./types";
import {
  CUSTOMER_MATCH_THRESHOLD,
  ITEM_MATCH_THRESHOLD,
} from "./config";
import { callCustomerMatchAI, callItemMatchAI } from "./openai";

// ============================================================================
// Types for internal use
// ============================================================================

interface MatchedCustomer {
  name: string;
  customer_id: string;
  tier_id: string | null;
  tier_name: string | null;
  confidence: number;
}

interface EnrichedItem {
  // Required base properties from PO line item
  description: string;
  unit_price: number | null;
  quantity: number | null;
  total: number | null;
  date_scheduled?: string | null;
  
  // Enrichment properties
  matched_item_number: string | null;
  matched_item_id: string | null;
  match_confidence: number | null;
  item_warnings: string[];
  fulcrum_price: number | null;
  price_mismatch: boolean;
  price_difference: number | null;
  pricing_tier_used: string | null;
}

interface ValidationResult {
  customer_matched: boolean;
  all_items_matched: boolean;
  all_prices_valid: boolean;
  requires_manual_review: boolean;
}

// ============================================================================
// Utility Functions
// ============================================================================

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pickTierPrice(
  item: FulcrumItem,
  tierId: string | null | undefined
): { price: number | null; tierName: string | null } {
  if (!tierId) {
    return { price: null, tierName: null };
  }

  const tiers = item.customerTiers || [];
  const tier = tiers.find((t) => t?.customerTier?.id === tierId);
  
  if (!tier) {
    return { price: null, tierName: null };
  }

  // Prefer qty 1 if present; else choose the smallest quantity break
  const priceBreaks = tier.priceBreaks || [];
  const quantityOnePrice = priceBreaks.find((pb) => pb.quantity === 1);
  
  let selectedPriceBreak = quantityOnePrice;
  if (!selectedPriceBreak && priceBreaks.length > 0) {
    selectedPriceBreak = [...priceBreaks].sort((a, b) => a.quantity - b.quantity)[0];
  }

  return {
    price: selectedPriceBreak ? Number(selectedPriceBreak.price) : null,
    tierName: tier?.customerTier?.name ?? null,
  };
}

// ============================================================================
// Customer Matching
// ============================================================================

async function matchCustomer(
  poCustomerName: string,
  catalog: FulcrumCatalog
): Promise<{ customer: MatchedCustomer | null; warnings: string[] }> {
  const warnings: string[] = [];
  const customerNames = Object.keys(catalog.Customers.customersByName || {});
  
  if (!poCustomerName.trim()) {
    warnings.push(
      "Customer matching failed: Purchase order does not contain a company name. Please ensure the PO includes customer information."
    );
    return { customer: null, warnings };
  }

  // Use AI matching
  const result = await performAICustomerMatch(poCustomerName, customerNames, catalog);
  warnings.push(...result.warnings);
  return { customer: result.customer, warnings };
}

function handleCustomerOverride(
  override: string,
  catalog: FulcrumCatalog,
  originalName: string
): { customer: MatchedCustomer | null; warnings: string[] } {
  const warnings: string[] = [];
  const catalogCustomer = catalog.Customers.customersByName[override];

  if (!catalogCustomer) {
    warnings.push(
      `Customer matching failed: Manual override is configured to map "${originalName}" to "${override}", but "${override}" does not exist in the catalog. Please update your configuration or add this customer to Fulcrum.`
    );
    return { customer: null, warnings };
  }

  console.log(`[match] customer override: "${originalName}" -> "${catalogCustomer.name}"`);
  
  return {
    customer: {
      name: catalogCustomer.name,
      customer_id: catalogCustomer.id,
      tier_id: catalogCustomer.customerTierId ?? null,
      tier_name: catalogCustomer.customerTierName ?? null,
      confidence: 100,
    },
    warnings,
  };
}

async function performAICustomerMatch(
  poCustomerName: string,
  customerNames: string[],
  catalog: FulcrumCatalog
): Promise<{ customer: MatchedCustomer | null; warnings: string[] }> {
  const warnings: string[] = [];

  let aiResponse: CustomerMatchResponse | null = null;
  try {
    aiResponse = await callCustomerMatchAI(
      poCustomerName,
      customerNames,
      CUSTOMER_MATCH_THRESHOLD
    );
  } catch (error: any) {
      warnings.push(
        `Customer matching failed: Could not reach AI service for customer "${poCustomerName}". Error: ${error?.message || String(error)}`
      );
      return { customer: null, warnings };
  }

  const matchedName = aiResponse?.matched_customer_name === undefined 
    ? null 
    : aiResponse.matched_customer_name;
  const confidence = aiResponse?.confidence ?? 0;

  if (!matchedName) {
    warnings.push(
      `Customer matching failed: AI could not find any match for "${poCustomerName}" in the catalog. Please verify the customer name or add this customer to your system.`
    );
    return { customer: null, warnings };
  }

  if (confidence < CUSTOMER_MATCH_THRESHOLD) {
    warnings.push(
      `Customer matching failed: AI found possible match "${matchedName}" for "${poCustomerName}", but confidence is too low (${confidence}% < ${CUSTOMER_MATCH_THRESHOLD}% threshold). Please verify the customer name matches exactly or add an override in config.`
    );
    return { customer: null, warnings };
  }

  const catalogCustomer = catalog.Customers.customersByName[matchedName];
  if (!catalogCustomer) {
    warnings.push(
      `Customer matching failed: AI matched "${poCustomerName}" to "${matchedName}", but "${matchedName}" is missing from the catalog index. This is a system error - please contact support.`
    );
    return { customer: null, warnings };
  }

  return {
    customer: {
      name: catalogCustomer.name,
      customer_id: catalogCustomer.id,
      tier_id: catalogCustomer.customerTierId ?? null,
      tier_name: catalogCustomer.customerTierName ?? null,
      confidence,
    },
    warnings,
  };
}

// ============================================================================
// Item Matching
// ============================================================================

async function matchItems(
  poItems: any[],
  catalog: FulcrumCatalog
): Promise<{ items: EnrichedItem[]; warnings: string[] }> {
  const warnings: string[] = [];
  const itemsByNumber = catalog.SellableItems.itemsByNumber || {};
  
  const catalogList = Object.values(itemsByNumber).map((item) => ({
    number: item.number,
    description: item.description,
    id: item.id,
  }));

  const itemMatches = await fetchItemMatches(poItems, catalogList, warnings);
  const enrichedItems = enrichItemsWithMatches(poItems, itemMatches);

  return { items: enrichedItems, warnings };
}

async function fetchItemMatches(
  poItems: any[],
  catalogList: Array<{ number: string; description: string; id: string }>,
  warnings: string[]
): Promise<ItemMatchResponse["matches"]> {
  try {
    const response = await callItemMatchAI(
      poItems.map((item) => item.description || ""),
      catalogList,
      ITEM_MATCH_THRESHOLD
    );
    return Array.isArray(response?.matches) ? response.matches : [];
  } catch (error: any) {
    warnings.push(
      `Item matching failed: Could not reach AI service to match ${poItems.length} line item(s). Error: ${error?.message || String(error)}`
    );
    return [];
  }
}

function enrichItemsWithMatches(
  poItems: any[],
  itemMatches: ItemMatchResponse["matches"]
): EnrichedItem[] {
  return poItems.map((line) => {
    const description = line.description || "";
    const match = itemMatches.find(
      (m) => (m.po_line_description || "") === description
    );

    const matchedNumber = match?.matched_item_number ?? null;
    const matchedId = match?.matched_item_id ?? null;
    const confidence = toNumberOrNull(match?.confidence);

    const itemWarnings = generateItemWarnings(description, matchedNumber, confidence);

    return {
      // Preserve all base properties
      description: line.description,
      unit_price: line.unit_price,
      quantity: line.quantity,
      total: line.total,
      date_scheduled: line.date_scheduled,
      // Add enrichment properties
      matched_item_number: matchedNumber,
      matched_item_id: matchedId,
      match_confidence: confidence,
      item_warnings: itemWarnings,
      fulcrum_price: null,
      price_mismatch: false,
      price_difference: null,
      pricing_tier_used: null,
    };
  });
}

function generateItemWarnings(
  description: string,
  matchedNumber: string | null,
  confidence: number | null
): string[] {
  const warnings: string[] = [];

  if (!matchedNumber) {
    warnings.push(
      `Item matching failed: No catalog item found for line "${description}". Please verify the item description or add this item to your catalog.`
    );
    return warnings;
  }

  if ((confidence ?? 0) < ITEM_MATCH_THRESHOLD) {
    warnings.push(
      `Item matching uncertain: Line "${description}" matched to item ${matchedNumber}, but confidence is low (${confidence ?? 0}% < ${ITEM_MATCH_THRESHOLD}% threshold). Please verify this is the correct item.`
    );
  }

  return warnings;
}

// ============================================================================
// Pricing Validation
// ============================================================================

function validatePricing(
  items: EnrichedItem[],
  matchedCustomer: MatchedCustomer | null,
  catalog: FulcrumCatalog
): { items: EnrichedItem[]; warnings: string[] } {
  const warnings: string[] = [];
  const itemsByNumber = catalog.SellableItems.itemsByNumber || {};

  const pricedItems = items.map((item) => {
    const pricingResult = calculateItemPricing(
      item,
      matchedCustomer,
      itemsByNumber
    );

    if (pricingResult.warning) {
      warnings.push(pricingResult.warning);
    }

    return {
      ...item,
      fulcrum_price: pricingResult.fulcrumPrice,
      price_mismatch: pricingResult.hasMismatch,
      price_difference: pricingResult.difference,
      pricing_tier_used: pricingResult.tierUsed,
    };
  });

  return { items: pricedItems, warnings };
}

function calculateItemPricing(
  item: EnrichedItem,
  matchedCustomer: MatchedCustomer | null,
  itemsByNumber: Record<string, FulcrumItem>
): {
  fulcrumPrice: number | null;
  tierUsed: string | null;
  hasMismatch: boolean;
  difference: number | null;
  warning: string | null;
} {
  const matchedNumber = item.matched_item_number;
  const poUnitPrice = toNumberOrNull(item.unit_price);
  const itemDescription = item.description || "Unknown item";

  // Case 1: No matched item number - cannot validate pricing
  if (!matchedNumber) {
    return {
      fulcrumPrice: null,
      tierUsed: null,
      hasMismatch: false,
      difference: null,
      warning: null, // Warning already handled in item matching phase
    };
  }

  // Case 2: No matched customer - cannot validate pricing
  if (!matchedCustomer) {
    return {
      fulcrumPrice: null,
      tierUsed: null,
      hasMismatch: false,
      difference: null,
      warning: `Pricing validation skipped for item ${matchedNumber} ("${itemDescription}"): No customer matched. Customer must be matched before pricing can be validated.`,
    };
  }

  // Case 3: Customer matched but has no pricing tier assigned
  if (!matchedCustomer.tier_id) {
    return {
      fulcrumPrice: null,
      tierUsed: null,
      hasMismatch: false,
      difference: null,
      warning: `Pricing validation failed for item ${matchedNumber} ("${itemDescription}"): Customer "${matchedCustomer.name}" does not have a pricing tier assigned. Please assign a tier to this customer in Fulcrum.`,
    };
  }

  // Case 4: Item not found in catalog
  const catalogItem = itemsByNumber[matchedNumber];
  if (!catalogItem) {
    return {
      fulcrumPrice: null,
      tierUsed: null,
      hasMismatch: false,
      difference: null,
      warning: `Pricing validation failed for item ${matchedNumber} ("${itemDescription}"): Item is missing from the catalog. This is a system error - please contact support.`,
    };
  }

  // Case 5: Get tier pricing
  const { price: fulcrumPrice, tierName } = pickTierPrice(
    catalogItem,
    matchedCustomer.tier_id
  );

  // Case 6: No pricing available for this tier
  if (fulcrumPrice === null) {
    return {
      fulcrumPrice: null,
      tierUsed: matchedCustomer.tier_name,
      hasMismatch: false,
      difference: null,
      warning: `Pricing validation failed for item ${matchedNumber} ("${itemDescription}"): No pricing found for customer "${matchedCustomer.name}" on tier "${matchedCustomer.tier_name}". Please add pricing for this item/tier combination in Fulcrum.`,
    };
  }

  // Case 7: PO has no unit price - cannot compare
  if (poUnitPrice === null) {
    return {
      fulcrumPrice,
      tierUsed: tierName,
      hasMismatch: false,
      difference: null,
      warning: `Pricing validation incomplete for item ${matchedNumber} ("${itemDescription}"): Purchase order does not specify a unit price. Fulcrum price for tier "${tierName}" is ${fulcrumPrice}.`,
    };
  }

  // Case 8: Compare prices
  const difference = Number((poUnitPrice - fulcrumPrice).toFixed(4));
  const hasMismatch = Math.abs(difference) > 0;

  const warning = hasMismatch
    ? `Price mismatch for item ${matchedNumber} ("${itemDescription}"): PO price is ${poUnitPrice} but Fulcrum price for customer "${matchedCustomer.name}" on tier "${tierName}" is ${fulcrumPrice} (difference: ${difference > 0 ? '+' : ''}${difference}). Please verify pricing.`
    : null;

  return {
    fulcrumPrice,
    tierUsed: tierName,
    hasMismatch,
    difference,
    warning,
  };
}

// ============================================================================
// Validation Summary
// ============================================================================

function createValidationSummary(
  matchedCustomer: MatchedCustomer | null,
  items: EnrichedItem[]
): ValidationResult {
  const customerMatched = matchedCustomer !== null;
  const allItemsMatched = items.every((item) => item.matched_item_number !== null);
  const allPricesValid = items.every((item) => item.price_mismatch === false);

  return {
    customer_matched: customerMatched,
    all_items_matched: allItemsMatched,
    all_prices_valid: allPricesValid,
    requires_manual_review: !customerMatched || !allItemsMatched || !allPricesValid,
  };
}

function collectAllWarnings(
  customerWarnings: string[],
  itemWarnings: string[],
  pricingWarnings: string[],
  items: EnrichedItem[]
): string[] {
  const allWarnings = [
    ...customerWarnings,
    ...itemWarnings,
  ];

  // Add item-level warnings
  for (const item of items) {
    if (Array.isArray(item.item_warnings)) {
      allWarnings.push(...item.item_warnings);
    }
  }

  allWarnings.push(...pricingWarnings);

  return allWarnings;
}

// ============================================================================
// Main Enrichment Function
// ============================================================================

export async function enrichWithFulcrumAndAI(
  baseParsed: ParsedPO,
  catalog: FulcrumCatalog
): Promise<ParsedPO> {
  // Pass through if OpenAI returned raw text
  if (!baseParsed.purchase_order) {
    return baseParsed;
  }

  const poCustomerName = (baseParsed.company_name || "").trim();
  const poItems = baseParsed.purchase_order.items || [];

  // Step 1: Match customer
  const customerResult = await matchCustomer(poCustomerName, catalog);

  // Step 2: Match items
  const itemResult = await matchItems(poItems, catalog);

  // Step 3: Validate pricing
  const pricingResult = validatePricing(
    itemResult.items,
    customerResult.customer,
    catalog
  );

  // Step 4: Create validation summary
  const validation = createValidationSummary(
    customerResult.customer,
    pricingResult.items
  );

  // Step 5: Collect all warnings
  const allWarnings = collectAllWarnings(
    customerResult.warnings,
    itemResult.warnings,
    pricingResult.warnings,
    pricingResult.items
  );

  // Step 6: Return enriched PO
  return {
    ...baseParsed,
    purchase_order: {
      ...baseParsed.purchase_order,
      items: pricingResult.items,
    },
    matched_customer: customerResult.customer,
    warnings: allWarnings,
    validation,
  };
}
