// zendesk_ticket_search — semantic (vector) search over RSG's Zendesk tickets.
// Tickets are vectorized into Postgres/pgvector (see src/zendesk/); this tool
// embeds the user's question, finds the most relevant tickets, and returns them
// with deep links + linked-ticket references so the agent can answer and cite.
// The agent writes the prose; this returns data only.
export const definition = {
  name: "zendesk_ticket_search",
  description:
    "Search RSG's Zendesk support tickets by meaning (semantic vector search), not just keywords. " +
    "Use this for customer-service and finance questions that depend on ticket history: what was " +
    "decided on an issue, how a past case was resolved, complaints/RMAs/PO questions for a customer, " +
    "or to trace a thread to its related tickets. Each ticket's full thread (public replies AND " +
    "internal notes), tags, status, priority, requester/org, and linked tickets (follow-ups, " +
    "problem/incident chains) are indexed, so you can describe what you're looking for in plain " +
    "language. ALWAYS cite the tickets you used by including their Zendesk url. Optional filters " +
    "(status, tags, date range, requester) narrow results. Returns the best-matching tickets with a " +
    "snippet, similarity score, deep link, and any linked-ticket ids.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to find, in natural language (e.g. 'Mircom panel RMA shipping damage')" },
      status: { type: "string", description: "Filter to a Zendesk status: new, open, pending, hold, solved, closed" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Only tickets carrying at least one of these tags (e.g. ['purchase_order'])",
      },
      date_from: { type: "string", description: "Only tickets updated on/after this date, YYYY-MM-DD" },
      date_to: { type: "string", description: "Only tickets updated on/before this date, YYYY-MM-DD" },
      requester: { type: "string", description: "Substring match on requester name or organization" },
      limit: { type: "integer", description: "Max tickets to return (default 8, max 25)" },
    },
    required: ["query"],
  },
};

export async function run(input, { zendesk }) {
  if (!zendesk) throw new Error("Zendesk search is unavailable (no DATABASE_URL / OpenAI key configured).");
  return zendesk.search(input || {});
}

export default { definition, run };
