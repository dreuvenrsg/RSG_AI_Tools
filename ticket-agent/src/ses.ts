// src/ses.ts
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { DEFAULT_RETRIES } from "./config";

const sesRegion = process.env.SES_REGION || process.env.AWS_REGION || "us-west-1";
const SES_FROM = process.env.SES_FROM;

const ses = new SESClient({ region: sesRegion });

function required(name: string, val?: string) {
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
}

async function sendOnce(to: string, subject: string, message: string) {
  required("SES_FROM", SES_FROM);
  const params = new SendEmailCommand({
    Source: SES_FROM!,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: { Text: { Data: message } }
    }
  });
  return ses.send(params);
}

/**
 * notifyFailure - send an email and THROW if sending ultimately fails.
 * Retries up to DEFAULT_RETRIES (small fixed retry, per your preference).
 */
export async function notifyFailure(opts: { to: string; subject: string; message: string }) {
  const { to, subject, message } = opts;
  if (!to) throw new Error("notifyFailure: 'to' is required");
  let lastErr: any;
  for (let i = 0; i <= DEFAULT_RETRIES; i++) {
    try {
      await sendOnce(to, subject, message);
      return;
    } catch (err) {
      lastErr = err;
      if (i < DEFAULT_RETRIES) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

/**
 * sendAlertEmail - send an alert email without throwing on failure
 * Used for non-critical notifications where we don't want to fail the entire Lambda
 */
export async function sendAlertEmail(opts: { to: string; subject: string; body: string }): Promise<void> {
  const { to, subject, body } = opts;
  try {
    await sendOnce(to, subject, body);
    console.log(`Alert email sent to ${to}: ${subject}`);
  } catch (err) {
    console.error(`Failed to send alert email to ${to}:`, err);
    // Don't throw - we don't want alert email failures to crash the Lambda
  }
}
