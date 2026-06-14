# PoProcessor Learnings

## 2026-04-04

### Ticket pattern: Zendesk ticket 29154 style open-order-report CSV

- The attachment is a CSV open order report, not a PDF purchase order and not a normal free-text tracking request.
- The original failure mode was extracting stray numbers from the attachment filename (`R564311OP_M100V001_771423_PDF.csv`) instead of parsing the CSV contents.
- The report rows use a customer-facing purchase-order number like `695455`, while Fulcrum stores the corresponding `customerPoNumber` as `695455 OP 00100 000`.
- The right handling path is:
  1. read the ticket body,
  2. download the CSV attachment,
  3. parse the report rows,
  4. resolve each base PO number to Fulcrum,
  5. enrich each row with `Promise / Ship Date` and `Tracking Number`,
  6. attach the regenerated CSV back to Zendesk for review.

### Live-test discipline

- If the source ticket is closed or should not be mutated, create a validation copy and close it in `finally` even when the test fails.
- The validation copy subject should be obviously disposable, for example `[PoProcessor Live Test] 29154 - Open PO report`.

### Local execution

- Shell-sourced `.env` values are not visible to child Node processes unless they are exported. Use `src/env.ts` in TS entrypoints or `set -a && source .env && set +a` in shell-driven Node checks.

## 2026-06-13

### Customer-service agent (non-PO handling)

- **No programmatic Zendesk "draft":** Zendesk has no reliable API to populate an agent's composer draft. Drafts are posted as PRIVATE internal notes (`public:false`). `zendesk.ts` routes comment writes through `assertPrivateComment`, which throws on any public comment — the system structurally cannot message a customer.
- **Backtest safely with dry-run:** `CSDROID_DRY_RUN=1` (or `setDryRun(true)`) suppresses + records every mutating Zendesk call while leaving reads intact. `npm run test:backtest` runs the full agent over real tickets and writes `reports/report.{jsonl,csv}` with zero writes.
- **Dry-run ≠ no compute.** Dry-run only blocks Zendesk WRITES — it does NOT stop the reads/OpenAI work inside `run_po_pipeline`. For the classification eval use `CSDROID_CLASSIFY_ONLY=1` (`test:eval` sets it), which short-circuits `run_po_pipeline` so PO fixtures don't re-run GPT-5 Vision extraction on POs already in Fulcrum. Classification is decided at `classify_and_tag`, before the pipeline.
- **Anthropic key resolution:** `resolveAnthropicClient` prefers `ANTHROPIC_TOKEN`/`ANTHROPIC_API_KEY` then falls back to SSM `/rsg-ai/prod/anthropic-api-key` (same as RSG_AI_Tools), so prod/Lambda works via IAM role. The committed local `.env` `ANTHROPIC_TOKEN` was stale during development — override it (`ANTHROPIC_TOKEN= npm run test:eval`) to force the SSM key.
- **Ticket 34177 fuzzy-match gap:** the agent's `lookup_order_tracking` resolved orders that the old batched `findSalesOrdersByPO` reported NOT_FOUND. Fulcrum list endpoints order by sales-order number ascending and ignore server-side sorting, so recent orders need deep paging — keep reconciling the batch cap.
- **Don't trust subject-line tokens as POs (34137):** a token in the subject may be a reference number, not a PO. The agent is instructed not to treat it as a PO without body/context corroboration.
- **Full-thread context is required.** The agent must be given the WHOLE comment thread (labeled CUSTOMER vs RSG), not just the first + last comment — otherwise mid-thread customer intent is invisible (34110's cancellation arrived in a later customer message and was being missed entirely). See `buildUserMessage` in `orchestrator.ts`.
- **Tag cumulatively (multi-label).** A thread evolves (lead-time→order, product-question→new-customer onboarding→order). Apply a tag for EVERY type it touched (primary + `additionalTags`), so analytics is a set-membership query. The eval scores by set membership accordingly.
- **`nextAction` is the central output — keep it explicit.** Tags say what a ticket IS; `nextAction` (`draft_reply` | `no_response_needed` | `escalate`) says what we DO. Don't let multi-label tagging blur the one action. The internal note leads with PRIMARY INTENT + NEXT ACTION + WHY so a reviewer sees the decision immediately.
- **One-off learnings live in `src/agent/learnings.ts`** (`AGENT_LEARNINGS`, injected into the system prompt). Add a bullet there to fix a repeatable case (e.g. Potter "Late Purchase Orders" notices = order-status requests, not no_response). Kept as a bundled TS string so it ships to Lambda.
- **Eval:** `test:eval all` went 70.4% → 88.9% (single-label) → **100% (27/27)** with multi-label scoring. The `po_not_entered` aux 0/2 is fixture staleness — those POs are now live in Fulcrum, so the agent reads current state and correctly does not flag them.
