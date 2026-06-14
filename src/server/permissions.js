// Role-based tool access for RSG AI.
//
// The role values MIRROR RSG_Website's `lib/roles.ts` (ADMIN_ROLE_LABELS).
// This duplication is deliberate — the repos stay decoupled. If the website
// adds a role, add it here too; until then holders of the new role get the
// "speak with your manager" message rather than an error.
export const ADMIN_ROLES = [
  "super_admin",
  "customer_service",
  "quality_control",
  "finance",
  "finance_manager",
];

const ALL = ADMIN_ROLES;
const UNRESTRICTED = ["super_admin"];
const FINANCE = ["finance", "finance_manager", ...UNRESTRICTED];

// Which roles may use each tool. Tools not listed here are denied to
// everyone (fail closed) — add new tools to this map explicitly.
export const TOOL_ACCESS = {
  qbo_landed_cost_report: FINANCE,
  qbo_cash_application_lookup: FINANCE,
  fulcrum_purchasing_request: ["quality_control", ...FINANCE],
  fulcrum_sales_request: ["customer_service", ...FINANCE],
  fulcrum_api_request: FINANCE, // the unrestricted ERP explorer (read-only)
  // Zendesk ticket search: all admin roles for now (CS + finance both need it).
  // Narrow later by changing ALL to a smaller role list.
  zendesk_ticket_search: ALL,
  save_operational_note: ALL,
  // Backend log search: logs hold every user's questions and tool inputs,
  // so only super admins may read them.
  rsg_ai_log_search: UNRESTRICTED,
};

export function isValidRole(role) {
  return typeof role === "string" && ADMIN_ROLES.includes(role);
}

/** Tool names this role may use. */
export function toolNamesForRole(role) {
  if (!isValidRole(role)) return [];
  return Object.entries(TOOL_ACCESS)
    .filter(([, roles]) => roles.includes(role))
    .map(([name]) => name);
}

export const PERMISSION_MESSAGE =
  "I can't run any tools for your account because your RSG AI permissions aren't set up " +
  "(your role is missing or not recognized). Please speak with your manager about getting the " +
  "right access group assigned, then try again.";
