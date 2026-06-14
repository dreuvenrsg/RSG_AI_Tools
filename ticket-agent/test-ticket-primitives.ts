import "./src/env.js";

import assert from "node:assert/strict";

import { parseOpenOrderReportAttachment } from "./src/open-order-report.js";
import { downloadTicketAttachment, extractTicketContext } from "./src/zendesk.js";

async function main() {
  const ticketId = Number(process.argv[2] || "29154");
  assert.ok(ticketId, "ticketId is required");

  const context = await extractTicketContext(ticketId);
  assert.equal(context.ticketId, ticketId, "ticket id mismatch");
  assert.ok(context.subject.toLowerCase().includes("open po report"), "unexpected ticket subject");

  const attachments = context.comments.flatMap((comment) => comment.attachments);
  assert.ok(attachments.length > 0, "ticket should have attachments");

  const csvAttachment = attachments.find((attachment) => /\.csv$/i.test(attachment.filename));
  assert.ok(csvAttachment, "expected a csv attachment");

  const downloaded = await downloadTicketAttachment(csvAttachment);
  assert.ok(downloaded.text, "csv attachment should download as text");
  assert.ok(downloaded.text.includes("Purchase Order Number"), "missing CSV header");
  assert.ok(downloaded.text.includes("695455"), "missing expected purchase order row");

  const report = await parseOpenOrderReportAttachment(csvAttachment);
  assert.ok(report.rows.length > 0, "expected parsed report rows");
  assert.equal(report.rows[0].purchaseOrderNumber, "690774");

  console.log(
    JSON.stringify(
      {
        ticketId,
        subject: context.subject,
        attachmentCount: attachments.length,
        csvAttachment: csvAttachment.filename,
        parsedRows: report.rows.length,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
