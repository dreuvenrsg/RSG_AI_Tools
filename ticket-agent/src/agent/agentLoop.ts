// src/agent/agentLoop.ts
// A manual Claude tool-use loop for the customer-service agent.
// Ported/adapted from RSG_AI_Tools (src/server/agentLoop.js), TypeScript +
// non-streaming, with a terminal `finalize_ticket` tool that returns the
// structured ProcessingResult-equivalent.

import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../config";
import type { AgentContext, AgentEvent, AgentTool, AgentTurnResult } from "./types";

export const DEFAULT_AGENT_MODEL = MODELS.agent;
export const MAX_AGENT_ITERATIONS = 12;
const MAX_RESULT_CHARS = 30000;

export const ANTHROPIC_KEY_PARAM = process.env.ANTHROPIC_KEY_PARAM || "/rsg-ai/prod/anthropic-api-key";

/**
 * Resolve an Anthropic client. Prefers an env key (ANTHROPIC_API_KEY /
 * ANTHROPIC_TOKEN); falls back to SSM (repo convention for secrets), matching
 * RSG_AI_Tools so prod/Lambda works via IAM role without a local key.
 */
export async function resolveAnthropicClient(): Promise<Anthropic> {
  const envKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_TOKEN;
  if (envKey) return new Anthropic({ apiKey: envKey });
  try {
    const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region: process.env.AWS_REGION || "us-west-1" });
    const res = await ssm.send(new GetParameterCommand({ Name: ANTHROPIC_KEY_PARAM, WithDecryption: true }));
    const key = res.Parameter?.Value;
    if (!key) throw new Error("empty SSM value");
    return new Anthropic({ apiKey: key });
  } catch (err: any) {
    throw new Error(
      `No Anthropic API key: set ANTHROPIC_TOKEN/ANTHROPIC_API_KEY or store one in SSM at ${ANTHROPIC_KEY_PARAM} (${err.message})`
    );
  }
}

/** Cap a tool result's serialized size before it enters the model context. */
function summarizeForModel(result: any): string {
  const json = typeof result === "string" ? result : JSON.stringify(result);
  if (json.length <= MAX_RESULT_CHARS) return json;
  return json.slice(0, MAX_RESULT_CHARS) + ' …"<truncated>"';
}

export interface RunAgentArgs {
  client: Anthropic;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: AgentTool[];
  ctx: AgentContext;
  onEvent?: (e: AgentEvent) => void;
  model?: string;
  maxIterations?: number;
}

/**
 * Run one agent turn to completion. The agent is expected to end by calling the
 * `finalize_ticket` tool; its input is captured into ctx.finalize and returned.
 */
export async function runAgentTurn({
  client,
  system,
  messages,
  tools,
  ctx,
  onEvent = () => {},
  model = DEFAULT_AGENT_MODEL,
  maxIterations = MAX_AGENT_ITERATIONS,
}: RunAgentArgs): Promise<AgentTurnResult> {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const definitions = tools.map((t) => t.definition) as unknown as Anthropic.Tool[];
  const convo: Anthropic.MessageParam[] = [...messages];
  const toolCalls: AgentTurnResult["toolCalls"] = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Newer model params (adaptive thinking) are passed through; cast to any so
    // the older SDK type defs don't reject them.
    const params: any = {
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system,
      tools: definitions,
      messages: convo,
    };

    const message = await client.messages.create(params);

    for (const block of message.content) {
      if (block.type === "text" && block.text) onEvent({ type: "text", text: block.text });
    }
    convo.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "pause_turn") continue;

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
      onEvent({ type: "done", stopReason: message.stop_reason });
      return { finalize: ctx.finalize ?? null, stopReason: message.stop_reason, toolCalls, iterations: iteration + 1 };
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      onEvent({ type: "tool_use", name: tu.name, input: tu.input });
      const tool = byName.get(tu.name);
      try {
        if (!tool) throw new Error(`Unknown tool: ${tu.name}`);
        const result = await tool.run(tu.input || {}, ctx);
        onEvent({ type: "tool_result", name: tu.name, ok: true });
        toolCalls.push({ name: tu.name, input: tu.input, ok: true });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: summarizeForModel(result),
        });
      } catch (err: any) {
        onEvent({ type: "tool_result", name: tu.name, ok: false, error: err.message });
        toolCalls.push({ name: tu.name, input: tu.input, ok: false, error: err.message });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Tool failed: ${err.message}`,
          is_error: true,
        });
      }
    }
    convo.push({ role: "user", content: results });

    // Terminal: the agent finalized — stop the loop.
    if (ctx.finalize) {
      onEvent({ type: "done", stopReason: "finalized" });
      return { finalize: ctx.finalize, stopReason: "finalized", toolCalls, iterations: iteration + 1 };
    }
  }

  onEvent({ type: "error", error: `Agent exceeded ${maxIterations} iterations` });
  return { finalize: ctx.finalize ?? null, stopReason: "max_iterations", toolCalls, iterations: maxIterations };
}
