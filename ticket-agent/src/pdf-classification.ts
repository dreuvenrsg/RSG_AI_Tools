// src/pdf-classification.ts
// AI-powered PDF classification to identify purchase orders

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENAI_REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? "420000");
const MODEL = "gpt-5"; // Use same model as main PO processor
const CONFIDENCE_THRESHOLD = 0.8;

/**
 * Sleep utility
 */
async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Post JSON to OpenAI with retry logic
 */
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

/**
 * Extract output text from OpenAI Responses API
 */
function extractOutputText(data: any): string {
  const message = (data.output || []).find((o: any) => o.type === "message");
  if (!message) return "";
  const block = (message.content || []).find(
    (c: any) => c.type === "output_text" && typeof c.text === "string"
  );
  return block?.text || "";
}

export interface PdfAttachment {
  url: string;
  filename: string;
}

export interface ClassifiedPdf {
  url: string;
  filename: string;
  isPurchaseOrder: boolean;
  confidence: number;
  reasoning: string;
  extractedPoNumber?: string | null;
}

export interface PdfClassificationResult {
  purchaseOrders: ClassifiedPdf[];
  otherDocuments: ClassifiedPdf[];
  allClassified: ClassifiedPdf[];
}

/**
 * Classify a single PDF to determine if it's a purchase order
 * Uses GPT-4 Vision to analyze the document
 */
async function classifySinglePdf(pdf: PdfAttachment): Promise<ClassifiedPdf> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");

  const prompt = `You are a document classifier for RSG Security, a fire safety equipment manufacturer.

Analyze this PDF document and determine if it is a PURCHASE ORDER.

A Purchase Order typically contains:
- Title/header indicating "Purchase Order" or "PO"
- A PO number
- Line items with product descriptions, quantities, and prices
- Ship-to address
- Delivery date or requested ship date
- Buyer/customer company information

Documents that are NOT purchase orders:
- Invoices (have invoice numbers, not PO numbers)
- Quotes/proposals (pricing documents sent TO customers, not FROM customers)
- Packing slips/shipping documents
- Specification sheets
- Brochures or marketing materials
- Certifications or compliance documents

Respond in JSON format:
{
  "isPurchaseOrder": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of why this is or is not a purchase order",
  "extractedPoNumber": "PO number if found, otherwise null",
  "documentType": "Best guess at document type (e.g., 'invoice', 'quote', 'brochure', 'purchase order')"
}`;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      isPurchaseOrder: { type: "boolean" },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1
      },
      reasoning: { type: "string" },
      extractedPoNumber: { type: ["string", "null"] },
      documentType: { type: "string" }
    },
    required: ["isPurchaseOrder", "confidence", "reasoning", "extractedPoNumber", "documentType"]
  };

  const body = {
    model: MODEL,
    text: {
      format: {
        name: "pdf_classification",
        type: "json_schema",
        schema
      }
    },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_file", file_url: pdf.url }
        ]
      }
    ],
    max_output_tokens: 1000
  };

  console.log(`[PDF Classification] Analyzing: ${pdf.filename}`);

  const data = await postJsonWithRetry<any>("https://api.openai.com/v1/responses", body, 2);
  const outputText = extractOutputText(data);

  let result: any;
  try {
    result = JSON.parse(outputText);
  } catch {
    // Fallback if parsing fails
    console.error(`[PDF Classification] Failed to parse response for ${pdf.filename}`);
    return {
      url: pdf.url,
      filename: pdf.filename,
      isPurchaseOrder: false,
      confidence: 0,
      reasoning: "Failed to parse AI classification response",
      extractedPoNumber: null
    };
  }

  console.log(`[PDF Classification] ${pdf.filename}: isPO=${result.isPurchaseOrder}, confidence=${result.confidence}, type=${result.documentType}`);

  return {
    url: pdf.url,
    filename: pdf.filename,
    isPurchaseOrder: result.isPurchaseOrder,
    confidence: result.confidence,
    reasoning: result.reasoning,
    extractedPoNumber: result.extractedPoNumber || null
  };
}

/**
 * Classify multiple PDF attachments to identify purchase orders
 * Processes sequentially to avoid rate limits
 *
 * @param pdfs Array of PDF attachments to classify
 * @returns Classification results with purchase orders separated from other documents
 */
export async function classifyPdfAttachments(pdfs: PdfAttachment[]): Promise<PdfClassificationResult> {
  console.log(`[PDF Classification] Starting classification of ${pdfs.length} PDFs`);

  const allClassified: ClassifiedPdf[] = [];

  // Process sequentially to avoid rate limits and manage costs
  for (const pdf of pdfs) {
    try {
      const classified = await classifySinglePdf(pdf);
      allClassified.push(classified);
    } catch (error: any) {
      console.error(`[PDF Classification] Error classifying ${pdf.filename}:`, error);
      // On error, mark as non-PO with zero confidence
      allClassified.push({
        url: pdf.url,
        filename: pdf.filename,
        isPurchaseOrder: false,
        confidence: 0,
        reasoning: `Classification error: ${error.message}`,
        extractedPoNumber: null
      });
    }
  }

  // Filter purchase orders (must meet confidence threshold)
  const purchaseOrders = allClassified.filter(
    pdf => pdf.isPurchaseOrder && pdf.confidence >= CONFIDENCE_THRESHOLD
  );

  const otherDocuments = allClassified.filter(
    pdf => !pdf.isPurchaseOrder || pdf.confidence < CONFIDENCE_THRESHOLD
  );

  console.log(`[PDF Classification] Results: ${purchaseOrders.length} POs, ${otherDocuments.length} other documents`);

  return {
    purchaseOrders,
    otherDocuments,
    allClassified
  };
}
