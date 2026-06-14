// src/agent/fulcrumClient.ts
// Read-only Fulcrum Pro API client for the customer-service agent.
// Ported from RSG_AI_Tools (src/fulcrum/client.js). Token from FULCRUM_TOKEN.
//
// Read-only guard: GET is always allowed; POST only to ".../list" search
// endpoints (Fulcrum's list/search convention). The agent must never mutate ERP
// data.

const FULCRUM_BASE_URL =
  (process.env.FULCRUM_API_URL || "https://api.fulcrumpro.com") + "/api";

export function isReadOnlyRequest(method: string, endpoint: string): boolean {
  const m = String(method || "").toUpperCase();
  if (m === "GET") return true;
  if (m === "POST") return /\/list$/.test(String(endpoint).split("?")[0]);
  return false;
}

const MAX_RESULT_CHARS = 30000;

/** Shrink a Fulcrum response so it fits the model context. */
export function fitForModel(data: any, maxChars = MAX_RESULT_CHARS): any {
  const full = JSON.stringify(data);
  if (full.length <= maxChars) return data;
  const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null;
  if (rows) {
    let keep = rows.length;
    while (keep > 1 && JSON.stringify(rows.slice(0, keep)).length > maxChars) {
      keep = Math.floor(keep / 2);
    }
    return {
      totalRowsReturnedByApi: rows.length,
      rowsShown: keep,
      note: `response truncated: showing ${keep} of ${rows.length} rows — use Skip/Take paging or tighter filters`,
      rows: rows.slice(0, keep),
    };
  }
  return { note: "response truncated to fit context", json: full.slice(0, maxChars) };
}

export class FulcrumReadClient {
  constructor(private apiKey: string) {}

  static create(): FulcrumReadClient {
    const key = process.env.FULCRUM_TOKEN || process.env.FULCRUM_API_KEY;
    if (!key) throw new Error("FULCRUM_TOKEN not configured");
    return new FulcrumReadClient(key);
  }

  async request(
    method: string,
    endpoint: string,
    body: any = null,
    { maxAttempts = 3, baseDelayMs = 600 }: { maxAttempts?: number; baseDelayMs?: number } = {}
  ): Promise<any> {
    if (!isReadOnlyRequest(method, endpoint)) {
      throw new Error(
        `Refused: only GET and POST to .../list endpoints are allowed (got ${method} ${endpoint})`
      );
    }
    const url = `${FULCRUM_BASE_URL}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
    const options: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
    };
    if (body && method.toUpperCase() !== "GET") options.body = JSON.stringify(body);

    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response, txt: string;
      try {
        res = await fetch(url, options);
        txt = await res.text();
      } catch (networkErr) {
        lastErr = networkErr;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
          continue;
        }
        throw networkErr;
      }
      if (res.ok) return txt ? JSON.parse(txt) : {};
      lastErr = new Error(`Fulcrum API ${res.status} for ${method} ${endpoint}: ${txt.slice(0, 400)}`);
      if (res.status >= 500 && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
        continue;
      }
      throw lastErr;
    }
    throw lastErr;
  }
}
