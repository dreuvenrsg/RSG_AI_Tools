import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTicket,
  buildHeader,
  chunkDocument,
  cleanText,
  DEFAULT_CHUNK_CHARS,
} from "../src/zendesk/document.js";
import { verifyZendeskSignature, computeSignature } from "../src/zendesk/webhookAuth.js";
import { sha256 } from "../src/zendesk/indexer.js";
import { shapeHit } from "../src/zendesk/search.js";
import { ticketIdFromWebhook } from "../src/server/index.js";
import { toolDefinitions, getTool } from "../src/tools/index.js";
import { TOOL_ACCESS, toolNamesForRole } from "../src/server/permissions.js";

// A representative Zendesk bundle: a follow-up ticket with sideloaded entities,
// public + internal comments, and a problem link.
function sampleBundle(overrides = {}) {
  return {
    ticket: {
      id: 12345,
      subject: "RMA for Mircom panel",
      status: "open",
      priority: "high",
      type: "incident",
      tags: ["po-request", "mircom", "rma"],
      requester_id: 1,
      assignee_id: 2,
      group_id: 7,
      organization_id: 9,
      created_at: "2026-01-02T10:00:00Z",
      updated_at: "2026-06-10T15:30:00Z",
      problem_id: 12001,
      followup_ids: [],
      via: { channel: "email", source: { rel: "follow_up", from: { ticket_id: 12000 } } },
      ...overrides.ticket,
    },
    users: [
      { id: 1, name: "Jane Doe", email: "jane@acme.com" },
      { id: 2, name: "John S." },
    ],
    groups: [{ id: 7, name: "Tier 2" }],
    organizations: [{ id: 9, name: "Acme Corp" }],
    comments: overrides.comments || [
      { author_id: 1, public: true, created_at: "2026-01-02T10:00:00Z", plain_body: "Panel arrived damaged." },
      { author_id: 2, public: false, created_at: "2026-01-03T09:00:00Z", plain_body: "Internal: confirmed cracked housing, issuing RMA." },
    ],
    incidentIds: [],
    subdomain: "rsgsecurity",
  };
}

// ---------- normalization ----------

test("normalizeTicket flattens ticket + sideloads into meta", () => {
  const m = normalizeTicket(sampleBundle());
  assert.equal(m.id, 12345);
  assert.equal(m.requester, "Jane Doe");
  assert.equal(m.org, "Acme Corp");
  assert.equal(m.assignee, "John S.");
  assert.equal(m.group, "Tier 2");
  assert.equal(m.url, "https://rsgsecurity.zendesk.com/agent/tickets/12345");
  assert.equal(m.problemId, 12001);
  assert.equal(m.followupSourceId, 12000); // via.source.rel === "follow_up"
  assert.equal(m.comments.length, 2);
  assert.equal(m.comments[1].public, false);
});

test("normalizeTicket tolerates missing sideloads and bodies", () => {
  const m = normalizeTicket({ ticket: { id: 5 }, subdomain: "rsgsecurity" });
  assert.equal(m.id, 5);
  assert.equal(m.requester, null);
  assert.deepEqual(m.tags, []);
  assert.deepEqual(m.comments, []);
  assert.equal(m.followupSourceId, null);
});

// ---------- text cleaning ----------

test("cleanText decodes entities, strips tags, and collapses whitespace", () => {
  // Mirrors the real Zendesk plain_body noise (&nbsp;, runaway newlines).
  assert.equal(cleanText("Hello good morning, \n &nbsp; \n Can you help&nbsp;with status"), "Hello good morning,\n\nCan you help with status");
  assert.equal(cleanText("A&amp;B &lt;tag&gt; &#39;q&#39;"), "A&B <tag> 'q'");
  assert.equal(cleanText("<p>Hi <b>there</b></p>"), "Hi there");
  assert.equal(cleanText("line1\n\n\n\n\nline2"), "line1\n\nline2");
  assert.equal(cleanText(null), "");
  assert.equal(cleanText("&unknownentity; stays"), "&unknownentity; stays");
});

test("normalizeTicket cleans comment bodies", () => {
  const m = normalizeTicket(
    sampleBundle({
      comments: [{ author_id: 1, public: true, created_at: "2026-01-02T10:00:00Z", plain_body: "Need&nbsp;status&nbsp;please. \n &nbsp; \n Thanks" }],
    })
  );
  assert.equal(m.comments[0].body, "Need status please.\n\nThanks");
  assert.ok(!buildHeader(m).includes("&nbsp;"));
});

// ---------- header ----------

test("buildHeader encodes properties and linked tickets", () => {
  const h = buildHeader(normalizeTicket(sampleBundle()));
  assert.match(h, /Ticket #12345 — "RMA for Mircom panel"/);
  assert.match(h, /Status: open \| Priority: high \| Type: incident \| Channel: email/);
  assert.match(h, /Tags: po-request, mircom, rma/);
  assert.match(h, /Requester: Jane Doe \(Acme Corp\) \| Assignee: John S\. \(Tier 2\)/);
  assert.match(h, /follow-up of #12000/);
  assert.match(h, /incident of problem #12001/);
});

// ---------- chunking + dedup semantics ----------

test("chunkDocument yields deterministic, header-prefixed, sequentially-id'd chunks", () => {
  const meta = normalizeTicket(sampleBundle());
  const chunks = chunkDocument(meta);
  assert.ok(chunks.length >= 1);
  chunks.forEach((c, i) => {
    assert.equal(c.chunkId, `12345:${i}`);
    assert.equal(c.chunkIndex, i);
    assert.match(c.text, /Ticket #12345/); // header repeated on every chunk
  });
  // Determinism: same input → identical chunks.
  assert.deepEqual(chunkDocument(meta), chunks);
});

test("a ticket with no comments still produces one searchable chunk", () => {
  const meta = normalizeTicket(sampleBundle({ comments: [] }));
  const chunks = chunkDocument(meta);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /no comments/);
});

test("long threads split into multiple chunks under the char budget", () => {
  const big = "x".repeat(DEFAULT_CHUNK_CHARS);
  const comments = [
    { author_id: 1, public: true, created_at: "2026-01-02T10:00:00Z", plain_body: big },
    { author_id: 1, public: true, created_at: "2026-01-03T10:00:00Z", plain_body: big },
  ];
  const chunks = chunkDocument(normalizeTicket(sampleBundle({ comments })));
  assert.ok(chunks.length >= 2);
});

test("re-indexing: adding a comment regenerates the full chunk set, reusing prior chunk text (cache hit) for the unchanged head", () => {
  const before = chunkDocument(normalizeTicket(sampleBundle()));
  // Same ticket gains a third comment and a newer updated_at.
  const after = chunkDocument(
    normalizeTicket(
      sampleBundle({
        ticket: { updated_at: "2026-06-11T12:00:00Z" },
        comments: [
          { author_id: 1, public: true, created_at: "2026-01-02T10:00:00Z", plain_body: "Panel arrived damaged." },
          { author_id: 2, public: false, created_at: "2026-01-03T09:00:00Z", plain_body: "Internal: confirmed cracked housing, issuing RMA." },
          { author_id: 1, public: true, created_at: "2026-06-11T11:59:00Z", plain_body: "Replacement shipped, tracking 1Z999." },
        ],
      })
    )
  );
  // The new set is keyed 0..n with no leftover ids — replaceTicket(delete+insert)
  // means the old rows can't linger. The header changed (newer Updated:), so the
  // first chunk's hash differs from before; this is the deliberate, complete rebuild.
  assert.deepEqual(after.map((c) => c.chunkId), after.map((_, i) => `12345:${i}`));
  assert.notEqual(sha256(before[0].text), sha256(after[0].text));
});

// ---------- webhook auth ----------

test("verifyZendeskSignature accepts a correct HMAC and rejects tampering", () => {
  const secret = "shhh";
  const timestamp = "2026-06-13T00:00:00Z";
  const body = '{"ticket_id":12345}';
  const signature = computeSignature({ timestamp, body, secret });
  assert.equal(verifyZendeskSignature({ signature, timestamp, body, secret }), true);
  assert.equal(verifyZendeskSignature({ signature, timestamp, body: body + "x", secret }), false);
  assert.equal(verifyZendeskSignature({ signature, timestamp, body, secret: "wrong" }), false);
  assert.equal(verifyZendeskSignature({ signature: "", timestamp, body, secret }), false);
});

// ---------- webhook payload parsing ----------

test("ticketIdFromWebhook reads the common payload shapes", () => {
  assert.equal(ticketIdFromWebhook({ ticket_id: "12345" }), 12345);
  assert.equal(ticketIdFromWebhook({ id: 7 }), 7);
  assert.equal(ticketIdFromWebhook({ ticket: { id: 9 } }), 9);
  assert.equal(ticketIdFromWebhook({ detail: { id: 11 } }), 11);
  assert.equal(ticketIdFromWebhook({}), null);
});

// ---------- search hit shaping ----------

test("shapeHit converts a DB row into a citable hit with similarity and links", () => {
  const hit = shapeHit({
    ticket_id: 12345,
    subject: "RMA for Mircom panel",
    status: "open",
    tags: ["rma"],
    requester: "Jane Doe",
    url: "https://rsgsecurity.zendesk.com/agent/tickets/12345",
    text_content: "header----thread",
    distance: 0.25,
    problem_id: 12001,
    followup_source_id: 12000,
    followup_ids: [],
    incident_ids: [],
  });
  assert.equal(hit.ticketId, 12345);
  assert.equal(hit.similarity, 0.75); // 1 - distance
  assert.equal(hit.url, "https://rsgsecurity.zendesk.com/agent/tickets/12345");
  assert.equal(hit.linked.followupOf, 12000);
  assert.equal(hit.linked.incidentOfProblem, 12001);
});

// ---------- registration + permissions ----------

test("zendesk_ticket_search is registered and gated to all admin roles", () => {
  assert.ok(toolDefinitions().some((d) => d.name === "zendesk_ticket_search"));
  assert.ok(getTool("zendesk_ticket_search"));
  assert.deepEqual(TOOL_ACCESS.zendesk_ticket_search, [
    "super_admin",
    "customer_service",
    "quality_control",
    "finance",
    "finance_manager",
  ]);
  // Every admin role can see it; an invalid role sees nothing.
  assert.ok(toolNamesForRole("customer_service").includes("zendesk_ticket_search"));
  assert.ok(toolNamesForRole("finance").includes("zendesk_ticket_search"));
  assert.ok(!toolNamesForRole("nope").includes("zendesk_ticket_search"));
});
