#!/usr/bin/env node
// RSG AI agent API — the HTTP backend the website chat interface talks to.
// See docs/rsg-ai-api.md for the contract.
//
//   RSG_AI_API_KEY=<shared secret> ANTHROPIC_API_KEY=<key> node src/server/index.js
//
// Env: PORT (default 8787), RSG_AI_MODEL (default claude-opus-4-8),
//      RSG_AI_API_KEY (required outside dev), RSG_AI_CORS_ORIGIN (dev only).
import http from "node:http";
import { randomUUID } from "node:crypto";
import { QboClient } from "../qbo/client.js";
import { FulcrumClient } from "../fulcrum/client.js";
import { ZendeskSearch } from "../zendesk/search.js";
import { ZendeskClient } from "../zendesk/client.js";
import { VoyageClient } from "../zendesk/embeddings.js";
import { indexTicket, runReconcile } from "../zendesk/indexer.js";
import { verifyZendeskSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../zendesk/webhookAuth.js";
import { loadSecret } from "../lib/ssm.js";
import { toolDefinitions } from "../tools/index.js";
import { runAgentTurn, resolveAnthropicClient, DEFAULT_MODEL } from "./agentLoop.js";
import { createLogger, truncate, lastUserText } from "./log.js";
import { normalizeMessages } from "./attachments.js";
import { isValidRole, toolNamesForRole, PERMISSION_MESSAGE } from "./permissions.js";

export const ZENDESK_WEBHOOK_SECRET_PARAM = "/rsg-ai/prod/zendesk-webhook-secret";

/** Pull the ticket id out of whatever shape the Zendesk webhook is configured to send. */
export function ticketIdFromWebhook(payload = {}) {
  const id = payload.ticket_id ?? payload.id ?? payload.ticket?.id ?? payload.detail?.id;
  return id != null && id !== "" ? Number(id) : null;
}

const MAX_BODY_BYTES = 30 * 1024 * 1024; // remittance PDFs ride in as base64

export function isAuthorized(req, apiKey) {
  if (!apiKey) return false;
  return (req.headers.authorization || "") === `Bearer ${apiKey}`;
}

export function sseEncode(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, statusCode, body, corsOrigin) {
  const headers = { "Content-Type": "application/json" };
  if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(body));
}

export function createServer({ apiKey = process.env.RSG_AI_API_KEY, corsOrigin = process.env.RSG_AI_CORS_ORIGIN } = {}) {
  if (!apiKey) {
    console.warn("[rsg-ai] WARNING: RSG_AI_API_KEY is not set — all requests will be rejected.");
  }
  // Lazy + shared: one Anthropic key resolution and one QBO token refresh per
  // process, reused across requests; reset on failure so the next request retries.
  let anthropicPromise = null;
  const getAnthropic = () => (anthropicPromise ??= resolveAnthropicClient().catch((err) => {
    anthropicPromise = null;
    throw err;
  }));
  let qboPromise = null;
  const getQbo = () => (qboPromise ??= QboClient.create().catch((err) => {
    qboPromise = null;
    throw err;
  }));
  let fulcrumPromise = null;
  const getFulcrum = () => (fulcrumPromise ??= FulcrumClient.create().catch((err) => {
    fulcrumPromise = null;
    throw err;
  }));
  // Zendesk search is optional infra (needs DATABASE_URL + Voyage). Resolve to
  // null on failure so the rest of the agent still works without it; the tool
  // surfaces a clear message when null.
  let zendeskPromise = null;
  const getZendesk = () => (zendeskPromise ??= ZendeskSearch.create().catch((err) => {
    zendeskPromise = null;
    console.warn("[rsg-ai] Zendesk search unavailable:", err.message);
    return null;
  }));
  // Indexing deps (Zendesk API + Voyage) + webhook secret, for the webhook route.
  let indexerPromise = null;
  const getZendeskIndexer = () => (indexerPromise ??= Promise.all([ZendeskClient.create(), VoyageClient.create()])
    .then(([zendesk, voyage]) => ({ zendesk, voyage }))
    .catch((err) => { indexerPromise = null; throw err; }));
  let webhookSecretPromise = null;
  const getWebhookSecret = () => (webhookSecretPromise ??= loadSecret(ZENDESK_WEBHOOK_SECRET_PARAM, { env: "ZENDESK_WEBHOOK_SECRET" })
    .catch((err) => { webhookSecretPromise = null; throw err; }));

  const log = createLogger();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const requestId = randomUUID();
    // The interface's conversation id — tags every log line for a turn so a
    // whole chat can be grepped out of the JSONL when debugging.
    let chatId = null;
    try {
      if (req.method === "OPTIONS" && corsOrigin) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Headers": "Authorization, Content-Type, X-RSG-User, X-RSG-Role, X-RSG-Chat-Id",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        });
        return res.end();
      }

      if (url.pathname === "/healthz") {
        return json(res, 200, { ok: true, model: DEFAULT_MODEL }, corsOrigin);
      }

      // Zendesk webhook: authenticated by HMAC signature, NOT the bearer key,
      // so it sits before the bearer gate. Acknowledges fast, then re-indexes
      // the ticket in the background (replacing its rows — no duplication).
      if (req.method === "POST" && url.pathname === "/api/zendesk/webhook") {
        const raw = await readBody(req);
        let secret;
        try {
          secret = await getWebhookSecret();
        } catch (err) {
          return json(res, 503, { error: "Webhook secret not configured" }, corsOrigin);
        }
        const valid = verifyZendeskSignature({
          signature: req.headers[SIGNATURE_HEADER],
          timestamp: req.headers[TIMESTAMP_HEADER],
          body: raw,
          secret,
        });
        if (!valid) return json(res, 401, { error: "Invalid signature" }, corsOrigin);

        let payload = {};
        try { payload = JSON.parse(raw); } catch { /* tolerate non-JSON bodies */ }
        const ticketId = ticketIdFromWebhook(payload);
        if (!ticketId) return json(res, 400, { error: "No ticket id in payload" }, corsOrigin);

        json(res, 200, { ok: true, ticketId }, corsOrigin);
        // Fire-and-forget: the response is already sent.
        getZendeskIndexer()
          .then((deps) => indexTicket(ticketId, deps))
          .then((r) => log({ type: "zendesk_index", requestId, ticketId, ...r }))
          .catch((err) => log({ type: "zendesk_index_error", requestId, ticketId, error: err.message }));
        return;
      }

      if (!isAuthorized(req, apiKey)) {
        return json(res, 401, { error: "Unauthorized" }, corsOrigin);
      }

      if (req.method === "GET" && url.pathname === "/api/tools") {
        const role = url.searchParams.get("role");
        const defs = role
          ? toolDefinitions().filter((d) => toolNamesForRole(role).includes(d.name))
          : toolDefinitions();
        return json(res, 200, { role: role || null, tools: defs }, corsOrigin);
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = JSON.parse(await readBody(req));
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          return json(res, 400, { error: "messages[] is required" }, corsOrigin);
        }

        const messages = await normalizeMessages(body.messages);
        const user = (typeof body.user === "string" && body.user) || req.headers["x-rsg-user"] || "unknown";
        const role = (typeof body.role === "string" && body.role) || req.headers["x-rsg-role"] || null;
        chatId = (typeof body.chatId === "string" && body.chatId) || req.headers["x-rsg-chat-id"] || null;
        const model = body.model || DEFAULT_MODEL;
        const startedAt = Date.now();
        log({
          type: "chat_request",
          requestId,
          chatId,
          user,
          role,
          model,
          messageCount: messages.length,
          question: truncate(lastUserText(messages), 500),
        });

        const headers = {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        };
        if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
        res.writeHead(200, headers);
        res.write(sseEncode({ type: "request_accepted", requestId, chatId }));

        // Unknown/missing role: a friendly in-chat denial, not an error.
        if (!isValidRole(role)) {
          const denial = [{ role: "assistant", content: [{ type: "text", text: PERMISSION_MESSAGE }] }];
          res.write(sseEncode({ type: "text", text: PERMISSION_MESSAGE }));
          res.write(sseEncode({ type: "done", stopReason: "permission_denied", usage: null }));
          res.write(sseEncode({ type: "turn_complete", requestId, chatId, newMessages: denial, stopReason: "permission_denied", usage: null }));
          log({ type: "chat_response", requestId, chatId, user, role, durationMs: Date.now() - startedAt, stopReason: "permission_denied" });
          return res.end();
        }

        let assistantText = "";
        const [anthropic, qbo, fulcrum, zendesk] = await Promise.all([getAnthropic(), getQbo(), getFulcrum(), getZendesk()]);
        const { newMessages, stopReason, usage } = await runAgentTurn({
          client: anthropic,
          messages,
          model,
          ctx: { qbo, fulcrum, zendesk },
          allowedTools: toolNamesForRole(role),
          onEvent: (event) => {
            if (event.type === "text") assistantText += event.text;
            else if (event.type === "tool_use") {
              log({ type: "tool_call", requestId, chatId, user, tool: event.name, input: truncate(event.input, 1000) });
            } else if (event.type === "tool_result") {
              log({ type: "tool_result", requestId, chatId, user, tool: event.name, ok: event.ok, error: event.error });
            }
            res.write(sseEncode(event));
          },
        });
        log({
          type: "chat_response",
          requestId,
          chatId,
          user,
          role,
          model,
          durationMs: Date.now() - startedAt,
          stopReason,
          usage,
          responseChars: assistantText.length,
          response: truncate(assistantText, 2000),
        });
        res.write(sseEncode({ type: "turn_complete", requestId, chatId, newMessages, stopReason, usage }));
        return res.end();
      }

      return json(res, 404, { error: "Not found" }, corsOrigin);
    } catch (err) {
      log({ type: "request_error", requestId, chatId, path: url.pathname, error: err.message });
      console.error("[rsg-ai]", err);
      if (res.headersSent) {
        res.write(sseEncode({ type: "error", error: err.message }));
        return res.end();
      }
      return json(res, err.statusCode || 500, { error: err.message }, corsOrigin);
    }
  });
}

/**
 * Periodic safety-net reconciliation: walks the Zendesk Incremental Export from
 * the stored cursor and re-indexes anything the webhook missed (e.g. while the
 * box was redeploying). Started only by the live server, not by tests. Disable
 * with ZENDESK_SYNC_ENABLED=false. Returns the interval handle (or null).
 */
export function startReconcileLoop({ minutes = Number(process.env.ZENDESK_RECONCILE_MINUTES) || 15 } = {}) {
  if (process.env.ZENDESK_SYNC_ENABLED === "false") return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const [zendesk, voyage] = await Promise.all([ZendeskClient.create(), VoyageClient.create()]);
      const r = await runReconcile({ zendesk, voyage, maxTickets: Number(process.env.ZENDESK_RECONCILE_MAX) || 500 });
      console.log(`[zendesk] reconcile: ${JSON.stringify(r)}`);
    } catch (err) {
      console.warn("[zendesk] reconcile skipped:", err.message);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, minutes * 60 * 1000);
  handle.unref?.();
  return handle;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const port = Number(process.env.PORT) || 8787;
  createServer().listen(port, () => {
    console.log(`[rsg-ai] agent API listening on :${port} (model: ${DEFAULT_MODEL})`);
    startReconcileLoop();
  });
}
