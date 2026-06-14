// Zendesk webhook signature verification (pure).
//
// Zendesk signs each webhook delivery with HMAC-SHA256 over
// `timestamp + raw_request_body`, keyed by the webhook's signing secret, and
// sends the result base64-encoded in the X-Zendesk-Webhook-Signature header
// (the timestamp rides in X-Zendesk-Webhook-Signature-Timestamp). We recompute
// it and compare in constant time. This is how the /api/zendesk/webhook route
// authenticates Zendesk instead of the bearer key.
import crypto from "node:crypto";

export const SIGNATURE_HEADER = "x-zendesk-webhook-signature";
export const TIMESTAMP_HEADER = "x-zendesk-webhook-signature-timestamp";

/** Recompute the expected signature for a delivery. */
export function computeSignature({ timestamp, body, secret }) {
  return crypto
    .createHmac("sha256", String(secret))
    .update(String(timestamp) + String(body))
    .digest("base64");
}

/**
 * @param {{ signature?: string, timestamp?: string, body?: string, secret?: string }} args
 * @returns {boolean} true only when the signature is present and valid
 */
export function verifyZendeskSignature({ signature, timestamp, body, secret }) {
  if (!signature || !timestamp || !secret) return false;
  const expected = computeSignature({ timestamp, body, secret });
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  // timingSafeEqual throws on length mismatch — guard first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
