// src/customer-lookup.ts
// Lightweight "is this an existing customer?" check against the Fulcrum catalog
// snapshot, used to tell a NEW customer from an existing one. Heuristic
// (company-name tokens + email-domain core) — good enough to flag new-customer
// inquiries; not an identity gate (see authorization.ts for that).

import { fetchFulcrumData } from "./s3";
import { registrableDomain } from "./authorization";

// Generic words that don't distinguish one company from another.
const STOP = new Set([
  "the", "inc", "llc", "co", "corp", "corporation", "company", "companies",
  "systems", "system", "security", "fire", "electric", "signal", "global",
  "distribution", "group", "services", "service", "solutions", "international",
  "industries", "industrial", "ltd", "limited", "enterprises", "associates",
  "products", "supply", "controls", "control", "alarm", "alarms", "technologies",
]);

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function distinctiveTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
}

export interface CustomerOnFileResult {
  onFile: boolean;
  match?: string;
  matchedId?: string;
  candidates: string[];
  reason: string;
}

export async function findCustomerOnFile(query: {
  companyName?: string;
  email?: string;
}): Promise<CustomerOnFileResult> {
  const catalog = await fetchFulcrumData();
  const byName = catalog.Customers?.customersByName || {};
  const names = Object.keys(byName);

  const domain = query.email ? registrableDomain(query.email.split("@")[1]) : null;
  const domainCore = domain ? norm(domain.replace(/\.[a-z.]+$/, "")) : null; // "lindleysystems.com" → "lindleysystems"

  // 1) Email-domain core as a substring of a normalized customer name.
  if (domainCore && domainCore.length >= 5) {
    for (const name of names) {
      const n = norm(name);
      if (n.includes(domainCore) || domainCore.includes(n)) {
        return {
          onFile: true,
          match: name,
          matchedId: byName[name].id,
          candidates: [name],
          reason: `Email domain (${domain}) matches existing customer "${name}".`,
        };
      }
    }
  }

  // 2) Distinctive company-name token shared with a customer name.
  const qTokens = new Set(query.companyName ? distinctiveTokens(query.companyName) : []);
  const candidates: string[] = [];
  if (qTokens.size > 0) {
    for (const name of names) {
      const nTokens = new Set(distinctiveTokens(name));
      if ([...qTokens].some((t) => nTokens.has(t))) candidates.push(name);
    }
  }
  if (candidates.length === 1) {
    return {
      onFile: true,
      match: candidates[0],
      matchedId: byName[candidates[0]].id,
      candidates,
      reason: `Company name matches existing customer "${candidates[0]}".`,
    };
  }
  if (candidates.length > 1) {
    return {
      onFile: true,
      match: candidates[0],
      candidates: candidates.slice(0, 5),
      reason: `Multiple possible existing-customer matches by company name.`,
    };
  }

  return {
    onFile: false,
    candidates: [],
    reason: `No existing customer matches company "${query.companyName || "(unknown)"}" or domain "${domain || "(none)"}".`,
  };
}
