// src/local.ts
// Load environment variables FIRST
import "./env.js";

// Keep .js extension on handler import so Node ESM stays happy under tsx.
import { ingest, worker } from "./handler.js";

type Args = { worker: boolean; ticket: number };

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const isWorker = args.includes("--worker");
  const tIdx = Math.max(args.indexOf("--ticket"), args.indexOf("-t"));
  const ticket = tIdx !== -1 && args[tIdx + 1] ? Number(args[tIdx + 1]) : 21083;
  return { worker: isWorker, ticket };
}

function buildIngestEvent(ticketId: number) {
  return {
    headers: {
      authorization: `Bearer ${process.env.ZENDESK_WEBHOOK_TOKEN ?? "dev-token"}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ticket_id: ticketId }),
    version: "2.0",
    rawPath: "/ingest",
    requestContext: { http: { method: "POST", path: "/ingest" } },
    isBase64Encoded: false,
  };
}

function buildSqsEvent(ticketId: number) {
  return {
    Records: [
      {
        messageId: "local-msg-id",
        receiptHandle: "local-receipt",
        body: JSON.stringify({ ticket_id: ticketId, attempt: 1 }),
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: String(Date.now()),
          SenderId: "local",
          ApproximateFirstReceiveTimestamp: String(Date.now()),
        },
        messageAttributes: {},
        md5OfBody: "",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-west-1:123456789012:po-processor-queue-local",
        awsRegion: process.env.AWS_REGION || "us-west-1",
      },
    ],
  };
}

async function main() {
  const { worker: runWorker, ticket } = parseArgs();

  if (!runWorker) {
    const event = buildIngestEvent(ticket);
    const res = await ingest(event as any, {} as any, () => {});
    console.log("Ingest result:", res);
    return;
  }

  const sqsEvent = buildSqsEvent(ticket);
  const res = await worker(sqsEvent as any, {} as any);
  console.log("Worker finished. Result:", res);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
