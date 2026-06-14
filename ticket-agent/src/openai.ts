// src/openai.ts
// Responsibilities:
// 1) analyzePdfAndBuildPO: Parse a PDF into your PO JSON shape (date_scheduled present but can be null)
// 2) callCustomerMatchAI: Customer name fuzzy-match helper (returns undefined for matched_customer_name when low confidence)
// 3) callItemMatchAI: Item matching helper (omits matched_item_number via post-process when low confidence)

import type {
  ParsedPO,
  CustomerMatchResponse,
  ItemMatchResponse,
} from "./types";

import {
  getExtractionOverrides,
} from "./config";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENAI_REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? "420000");
const MODEL = "gpt-5";

// -----------------------------
// Utilities
// -----------------------------

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postJsonWithRetry<T>(
  url: string,
  body: any,
  maxRetries = 2,
  timeoutMs = OPENAI_REQUEST_TIMEOUT_MS
): Promise<T> {
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`OpenAI API error ${resp.status}: ${errText}`);
      }
      return (await resp.json()) as T;
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) throw err;
      await sleep(500 * attempt);
    } finally {
      clearTimeout(to);
    }
  }
}

function extractOutputText(data: any): string {
  // Responses API: find first "message" -> first "output_text"
  const message = (data.output || []).find((o: any) => o.type === "message");
  if (!message) return "";
  const block = (message.content || []).find(
    (c: any) => c.type === "output_text" && typeof c.text === "string"
  );
  return block?.text || "";
}

// -----------------------------
// 1) PDF → ParsedPO  (date_scheduled REQUIRED by schema, but can be null)
// -----------------------------

// IMPORTANT: The Responses API requires that, when `required` is present for an object,
// it includes *every* property in the object. To avoid the "Missing 'date_scheduled'"
// error, we list it in `required`, but allow it to be null.
const poSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    company_name: { type: "string" },
    mark_for: { type: ["string", "null"] },
    shipping_address: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: ["string", "null"] },
        raw: { type: ["string", "null"] },
        address1: { type: ["string", "null"] },
        address2: { type: ["string", "null"] },
        city: { type: ["string", "null"] },
        stateProvince: { type: ["string", "null"] },
        postalCode: { type: ["string", "null"] },
        country: { type: ["string", "null"] },
      },
      required: ["name", "raw", "address1", "address2", "city", "stateProvince", "postalCode", "country"],
    },
    delivery_date: { type: "string" },
    currency: { type: "string" },
    purchase_order: {
      type: "object",
      additionalProperties: false,
      properties: {
        purchase_order_number: { type: "string" },
        currency: { type: "string" },
        total_cost: { type: ["number", "null"] },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              description: { type: "string" },
              unit_price: { type: ["number", "null"] },
              quantity: { type: ["number", "null"] },
              total: { type: ["number", "null"] },
              date_scheduled: { type: ["string", "null"] },
            },
            required: ["description", "unit_price", "quantity", "total", "date_scheduled"],
          },
        },
      },
      required: ["purchase_order_number", "currency", "total_cost", "items"],
    },
  },
  required: ["company_name", "shipping_address", "delivery_date", "currency", "purchase_order", "mark_for"],
} as const;

const extractionInstructions = [
  "Extract exactly one purchase order from this PDF.",
  "Output JSON ONLY matching the provided schema.",
  `Please note these overrides when applicable: ${getExtractionOverrides()}`,
  "Rules:",
  "- Include all top-level keys (company_name, shipping_address, delivery_date, currency, purchase_order, mark_for).",
  "- Use empty string \"\" for unknown text fields (do not invent).",
  "- Use null for unknown numeric fields (unit_price, quantity, total, total_cost).",
  "- Normalize currency numbers: no symbols, no commas; dot as decimal separator.",
  "- Use ISO date format YYYY-MM-DD when a date is present; otherwise \"\".",
  "- purchase_order.items should be an array; include items found (may be empty).",
  "- For each item, include date_scheduled; if none is present in the document, set it to null.",
  "",
  "SHIPPING ADDRESS PARSING:",
  "- The shipping address is often labeled as 'Ship To' on the purchase order.",
  "- Parse the shipping address into structured fields:",
  "  - name: Recipient/company name at shipping address (use company_name if not specified separately)",
  "  - address1: Primary street address line (required, use null if not found)",
  "  - address2: Secondary address line (apartment, suite, etc. - use null if not present)",
  "  - city: City name (required, use null if not found)",
  "  - stateProvince: State/province code or name (required, use null if not found)",
  "  - postalCode: ZIP/postal code (required, use null if not found)",
  "  - country: Country name or code (default to 'US' if not specified but address appears to be US)",
  "  - raw: Always include the complete original address text as it appears in the PDF",
  "- Example: If you see 'Ship To: 123 Main St, Suite 4B, Springfield, IL 62701'",
  "  Parse as: { address1: '123 Main St', address2: 'Suite 4B', city: 'Springfield', stateProvince: 'IL', postalCode: '62701', country: 'US', raw: '123 Main St, Suite 4B, Springfield, IL 62701' }",
].join(" ");

export async function analyzePdfAndBuildPO(pdfUrl: string): Promise<ParsedPO> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  if (!pdfUrl) throw new Error("pdfUrl is required");

  const body = {
    model: MODEL,
    text: {
      format: {
        name: "single_purchase_order_best_effort",
        type: "json_schema",
        schema: poSchema,
      },
    },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: extractionInstructions },
          { type: "input_file", file_url: String(pdfUrl) },
        ],
      },
    ],
    max_output_tokens: 5000,
  };

  const data = await postJsonWithRetry<any>("https://api.openai.com/v1/responses", body, 2);
  const outputText = extractOutputText(data);
  try {
    return JSON.parse(outputText) as ParsedPO;
  } catch {
    // Fallback—return raw text for debugging/visibility
    return { raw_response: outputText } as ParsedPO;
  }
}

// -----------------------------
// 2) Customer matching helper
// -----------------------------

/**
 * callCustomerMatchAI
 * - Schema must list ALL properties in `required`. We allow null for "no match".
 * - After parsing, we delete the field if it's null OR confidence < threshold,
 *   so upstream sees `undefined` like you prefer.
 */
export async function callCustomerMatchAI(
  pdfCustomerName: string,
  catalogCustomerNames: string[],
  threshold: number
): Promise<CustomerMatchResponse> {
  const prompt = [
    "You are a customer name matching assistant.",
    "Given a single customer name from a Purchase Order and a list of valid ERP customer names, find the best match (if any).",
    "",
    `If confidence is below ${threshold} (0-100), set matched_customer_name to null.`,
    "Return strict JSON only.",
    "IMPORTANT: Return confidence as an INTEGER from 0 to 100 (no decimals).",
  ].join("\n");

  const input = {
    model: MODEL,
    text: {
      format: {
        name: "customer_match_json",
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            matched_customer_name: { type: ["string", "null"] },
            confidence: { type: "integer", minimum: 0, maximum: 100 }, // <- enforce integer
            reasoning: { type: "string" },
            warning: { type: ["string", "null"] },
          },
          required: ["matched_customer_name", "confidence", "reasoning", "warning"],
        },
      },
    },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_text", text: `PDF Customer Name: ${pdfCustomerName}` },
          {
            type: "input_text",
            text:
              "Valid Customers (exact names from ERP):\n" +
              catalogCustomerNames.map((n) => `- ${n}`).join("\n"),
          },
        ],
      },
    ],
    max_output_tokens: 1200,
  };

  const data = await postJsonWithRetry<any>("https://api.openai.com/v1/responses", input, 2);
  const outputText = extractOutputText(data);

  let parsed: CustomerMatchResponse = {
    matched_customer_name: null,
    confidence: 0,
    reasoning: "",
    warning: null,
  };

  try {
    parsed = JSON.parse(outputText) as CustomerMatchResponse;
  } catch {
    // leave defaults
  }

  // Safety: coerce decimals or fractions to integer 0..100 if model misbehaves
  if (typeof parsed.confidence === "number") {
    if (parsed.confidence <= 1 && parsed.confidence >= 0) {
      parsed.confidence = Math.round(parsed.confidence * 100);
    } else {
      parsed.confidence = Math.round(parsed.confidence);
    }
    parsed.confidence = Math.max(0, Math.min(100, parsed.confidence));
  } else {
    parsed.confidence = 0;
  }

  if (
    parsed.matched_customer_name === null ||
    parsed.confidence < threshold
  ) {
    delete (parsed as any).matched_customer_name;
  }

  return parsed;
}

// -----------------------------
// 3) Item matching helper
// -----------------------------

/**
 * callItemMatchAI
 * - For strict schema: include matched_item_number + matched_item_id in `required`,
 *   but allow them to be null when confidence is below threshold.
 * - Post-process: delete matched_item_number when it's null or low-confidence,
 *   so upstream sees it omitted.
 */
export async function callItemMatchAI(
  poLineDescriptions: string[],
  catalogList: Array<{ number: string; description: string; id?: string }>,
  threshold: number
): Promise<ItemMatchResponse> {
  const prompt = [
    "You are an industrial catalog matching assistant.",
    "For each PO line description, find the most likely matching catalog item.",
    "",
    "Pay attention to:",
    "- Terminal configurations (e.g., SPST, DPDT)",
    "- Colors (e.g., Blue, Red)",
    "- Text labels (e.g., 'Manual Dump', 'LP335')",
    "- Weather ratings (e.g., Weather Proof, WP)",
    "",
    `If confidence is below ${threshold}, set matched_item_number to null.`,
    "Return strict JSON only.",
    "IMPORTANT: For each match, return confidence as an INTEGER from 0 to 100 (no decimals).",
  ].join("\n");

  const input = {
    model: MODEL,
    text: {
      format: {
        name: "item_match_json",
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            matches: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  po_line_description: { type: "string" },
                  matched_item_number: { type: ["string", "null"] },
                  matched_item_id: { type: ["string", "null"] },
                  confidence: { type: "integer", minimum: 0, maximum: 100 }, // <- enforce integer
                  reasoning: { type: "string" },
                  warning: { type: ["string", "null"] },
                },
                required: [
                  "po_line_description",
                  "matched_item_number",
                  "matched_item_id",
                  "confidence",
                  "reasoning",
                  "warning",
                ],
              },
            },
          },
          required: ["matches"],
        },
      },
    },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          {
            type: "input_text",
            text:
              "Catalog Items (number + description + id):\n" +
              catalogList.map((c) => `- ${c.number}: ${c.description} : item_id: ${c.id}`).join("\n"),
          },
          {
            type: "input_text",
            text:
              "PO Line Descriptions:\n" +
              poLineDescriptions.map((d) => `- ${d}`).join("\n"),
          },
        ],
      },
    ],
    max_output_tokens: 4000,
  };

  const data = await postJsonWithRetry<any>("https://api.openai.com/v1/responses", input, 2);
  const outputText = extractOutputText(data);

  let parsed: ItemMatchResponse = { matches: [] };
  try {
    parsed = JSON.parse(outputText) as ItemMatchResponse;
  } catch {
    // leave empty
  }

  // Normalize confidence to integer 0..100 if the model ever sends a decimal
  parsed.matches = (parsed.matches || []).map((m) => {
    let conf = m.confidence as unknown as number;
    if (typeof conf !== "number") conf = 0;
    if (conf <= 1 && conf >= 0) conf = Math.round(conf * 100);
    else conf = Math.round(conf);
    conf = Math.max(0, Math.min(100, conf));

    const copy = { ...m, confidence: conf };

    if (copy.matched_item_number === null || copy.confidence < threshold) {
      delete (copy as any).matched_item_number;
    }
    return copy;
  });

  return parsed;
}

