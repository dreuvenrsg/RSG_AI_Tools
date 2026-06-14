// Query-time facade wired into the agent ctx as `ctx.zendesk`. Embeds the user's
// query with OpenAI and runs the pgvector search, returning ticket-level hits
// (best chunk per ticket) with deep links and linked-ticket references for the
// agent to cite. Mirrors how QboClient/FulcrumClient are created and passed in ctx.
import { EmbeddingsClient } from "./embeddings.js";
import * as store from "./store.js";

const MAX_LIMIT = 25;
const SNIPPET_CHARS = 600;

export class ZendeskSearch {
  constructor(embeddings) {
    this.embeddings = embeddings;
  }

  static async create() {
    return new ZendeskSearch(await EmbeddingsClient.create());
  }

  async search({ query, status, tags, date_from, date_to, requester, limit } = {}) {
    if (!query || !String(query).trim()) throw new Error("query is required");
    const k = Math.min(Math.max(Number(limit) || 8, 1), MAX_LIMIT);
    const queryEmbedding = await this.embeddings.embedQuery(String(query));
    const rows = await store.search(
      queryEmbedding,
      {
        status,
        tags: Array.isArray(tags) ? tags : tags ? [tags] : undefined,
        dateFrom: date_from,
        dateTo: date_to,
        requester,
      },
      k
    );
    return {
      query,
      returned: rows.length,
      results: rows.map(shapeHit),
    };
  }
}

/** Reshape a DB row into a compact, citable hit. */
export function shapeHit(r) {
  const linked = {};
  if (r.followup_source_id) linked.followupOf = Number(r.followup_source_id);
  if (r.followup_ids?.length) linked.followups = r.followup_ids.map(Number);
  if (r.problem_id) linked.incidentOfProblem = Number(r.problem_id);
  if (r.incident_ids?.length) linked.incidents = r.incident_ids.map(Number);
  return {
    ticketId: Number(r.ticket_id),
    subject: r.subject,
    status: r.status,
    priority: r.priority,
    type: r.type,
    tags: r.tags || [],
    requester: r.requester,
    org: r.org,
    assignee: r.assignee,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    url: r.url,
    similarity: r.distance == null ? null : Number((1 - Number(r.distance)).toFixed(4)),
    snippet: String(r.text_content || "").slice(0, SNIPPET_CHARS),
    ...(Object.keys(linked).length ? { linked } : {}),
  };
}
