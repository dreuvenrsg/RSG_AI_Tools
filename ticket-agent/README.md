# ticket-agent

A self-contained TypeScript subsystem within **RSG_AI_Tools** that handles RSG's
Zendesk Support tickets. It was relocated here (from the former standalone
`CSDroid` repo) to keep RSG's AI work in one place; it deploys independently as
its own Serverless/Lambda stack and does not affect the root JS chat server.

## What it does

- **Agent-first customer service**: a Claude (Opus 4.8, modular via
  `CSDROID_AGENT_MODEL`) tool-use agent classifies each ticket into a taxonomy,
  decides one explicit **next action** (`draft_reply` | `no_response_needed` |
  `escalate`), and — for actionable types — drafts an **internal-only** reply.
- **Deterministic PO pipeline** (unchanged): PDF → OpenAI extraction → Fulcrum
  match → `purchase_order`/`ready_to_review` tag + `po_status`. The agent invokes
  it via the `run_po_pipeline` tool.
- **Order tracking / cancellation / pricing / lead-time** handlers, a generalized
  requester-authorization gate, multi-label type tagging, and CSV open-order-report
  enrichment.

**Safety invariant:** the agent NEVER messages a customer. Every reply is a
private Zendesk internal note; a chokepoint (`zendesk.ts` `assertPrivateComment`)
throws on any public comment.

## Layout

- `src/`: runtime logic (`src/agent/` = the agent; the rest = PO pipeline +
  Zendesk/Fulcrum/S3 data layer).
- `SPECS/`: behavior specs; `SPECS/customer-service-agent.md` is the main one.
- `LEARNINGS.md`: accumulated ticket-specific lessons.
- `AGENTS.md`: operating rules + inherited PoProcessor architecture reference.
- `test-*.ts`: verification harness (see below).

## Commands

```bash
npm install
npm run build                 # tsc
npm run test:safety           # asserts no public comments + dry-run suppresses writes
npm run test:eval -- all      # classification accuracy vs fixtures/golden-tickets.json (dry-run, classify-only)
npm run test:backtest -- --limit 25   # dry-run agent over recent tickets → reports/report.csv
npm run test:analytics        # type × outcome tag report (read-only)
npm run deploy                # serverless deploy (ingest HTTP + worker SQS)
```

- **Dry-run** (`CSDROID_DRY_RUN=1` / set by the test harness) suppresses every
  Zendesk write — safe to backtest over real tickets.
- **Classification-only** (`CSDROID_CLASSIFY_ONLY=1` / set by `test:eval`)
  short-circuits `run_po_pipeline` so the eval doesn't re-run GPT-5 extraction on
  POs already in Fulcrum.

## Environment

Local secrets live in `.env` (gitignored). Key vars: `ANTHROPIC_TOKEN` (falls
back to SSM `/rsg-ai/prod/anthropic-api-key`), `OPENAI_API_KEY`, `FULCRUM_TOKEN` /
`FULCRUM_API_URL` / `FULCRUM_ITEMS_BUCKET` / `FULCRUM_ITEMS_KEY`, `ZENDESK_SUBDOMAIN`
/ `ZENDESK_EMAIL` / `ZENDESK_API_TOKEN` / `ZENDESK_WEBHOOK_TOKEN`, `AWS_REGION`,
`SES_REGION` / `SES_FROM` / `NOTIFY_EMAIL`, the `PO_*_FIELD_ID` Zendesk custom
fields, and (optional) `CUSTOMER_PRICING_DOMAINS_TABLE` for domain-based auth.

## Deploy

Independent Serverless Framework stack (`serverless.yml`): `ingest` (HTTP webhook
→ SQS) + `worker` (SQS → processes one ticket, Node 22). It does not share the
root SAM/EC2 deploys. The Zendesk webhook points at this stack's `ingest` URL.
