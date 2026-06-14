// src/authorization.ts
// Generalized requester-authorization gate.
//
// Any ticket that touches a SPECIFIC customer's data (a PO, an order's tracking,
// a cancellation, tier pricing) must first resolve whether the person who
// emailed us is actually associated with that customer. We never disclose a
// customer's order/pricing data to an unverified requester.
//
// Resolution sources, in priority order:
//   1. Confirmation against a KNOWN order/customer the request is about
//      (e.g. the sales order we just looked up exposes the customer's contact
//      email/domain). This is the strongest signal and needs no extra config.
//   2. The DynamoDB customer-pricing-domains table (RSG_Website
//      FulcrumCustomerPricingSync), when CUSTOMER_PRICING_DOMAINS_TABLE is set.
//   3. Otherwise: unknown → escalate, disclose nothing.
//
// This module has NO hard dependency on DynamoDB — the client is imported lazily
// only when a table is configured.

import { AUTH_CONFIG } from "./config";

export type AuthLevel = "authorized" | "domain_match" | "unknown";

export interface AuthorizationResult {
  level: AuthLevel;
  email: string;
  domain: string | null;
  customerId?: string;
  customerName?: string;
  tierId?: string | null;
  tierName?: string | null;
  matchedContact?: { name?: string; email?: string } | null;
  /** Human-readable explanation, surfaced in internal notes. */
  reason: string;
}

export interface ResolveOptions {
  /**
   * Emails/contacts known to belong to the customer this request is about
   * (e.g. the order's billing email + customer contacts). A domain match here
   * yields `authorized` because it ties the requester to the specific order.
   */
  knownCustomerEmails?: (string | null | undefined)[];
  knownCustomerId?: string;
  knownCustomerName?: string;
  knownTierId?: string | null;
}

// Common free/consumer email providers — these never establish company identity
// on their own (anyone can have one), so a domain-table match is not attempted.
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com",
  "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com",
  "proton.me", "protonmail.com", "comcast.net", "verizon.net", "att.net",
]);

// Multi-level public suffixes we want to keep two labels of (best-effort; the
// RSG_Website pipeline uses the full PSL — this is a lightweight approximation).
const TWO_LEVEL_TLDS = new Set([
  "co.uk", "com.au", "com.mx", "co.jp", "com.br", "co.nz", "com.cn",
]);

export function extractDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at < 0) return null;
  const host = email.slice(at + 1).trim().toLowerCase();
  return host || null;
}

/** Reduce a hostname to its registrable domain (best-effort, no PSL dependency). */
export function registrableDomain(host: string | null | undefined): string | null {
  if (!host) return null;
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_LEVEL_TLDS.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

export function isFreeEmailDomain(domain: string | null | undefined): boolean {
  const d = registrableDomain(domain);
  return d ? FREE_EMAIL_DOMAINS.has(d) : false;
}

/** True if two emails/hosts share the same registrable domain. */
export function domainsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = registrableDomain(extractDomain(a) || a || undefined);
  const db = registrableDomain(extractDomain(b) || b || undefined);
  return !!da && !!db && da === db;
}

/**
 * Resolve a requester's authorization. Pure/async, performs no Zendesk writes.
 */
export async function resolveRequesterAuthorization(
  email: string,
  opts: ResolveOptions = {}
): Promise<AuthorizationResult> {
  const domain = extractDomain(email);
  const base: AuthorizationResult = {
    level: "unknown",
    email,
    domain,
    matchedContact: null,
    reason: "No verification source matched.",
  };

  if (!domain) {
    return { ...base, reason: "Requester email is missing or malformed." };
  }

  // 1) Strongest signal: the requester's domain matches a contact on the very
  //    order/customer the request is about.
  const known = (opts.knownCustomerEmails || []).filter(Boolean) as string[];
  const contactMatch = known.find((c) => domainsMatch(email, c));
  if (contactMatch) {
    return {
      level: "authorized",
      email,
      domain,
      customerId: opts.knownCustomerId,
      customerName: opts.knownCustomerName,
      tierId: opts.knownTierId ?? null,
      matchedContact: { email: contactMatch },
      reason: `Requester domain matches the customer's contact on this order (${contactMatch}).`,
    };
  }

  // A free-email requester with no order-contact match cannot be tied to a
  // company by domain — leave unknown.
  if (isFreeEmailDomain(domain)) {
    return {
      ...base,
      reason: `Requester uses a consumer email domain (${domain}); cannot tie to a customer without an exact order-contact match.`,
    };
  }

  // 2) DynamoDB domains table (purpose-built domain→customer+tier map).
  if (AUTH_CONFIG.domainsTable) {
    const viaTable = await lookupDomainInDynamo(registrableDomain(domain)!).catch((err) => {
      console.error(`[authorization] DynamoDB lookup failed: ${err.message}`);
      return null;
    });
    if (viaTable) {
      return {
        level: "domain_match",
        email,
        domain,
        customerId: viaTable.customerId,
        tierId: viaTable.tierId ?? null,
        matchedContact: null,
        reason: `Requester domain ${registrableDomain(domain)} is a known customer domain on file.`,
      };
    }
  }

  // 3) No source available / no match.
  return {
    ...base,
    reason: AUTH_CONFIG.domainsTable
      ? `Requester domain ${registrableDomain(domain)} did not match any customer on file.`
      : `Requester domain ${registrableDomain(domain)} could not be verified (no domains table configured and no order-contact match).`,
  };
}

interface DomainRecord {
  customerId?: string;
  tierId?: string | null;
}

// Lazy DynamoDB lookup — only loads the AWS SDK when a table is configured.
async function lookupDomainInDynamo(domain: string): Promise<DomainRecord | null> {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: AUTH_CONFIG.dynamoRegion })
  );
  const res = await client.send(
    new GetCommand({
      TableName: AUTH_CONFIG.domainsTable,
      Key: { PK: `DOMAIN#${domain}` },
    })
  );
  if (!res.Item) return null;
  return {
    customerId: res.Item.company_id,
    tierId: res.Item.tier_id ?? null,
  };
}
