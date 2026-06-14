// OpenAI embeddings client. Used to vectorize ticket chunks at index time and
// the user's query at search time. Key from env (OPENAI_API_KEY) or SSM.
//
// Model/dimension are configurable but MUST match the vector(N) column in
// schema.sql — default text-embedding-3-small @ 1536 dims. Changing the
// dimension is a schema migration, not just an env flip.
import { loadSecret } from "../lib/ssm.js";

export const OPENAI_KEY_PARAM = "/rsg-ai/prod/openai-api-key";
export const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
export const DEFAULT_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
export const EMBED_DIM = Number(process.env.OPENAI_EMBED_DIM || 1536);
const MAX_BATCH = 128;
const MAX_INPUT_CHARS = 8000; // text-embedding-3-* cap ~8191 tokens/item; stay under

export class EmbeddingsClient {
  constructor(apiKey, { model = DEFAULT_MODEL, dim = EMBED_DIM } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.dim = dim;
  }

  static async create(opts) {
    const apiKey = await loadSecret(OPENAI_KEY_PARAM, { env: "OPENAI_API_KEY" });
    return new EmbeddingsClient(apiKey, opts);
  }

  /** Embed an array of texts, batched. OpenAI has no document/query distinction. */
  async embed(texts, { maxAttempts = 4, baseDelayMs = 600 } = {}) {
    const out = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH).map((t) => (t || " ").slice(0, MAX_INPUT_CHARS));
      out.push(...(await this._embedBatch(batch, { maxAttempts, baseDelayMs })));
    }
    return out;
  }

  async _embedBatch(batch, { maxAttempts, baseDelayMs }) {
    // Only send `dimensions` when shortening below the model's native size
    // (text-embedding-3-small is natively 1536; sending 1536 is a no-op but
    // harmless — omit it to keep requests minimal).
    const payload = { input: batch, model: this.model, encoding_format: "float" };
    if (this.dim && this.dim !== 1536) payload.dimensions = this.dim;

    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res, txt;
      try {
        res = await fetch(OPENAI_EMBEDDINGS_URL, {
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
        return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      }
      lastErr = new Error(`OpenAI embeddings ${res.status}: ${txt.slice(0, 400)}`);
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        await sleep(baseDelayMs * attempt);
        continue;
      }
      throw lastErr;
    }
    throw lastErr;
  }

  embedDocuments(texts) {
    return this.embed(texts);
  }

  async embedQuery(text) {
    return (await this.embed([text]))[0];
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
