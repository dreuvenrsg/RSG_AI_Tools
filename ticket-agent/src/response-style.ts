// src/response-style.ts
// Shared tone/greeting conventions for any customer-facing draft. The agent
// writes drafts directly (guided by the system prompt), but these helpers keep
// fallbacks and any future deterministic templates consistent.

export const SIGNATURE = "Thank you,\nRSG Security Team";

export function greeting(firstName: string | null | undefined): string {
  const name = (firstName || "").trim() || "there";
  return `Hi ${name},`;
}

/** Wrap a body with the standard greeting + signature. */
export function formatDraft(firstName: string | null | undefined, body: string): string {
  return `${greeting(firstName)}\n\n${body.trim()}\n\n${SIGNATURE}`;
}
