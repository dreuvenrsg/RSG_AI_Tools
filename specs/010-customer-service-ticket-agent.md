# 010 — Customer-Service Ticket Agent (`ticket-agent/`)

**Status:** shipped (2026-06-13) — relocated into this repo from the former
standalone `CSDroid` repo.

## Problem / Goal

RSG's Zendesk Support tickets were handled by a standalone repo (`CSDroid`) with a
strong deterministic PO pipeline but a weak, hardcoded classify→route layer for
everything else, and no ticket-type analytics. We rebuilt that layer as an
agent-first system and consolidated it here so all of RSG's AI work lives in one
place (this repo already has the agent loop, Fulcrum client, tool registry, and a
Zendesk integration). It lives in its own self-contained TypeScript folder,
`ticket-agent/`, and deploys independently — the root JS chat server and SAM/EC2
deploys are untouched.

## Approach

- **Agent-first.** A Claude (Opus 4.8, modular) tool-use agent classifies each
  ticket, decides one explicit **next action** (`draft_reply` |
  `no_response_needed` | `escalate`), and drafts **internal-only** replies. The
  proven deterministic PO pipeline is unchanged and invoked as the
  `run_po_pipeline` tool.
- **Taxonomy + multi-label tagging.** 13 categories (`ticket-categories.ts`); a
  ticket carries a tag for every type it exhibited over its life (primary +
  additionalTags), so analytics is a set-membership query.
- **Authorization gate** before disclosing any customer-specific data; **full
  conversation** is read (labeled CUSTOMER vs RSG) so mid-thread intent isn't lost.
- **Safety:** drafts are private internal notes only; an `assertPrivateComment`
  chokepoint throws on any public comment. A dry-run kill-switch suppresses all
  Zendesk writes for backtesting; classification-only mode skips the PO pipeline's
  GPT-5 extraction during the eval.
- **Self-contained move.** Whole subsystem copied as one TS folder (own
  `package.json`/`tsconfig`/`serverless.yml`); no cross-repo calls; convergence
  onto this repo's shared JS primitives is deferred.

Detailed design: `ticket-agent/SPECS/customer-service-agent.md`. Operating rules
and inherited architecture: `ticket-agent/AGENTS.md`, `ticket-agent/LEARNINGS.md`.

## Tasks

- [x] Agent layer (loop, orchestrator, system prompt, tools, learnings) + taxonomy
- [x] Authorization gate, pricing/lead-time/customer-lookup, response style
- [x] Explicit `nextAction`; multi-label tagging; full-thread context
- [x] Verification harness (safety, eval, backtest, analytics) + golden set (37)
- [x] Relocate to `ticket-agent/`; verify build + harness parity in new location
- [ ] Deploy the Serverless stack from `ticket-agent/` and re-point the Zendesk webhook
- [ ] Archive the old `CSDroid` repo (README pointer)

## Verification

- `cd ticket-agent && npm install && npm run build` — clean `tsc`.
- `npm run test:safety` passes; `npm run test:eval -- all` = 100% (37/37,
  multi-label, classification-only); `npm run test:backtest -- --limit N` = 0 real
  writes. Verified end-to-end (Anthropic + Fulcrum + Zendesk reads) in the new
  location.

## Follow-ups

- [ ] Converge `ticket-agent/` onto this repo's shared JS Fulcrum client, agent
  loop, Zendesk client, and SSM secret loader (`src/lib/ssm.js`) to remove the
  duplication created by the original port.
- [ ] Rename the `CSDROID_*` env flags to a neutral prefix.
- [ ] Wire `CUSTOMER_PRICING_DOMAINS_TABLE` for full domain-based authorization.
