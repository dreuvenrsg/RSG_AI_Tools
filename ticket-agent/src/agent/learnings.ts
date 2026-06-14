// src/agent/learnings.ts
// One-off ticket-handling learnings, injected into the agent's system prompt.
//
// THIS IS THE PLACE to capture specific, repeatable cases the agent keeps
// getting wrong (a particular sender's templated emails, a customer naming
// quirk, etc.). Add a concise bullet and it immediately shapes the agent's
// behavior. Kept as a TS string (not a stray .md) so it always bundles into the
// Lambda. Mirror anything broadly useful into LEARNINGS.md for humans.

export const AGENT_LEARNINGS = `# Ticket-handling learnings (one-off cases)

- **Past-due / "late PO" vendor notices are ORDER-STATUS requests, not notifications.** Templated supplier emails like "Dear Supplier, this message serves to notify you that you are late in delivery … please respond to your buyer contact with order status," often from a processing@ / no-reply-style address and listing several POs with due dates (e.g. Potter Electric Signal Company, processing@pottersignal.com), REQUIRE an order-status reply. Classify these as ORDER_TRACKING (or EXPEDITE_REQUEST if they explicitly ask to pull orders in) and look up status/tracking for the listed PO(s). Do NOT mark them no_response_expected just because they look automated.

- **Classify the CUSTOMER's request across the whole thread.** Resolved/long tickets contain RSG's own prior replies (signed by an RSG rep, e.g. "Thank you, Claudia Sandoval … rsgsecurity.com") and customer "thank you" closers. A later CUSTOMER message can change the request — e.g. after a ship-date update the customer writes "my customer doesn't want to wait, I submitted a cancel" → that is a CANCELLATION_REQUEST, not order tracking. Always read to the newest customer message.

- **New customers:** an inquiry from a company that is NOT on file in Fulcrum — especially with a "New Customer Application" / credit application attached — is NEW_CUSTOMER_INQUIRY (flag for a manager), even when the message is also a product question. Use check_customer_on_file to decide.

- **Product vs price:** if the customer is mainly asking for product descriptions, specs, or general availability, use PRODUCT_QUESTION. Reserve PRICE_CONFIRMATION for explicit "confirm my price / cost / quote" asks.

- **Tag everything that appeared (multi-label).** Threads evolve — a lead-time question can become an order with a missing PO; a product question can become a new-customer onboarding. Tag EVERY type the thread touched (primary + additionalTags), so the analytics captures the full picture, not just the final state.
`;
