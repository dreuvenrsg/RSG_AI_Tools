// src/config.ts
// Centralized knobs + manual overrides for AI matching & retries.
// Keep this tiny and readable so future tweaks are easy.

// ----- Customer name overrides -----
export const CUSTOMER_NAME_OVERRIDES: Record<string, string> = {
  "ADI GLOBAL DISTRIBUTION": "ADI Global Distribution",
  "RESIDEO LLC": "ADI Global Distribution",
  "NYC ALARM": "NEW YORK CITY ALARM",
  "JCI": "JOHNSON CONTROLS",
  "JOHNSON CONTROLS INC": "JOHNSON CONTROLS"
};

export function getExtractionOverrides(): string {
  const arr_overrides = [
    `- When determining the customer name of the purchase order, our company name is RSG/AAMES SECURITY INC. also doing business as RSG Security.
    - If you see Kidde Edwards on the Purchase Order or an email including carrierfsamericas then the customer is Kidde Edwards.
    - If you see Resideo LLC then that customer is ADI Global Distribution.
    - For Johnson Control related order the shipping address information may also be listed under a section called, "Ship to :". It's on the right-hand side.
    - If the "From:" section includes Tyco Fire & Security GmbH then the customer is: "Tyco Fire & Security GmbH"
    `
  ]
  return arr_overrides.join('\n');
}

// ----- Matching thresholds -----
export const CUSTOMER_MATCH_THRESHOLD = 70;
export const ITEM_MATCH_THRESHOLD = 60;

// ----- Retry policy -----
export const DEFAULT_RETRIES = 2;

// ----- Prompt context -----
export const PROMPT_HINTS = {
  customer:
    "Consider legal vs operating names; abbreviations like 'NYC' → 'New York City', 'JCI' → 'Johnson Controls'. Return confidence 0-100 and null if below threshold.",
  item:
    "Consider terminal configuration (SPST/DPDT), color, labels like 'Manual Dump'/'LP335', and weather rating (Weather Proof). Return confidence 0-100 and null if below threshold."
};

// ----- Model configuration (modular / swappable) -----
// The customer-service agent runs on Claude; the deterministic PO/PDF pipeline
// stays on its own model. Both are overridable via env so swapping is a config
// change, never a code change.
export const MODELS = {
  /** Claude model for the customer-service classification + reply agent. */
  agent: process.env.CSDROID_AGENT_MODEL || "claude-opus-4-8",
  /** OpenAI model for the deterministic PO/PDF-extraction pipeline (unchanged). */
  poPipeline: process.env.CSDROID_PO_MODEL || "gpt-5",
} as const;

// ----- Authorization gate -----
// Optional DynamoDB domain→customer table (RSG_Website FulcrumCustomerPricingSync).
// When unset, the gate falls back to the live Fulcrum customers/contacts lookup.
export const AUTH_CONFIG = {
  domainsTable: process.env.CUSTOMER_PRICING_DOMAINS_TABLE || "", // e.g. customer-pricing-domains-prod
  pricingTable: process.env.CUSTOMER_PRICING_TABLE || "",         // e.g. customer-pricing-prod
  dynamoRegion: process.env.CUSTOMER_PRICING_REGION || process.env.AWS_REGION || "us-west-1",
} as const;

// ----- Lead-time templates (modular; swap for a smarter source later) -----
// SKU prefixes that map to the standard door-holder / extension-rod lead time.
export const DOOR_HOLDER_SKU_PREFIXES = ["DH"]; // door holders
export const DOOR_HOLDER_KEYWORDS = ["door holder", "door-holder", "extension rod", "extension-rod"];
export const STANDARD_DOOR_HOLDER_LEAD_TIME = "1-2 weeks";
