import "./src/env.js";

import assert from "node:assert/strict";

import { handleTicketIntent } from "./src/routing.js";
import type { IntentClassification } from "./src/types.js";
import {
  closeTicketForTesting,
  createTicketCopy,
  downloadTicketAttachment,
  extractTicketContext,
  getRequesterFirstName,
  updateTicketWithResult,
} from "./src/zendesk.js";

async function main() {
  const sourceTicketId = Number(process.argv[2] || "29154");
  let copiedTicketId: number | null = null;

  try {
    copiedTicketId = await createTicketCopy(sourceTicketId, {
      subjectPrefix: "[PoProcessor Live Test]",
    });
    console.log(`Created copy ${copiedTicketId} from ${sourceTicketId}`);

    const copiedContext = await extractTicketContext(copiedTicketId);
    const forcedIntent: IntentClassification = {
      intent: "ORDER_TRACKING",
      confidence: 1,
      reasoning: "Live validation override for open order report processing.",
      keyEntities: {
        poNumbers: [],
        productSkus: [],
        urgencyLevel: "medium",
      },
    };

    const result = await handleTicketIntent(copiedContext, forcedIntent);
    await updateTicketWithResult(
      copiedTicketId,
      result,
      getRequesterFirstName(copiedContext.requester)
    );

    assert.equal(result.success, true, "handler should succeed");

    const updatedContext = await extractTicketContext(copiedTicketId);
    const generatedAttachment = updatedContext.comments
      .flatMap((comment) => comment.attachments)
      .find((attachment) => /-with-tracking\.csv$/i.test(attachment.filename));

    assert.ok(generatedAttachment, "expected generated enriched csv attachment");

    const downloaded = await downloadTicketAttachment(generatedAttachment);
    const csv = downloaded.text || "";

    assert.ok(csv.includes("Promise / Ship Date"), "missing Promise / Ship Date column");
    assert.ok(csv.includes("Tracking Number"), "missing Tracking Number column");
    assert.ok(csv.includes("690774"), "missing expected purchase order");
    assert.ok(csv.includes("889113036022"), "missing expected Fulcrum tracking number");

    console.log(
      JSON.stringify(
        {
          sourceTicketId,
          copiedTicketId,
          generatedAttachment: generatedAttachment.filename,
          reason: result.reason,
        },
        null,
        2
      )
    );
  } finally {
    if (copiedTicketId) {
      await closeTicketForTesting(
        copiedTicketId,
        "Closing PoProcessor live validation copy after test-open-order-report-live.ts."
      );
      console.log(`Closed validation copy ${copiedTicketId}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
