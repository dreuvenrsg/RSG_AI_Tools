// Zendesk API client for ticket indexing (read-only use here).
//
// Auth mirrors RSG_Website (app/api/tickets/route.ts): HTTP Basic with
// `base64("{email}/token:{token}")`. Email/token/subdomain resolve from env
// (ZENDESK_EMAIL / ZENDESK_TOKEN / ZENDESK_SUBDOMAIN — same names the website
// uses) or SSM. The website does keyword/tag search only; the incremental
// export + comment/incident sideloading below are net-new for vectorization.
import { loadSecret } from "../lib/ssm.js";

export const ZENDESK_TOKEN_PARAM = "/rsg-ai/prod/zendesk-token";
export const ZENDESK_EMAIL_PARAM = "/rsg-ai/prod/zendesk-email";
export const DEFAULT_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN || "rsgsecurity";

export class ZendeskClient {
  constructor({ email, token, subdomain }) {
    this.subdomain = subdomain;
    this.auth = "Basic " + Buffer.from(`${email}/token:${token}`).toString("base64");
  }

  static async create() {
    const [email, token] = await Promise.all([
      loadSecret(ZENDESK_EMAIL_PARAM, { env: "ZENDESK_EMAIL" }),
      loadSecret(ZENDESK_TOKEN_PARAM, { env: "ZENDESK_TOKEN" }),
    ]);
    return new ZendeskClient({ email, token, subdomain: DEFAULT_SUBDOMAIN });
  }

  get baseUrl() {
    return `https://${this.subdomain}.zendesk.com/api/v2`;
  }

  /** GET a path under /api/v2 with retry/backoff on 429 + 5xx; returns parsed JSON. */
  async get(path, { maxAttempts = 4, baseDelayMs = 600 } = {}) {
    const url = `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res, txt;
      try {
        res = await fetch(url, { headers: { Authorization: this.auth, Accept: "application/json" } });
        txt = await res.text();
      } catch (networkErr) {
        lastErr = networkErr;
        if (attempt < maxAttempts) { await sleep(baseDelayMs * attempt); continue; }
        throw networkErr;
      }
      if (res.ok) return txt ? JSON.parse(txt) : {};
      lastErr = new Error(`Zendesk ${res.status} for GET ${path}: ${txt.slice(0, 400)}`);
      // 429 honors Retry-After; 5xx backs off; anything else is fatal.
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(retryAfter ? retryAfter * 1000 : baseDelayMs * attempt);
        continue;
      }
      throw lastErr;
    }
    throw lastErr;
  }

  /** All comments for a ticket (oldest→newest), following pagination, with author sideload. */
  async getComments(id) {
    const comments = [];
    let path = `/tickets/${id}/comments.json?include=users&page[size]=100`;
    const users = new Map();
    for (let page = 0; page < 50 && path; page++) {
      const data = await this.get(path);
      for (const u of data.users || []) users.set(u.id, u);
      for (const c of data.comments || []) comments.push(c);
      path = data.meta?.has_more ? `/tickets/${id}/comments.json?include=users&page[size]=100&page[after]=${data.meta.after_cursor}` : null;
    }
    return { comments, users: [...users.values()] };
  }

  /** Incident ids of a problem ticket (empty/!ok for non-problem tickets). */
  async getIncidentIds(id) {
    try {
      const data = await this.get(`/tickets/${id}/incidents.json`);
      return (data.tickets || []).map((t) => t.id);
    } catch {
      return [];
    }
  }

  /**
   * Assemble everything needed to index one ticket: the ticket with sideloaded
   * users/groups/organizations, its full comment thread, and incident ids.
   * Shape matches what document.normalizeTicket() expects.
   */
  async getTicketBundle(id) {
    const ticketData = await this.get(`/tickets/${id}.json?include=users,groups,organizations`);
    const ticket = ticketData.ticket;
    if (!ticket) throw new Error(`Zendesk ticket ${id} not found`);
    const { comments, users: commentUsers } = await this.getComments(id);
    const incidentIds = ticket.type === "problem" ? await this.getIncidentIds(id) : [];
    // Merge ticket-show users with comment-author users.
    const users = mergeById(ticketData.users || [], commentUsers);
    return {
      ticket,
      users,
      groups: ticketData.groups || [],
      organizations: ticketData.organizations || [],
      comments,
      incidentIds,
      subdomain: this.subdomain,
    };
  }

  /**
   * One page of the Incremental Ticket Export, starting at a Unix-seconds
   * cursor. Returns { tickets, endTime, hasMore } so the caller advances by
   * end_time until end_of_stream. This is the reconciliation/backfill source.
   */
  async incrementalTickets(startTime) {
    const data = await this.get(`/incremental/tickets.json?start_time=${Math.floor(startTime)}`);
    return {
      tickets: data.tickets || [],
      endTime: data.end_time,
      hasMore: !data.end_of_stream,
    };
  }
}

function mergeById(a, b) {
  const m = new Map();
  for (const x of [...a, ...b]) if (x && x.id != null) m.set(x.id, x);
  return [...m.values()];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
