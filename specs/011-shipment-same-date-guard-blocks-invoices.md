# 011 — Same-date shipment guard permanently blocks valid invoices

**Status:** planned (needs immediate operational resolution + code follow-up)

## Problem / Goal

The QBO send stage validates shipping via `chooseShipment()` in
`V2_emailSender.js`. Before any matching runs, a guard (~line 1503-1533)
compares the **two highest-numbered shipments** on the order and **throws**
if both share a `shippedDate`:

```
[Fulcrum] Multiple shipments with same date detected.
Shipments <name1> and <name2> both shipped on <date>.
```

When this fires, the invoice is skipped and reported in the summary email.
Two problems make this worse than a one-off skip:

1. **It is deterministic and self-perpetuating.** The guard runs *before* the
   smarter selection logic (linked-shipment preference + line-item Jaccard
   scoring + date proximity, lines 1534-1592). So an order whose two newest
   shipments shipped the same day throws on **every run, forever** — it never
   self-resolves and the line items are never even examined.

2. **It is currently blocking a real, chronically stuck order.** Confirmed in
   production CloudWatch (`/aws/lambda/RSGInvoiceProcessor`):
   sales order **SO9400** (`SHP-SO9400-9` / `SHP-SO9400-8`, both shipped
   `2026-05-22`) has tripped the guard repeatedly for ~3 weeks — first as
   invoice **F9983** (2026-05-23, 05-24, 05-25), then as **F10268**
   (multiple runs on 2026-06-11 and ongoing). Same order, shipments, and
   date; only the QBO invoice number changed.

Separately confirmed: the `"line items list endpoint not available"` warning
has **zero** occurrences in the last 12 days, so the fuzzy-match path is not
being knocked out by a dead endpoint. (Note: logs can't prove the endpoint
*returns data* vs. an empty `[]` — the code logs no overlap score.)

## Immediate action (operational)

- [ ] Manually reconcile **SO9400 / invoice F10268** in Fulcrum + QBO:
      confirm which of `SHP-SO9400-9` / `-8` corresponds to the invoice, then
      issue/send it manually so it stops failing on every nightly run.
- [ ] Confirm F9879 (SO8785, 2026-05-18) and any other guard-tripped invoices
      from the summary emails were resolved.

## Approach (code follow-up)

- [ ] **Reorder the guard.** Run the linked-shipment + line-item scoring
      first; only fall back to the same-date error when scoring genuinely
      can't disambiguate the two same-date shipments. This lets orders like
      SO9400 auto-resolve when the line items distinguish the shipments.
- [ ] **Add an overlap-score log line** to `chooseShipment()` so we can see in
      CloudWatch whether line-item matching actually returns data (closes the
      open question that the absence of the warning can't answer).
- [ ] Consider an overlap-confidence floor before auto-sending, so a 0%-match
      fallback to "most recent" doesn't silently send against the wrong
      shipment. Keep the same-date error as the last-resort path so nothing
      becomes *less* safe.

## Verification

- [ ] `npm test` green (extend `tests/invoiceSender.test.js` to cover the
      reordered selection + same-date fallback).
- [ ] Live run / next scheduled run no longer skips SO9400; CloudWatch shows
      the overlap score for selected shipments.

## Follow-ups

- [ ] If same-day multi-shipment is common, evaluate matching on shipment line
      items vs. invoice line items as the primary disambiguator rather than a
      tiebreak.
