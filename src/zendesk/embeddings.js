// Voyage AI embeddings client (Anthropic's recommended embeddings provider —
// the Anthropic SDK has no embeddings endpoint). Used to vectorize ticket
// chunks at index time (input_type "document") and the user's query at search
// time (input_type "query"). Key from env (VOYAGE_API_KEY) or SSM.
//
// Model/dimension are configurable but MUST match the vector(N) column in
// schema.sql — default voyage-3-large @ 1024 dims. Changing the dimension is a
// schema migration, not just an env flip.
import { loadSecret } from "../lib/ssm.js";

export const VOYAGE_KEY_PARAM = "/rsg-ai/prod/voyage-api-key";
export const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
export const DEFAULT_MODEL = process.env.VOYAGE_MODEL || "voyage-3-large";
export const EMBED_DIM = Number(process.env.VOYAGE_DIM || 1024);
const MAX_BATCH = 64;

export class VoyageClient {
  constructor(apiKey, { model = DEFAULT_MODEL, dim = EMBED_DIM } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.dim = dim;
  }

  static async create(opts) {
    const apiKey = await loadSecret(VOYAGE_KEY_PARAM, { env: "VOYAGE_API_KEY" });
    return new VoyageClient(apiKey, opts);
  }

  /** Embed an array of texts; inputType is "document" (indexing) or "query" (search). */
  async embed(texts, inputType, { maxAttempts = 4, baseDelayMs = 600 } = {}) {
    const out = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      out.push(...(await this._embedBatch(batch, inputType, { maxAttempts, baseDelayMs })));
    }
    return out;
  }

  async _embedBatch(batch, inputType, { maxAttempts, baseDelayMs }) {
    const payload = {
      input: batch,
      model: this.model,
      input_type: inputType,
      output_dimension: this.dim,
    };
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res, txt;
      try {
        res = await fetch(VOYAGE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        txt = await res.text();
      } catch (networkErr) {
        lastErr = networkErr;
        if (attempt < maxAttempts) { await sleep(baseDelayMs * attempt); continue; }
        throw networkErr;
      }
      if (res.ok) {
        const json = JSON.parse(txt);
        // Voyage returns data sorted by index, but sort defensively.
        return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      }
      lastErr = new Error(`Voyage ${res.status}: ${txt.slice(0, 400)}`);
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        await sleep(baseDelayMs * attempt);
        continue;
      }
      throw lastErr;
    }
    throw lastErr;
  }

  embedDocuments(texts) {
    return this.embed(texts, "document");
  }

  async embedQuery(text) {
    return (await this.embed([text], "query"))[0];
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
