// Pure functions that turn a Zendesk ticket "bundle" (the ticket plus its
// sideloaded users/groups/orgs, comments, and link ids) into:
//   1. a normalized `meta` object (the structured columns we store), and
//   2. one or more text chunks, each prefixed with a structured header so the
//      ticket's properties (status, tags, requester, linked tickets, …) are
//      embedded *and* every chunk stays self-describing after retrieval.
//
// No I/O, no pg, no network — so this is unit-testable and importable without
// standing up the database. The indexer feeds these chunks to OpenAI + Postgres.

// Aim each chunk at a few thousand chars of thread so retrieval stays focused;
// the header is repeated on every chunk and doesn't count against this budget.
export const DEFAULT_CHUNK_CHARS = 6000;
const SEP = "\n----\n";

/** Look up a sideloaded entity by id in an array, returning {} when absent. */
function byId(list, id) {
  if (id == null) return {};
  return (list || []).find((x) => x && x.id === id) || {};
}

const NAMED_ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decode the HTML entities Zendesk leaves in comment bodies (&nbsp;, &amp;, &#39;, …). */
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e] ?? m;
  });
}

/**
 * Clean a Zendesk comment body for embedding/display: decode HTML entities,
 * strip any stray tags (some bodies arrive as HTML), and collapse the runaway
 * whitespace/blank lines Zendesk's plain_body carries. Pure + exported for tests.
 */
export function cleanText(s) {
  // Strip real HTML tags FIRST (on the raw string), THEN decode entities — so a
  // literal, entity-encoded "&lt;tag&gt;" survives as text instead of being
  // mistaken for a tag and removed.
  return decodeEntities(String(s || "").replace(/<[^>]+>/g, " "))
    .replace(/[ \t ]+/g, " ") // collapse runs of spaces (incl. nbsp char)
    .replace(/ *\n */g, "\n") // trim around newlines
    .replace(/\n{3,}/g, "\n\n") // collapse 3+ blank lines to one
    .trim();
}

/**
 * Normalize a raw Zendesk bundle into the flat meta we index + store.
 * bundle = { ticket, users, groups, organizations, comments, incidentIds, subdomain }
 */
export function normalizeTicket(bundle = {}) {
  const t = bundle.ticket || {};
  const users = bundle.users || [];
  const requester = byId(users, t.requester_id);
  const assignee = byId(users, t.assignee_id);
  const group = byId(bundle.groups, t.group_id);
  const org = byId(bundle.organizations, t.organization_id);
  const subdomain = bundle.subdomain || "rsgsecurity";

  // Follow-up tickets carry their source ticket id on via.source; the closed
  // source ticket carries followup_ids pointing the other way.
  const via = t.via || {};
  const followupSourceId =
    via?.source?.rel === "follow_up" ? Number(via?.source?.from?.ticket_id) || null : null;

  const comments = (bundle.comments || []).map((c) => ({
    author: byId(users, c.author_id).name || `user ${c.author_id}`,
    public: c.public !== false,
    createdAt: c.created_at || null,
    body: cleanText(c.plain_body || c.body),
  }));

  return {
    id: Number(t.id),
    subject: t.subject || "(no subject)",
    status: t.status || null,
    priority: t.priority || null,
    type: t.type || null,
    channel: via.channel || null,
    tags: Array.isArray(t.tags) ? t.tags : [],
    requester: requester.name || null,
    requesterEmail: requester.email || null,
    org: org.name || null,
    assignee: assignee.name || null,
    group: group.name || null,
    createdAt: t.created_at || null,
    updatedAt: t.updated_at || null,
    url: `https://${subdomain}.zendesk.com/agent/tickets/${t.id}`,
    problemId: Number(t.problem_id) || null,
    followupSourceId,
    followupIds: (t.followup_ids || []).map(Number).filter(Boolean),
    incidentIds: (bundle.incidentIds || []).map(Number).filter(Boolean),
    comments,
  };
}

function shortDate(iso) {
  return iso ? String(iso).slice(0, 10) : "?";
}

/** The structured header repeated on every chunk; encodes all ticket properties. */
export function buildHeader(meta) {
  const lines = [`Ticket #${meta.id} — "${meta.subject}"`];
  lines.push(
    `Status: ${meta.status || "?"} | Priority: ${meta.priority || "—"} | Type: ${meta.type || "—"}` +
      (meta.channel ? ` | Channel: ${meta.channel}` : "")
  );
  if (meta.tags.length) lines.push(`Tags: ${meta.tags.join(", ")}`);
  const requester = meta.requester
    ? `${meta.requester}${meta.org ? ` (${meta.org})` : ""}`
    : meta.org || "—";
  lines.push(`Requester: ${requester} | Assignee: ${meta.assignee || "unassigned"}${meta.group ? ` (${meta.group})` : ""}`);
  lines.push(`Created: ${shortDate(meta.createdAt)} | Updated: ${shortDate(meta.updatedAt)}`);

  const links = [];
  if (meta.followupSourceId) links.push(`follow-up of #${meta.followupSourceId}`);
  if (meta.followupIds.length) links.push(`has follow-ups #${meta.followupIds.join(", #")}`);
  if (meta.problemId) links.push(`incident of problem #${meta.problemId}`);
  if (meta.incidentIds.length) links.push(`problem for incidents #${meta.incidentIds.join(", #")}`);
  if (links.length) lines.push(`Linked: ${links.join(" · ")}`);

  return lines.join("\n");
}

/** Render one comment as a labeled block. */
function renderComment(c) {
  const visibility = c.public ? "public" : "internal";
  return `[${visibility}] ${c.author} — ${shortDate(c.createdAt)}\n${c.body}`;
}

/**
 * Split the comment thread into chunks under `maxChars`, packing whole comments
 * where possible and hard-splitting any single oversized comment. Each chunk is
 * prefixed with the header. Deterministic: same input → same chunks (and same
 * chunk_ids), which is what lets re-indexing replace rather than duplicate.
 */
export function chunkDocument(meta, { maxChars = DEFAULT_CHUNK_CHARS } = {}) {
  const header = buildHeader(meta);
  const blocks = meta.comments.map(renderComment);
  // A ticket with no comments still gets one chunk (header-only) so it's searchable.
  if (blocks.length === 0) blocks.push("(no comments)");

  const pieces = [];
  let current = "";
  const flush = () => {
    if (current) {
      pieces.push(current);
      current = "";
    }
  };
  for (const block of blocks) {
    if (block.length > maxChars) {
      // Oversized single comment: flush what we have, then hard-split it.
      flush();
      for (let i = 0; i < block.length; i += maxChars) pieces.push(block.slice(i, i + maxChars));
      continue;
    }
    if (current && current.length + 2 + block.length > maxChars) flush();
    current = current ? `${current}\n\n${block}` : block;
  }
  flush();

  return pieces.map((thread, chunkIndex) => ({
    chunkId: `${meta.id}:${chunkIndex}`,
    chunkIndex,
    text: `${header}${SEP}${thread}`,
  }));
}
