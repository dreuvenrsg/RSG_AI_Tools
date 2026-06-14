# Zendesk support tickets

RSG's Zendesk support tickets are indexed for semantic search via `zendesk_ticket_search`. Use it for customer-service and finance questions that depend on ticket history — how an issue was resolved, prior complaints/RMAs/PO discussions for a customer, or tracing a thread to its related tickets — when the user is clearly asking about support cases rather than live ERP/accounting records.

- Each ticket is indexed as its **current** state: the full thread (public replies *and* internal agent notes), subject, tags, status, priority, type, requester/organization, assignee/group, dates, and linked tickets. Searching by meaning beats keywords — describe what you're looking for in plain language and let the tool match.
- **Always cite the tickets you used** by including their Zendesk `url` (e.g. `https://rsgsecurity.zendesk.com/agent/tickets/12345`). Lead with the answer, then the supporting tickets as links.
- Internal notes may appear in results. The audience is internal RSG staff, so that's fine — but don't repeat candid internal remarks back to a customer-facing context.
- Use the filters (`status`, `tags`, `date_from`/`date_to`, `requester`) to narrow when the user is specific (e.g. "open PO tickets for Acme this month").
- **Linked tickets** answer "this is confusing to navigate" questions: results include `linked` ids — `followupOf` (this ticket is a follow-up of a closed one), `followups`, `incidentOfProblem`, and `incidents`. When a ticket is a follow-up of, or the problem behind, others, say so and link them, since Zendesk's own UI makes those chains hard to see.
- `similarity` is a 0–1 cosine score (higher = closer). Treat low-similarity hits skeptically and say when nothing strongly matches rather than forcing an answer.
- Results are only as fresh as the last index. Tickets re-index on update (near-real-time) with a periodic catch-up, so a change made seconds ago may not be searchable yet — if exact current state matters, note that.
