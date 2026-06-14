# Open Order Report Processing

## Purpose

Handle Zendesk tickets that attach a CSV open order report and ask RSG to return promise dates and tracking details.

## Canonical example

- Zendesk ticket `29154`
- Subject: `Open PO report`
- Attachment shape: CSV with headers including `Purchase Order Number`, `Item Number`, `Quantity Open`, `Request Date`, and `Promised Delivery`

## Required behavior

1. Detect the CSV attachment from the ticket context.
2. Download the attachment from Zendesk and parse it deterministically.
3. Resolve each report purchase-order number against Fulcrum, including base-number matches where Fulcrum stores suffixes such as `OP 00100 000`.
4. Gather shipment data and line-item mappings from Fulcrum.
5. Generate an updated CSV that preserves the original report and adds or overwrites:
   - `Promise / Ship Date`
   - `Tracking Number`
6. Attach the updated CSV back to Zendesk in a private comment.
7. Leave a draft public response for an agent to review and send.

## Verification contract

Use the following layered checks:

1. Primitive check: `test-ticket-primitives.ts`
   - reads the live ticket,
   - downloads the attachment,
   - verifies the expected CSV headers and parsed rows.
2. Live integration check: `test-open-order-report-live.ts`
   - clones the source ticket,
   - runs the live handler against the copy,
   - verifies the generated attachment and key Fulcrum-derived values,
   - closes the copied ticket in `finally`.

## Safety rules

- Never run destructive validation against the original customer ticket.
- Validation copies must be visibly labeled and must be closed after the run, including failure paths.
- Review key elements instead of exact prose. Generated customer text may vary, but the attachment and tracking-bearing fields must be present and correct.
