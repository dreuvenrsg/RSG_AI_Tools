# 014 — Tracking-optional shipping for customer-pickup ("Will Call") orders

**Status:** shipped (2026-06-18)

## Problem / Goal

The QBO send stage requires a carrier tracking number for every invoice.
`externalDataModule.fetchExternalDataForInvoice()` in `V2_emailSender.js`
**throws** when the chosen Fulcrum shipment has no `trackingNumber`:

```
[Fulcrum] Could not determine a trackingNumber: QBO Invoice Id: ... /QBO Invoice: F10432 ...
```

Some orders legitimately have **no carrier tracking number** — customer-pickup
/ "Will Call" shipments, where the customer (or their freight forwarder)
collects the goods. Confirmed in production on 2026-06-18: QBO invoice
**F10432** maps to Fulcrum **SO8758** (HLI Solutions, Inc.), whose four shipped
shipments (`SHP-SO8758-1..4`) are **all** shipping method **"Will Call"** with
`trackingNumber: null`. Like the same-date guard (spec 011), this is
deterministic and self-perpetuating: the invoice fails on **every** run forever
because a tracking number will never appear.

Goal: let these invoices send by recording a placeholder, without weakening the
tracking requirement for normal carrier shipments.

## Approach

- When the chosen shipment has no carrier tracking number, fall back to
  recording the **shipping-method name itself** (e.g. `"Will Call"`) in QBO's
  `TrackingNum` field. This also satisfies the second tracking guard at the QBO
  update step and feeds the `CustomerMemo` "Ship Method" line.
- Make it an **explicit (customer, shipping-method) allowlist**, not a blanket
  "skip tracking when Will Call" rule, so we only relax the requirement for
  pairs we've confirmed are genuine pickups. Initial entry: HLI Solutions +
  "Will Call".
- Keep it **modular and config-driven** so adding a future customer/method is a
  one-line edit, not a code change: `TRACKING_OPTIONAL_RULES` +
  `trackingPlaceholderForOrder()` + `resolveTrackingNumber()` in
  `V2_emailSender.js`, all pure and exported for tests.

## Tasks

- [x] Add `TRACKING_OPTIONAL_RULES` config + pure `trackingPlaceholderForOrder()`
      and `resolveTrackingNumber()` helpers (exported).
- [x] Wire `resolveTrackingNumber()` into `fetchExternalDataForInvoice()`,
      computing ship-method name before the tracking check.
- [x] Unit tests in `tests/invoiceSender.test.js` (carrier tracking preferred,
      array fallback, HLI Will Call placeholder, casing preserved, NOT applied
      to other customers or non-pickup methods, null when method missing).
- [x] Document the rule in `CLAUDE.md`.

## Verification

- `npm test` — 99 passing (7 new tracking tests).
- Live Fulcrum read (`fulcrum_api_request` on SO8758) confirmed all four
  shipments are "Will Call" with `trackingNumber: null`, i.e. the rule fires for
  the real stuck invoice F10432.

## Follow-ups

- [ ] Re-run / confirm F10432 sends on the next scheduled run (or a manual
      invoke) now that the placeholder is recorded.
- [ ] If other customers report the same block, add their (customer, method)
      pair to `TRACKING_OPTIONAL_RULES` — consider generalizing "Will Call" to a
      shared pickup-method set if the list grows.
- [ ] Related over-strict send guard: same-date shipment guard (spec 011).
