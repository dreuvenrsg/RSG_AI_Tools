#!/usr/bin/env node
// Local runner for the accounting tools.
//
//   node src/cli.js list
//   node src/cli.js qbo_landed_cost_report '{"months":12}'
//   node src/cli.js qbo_cash_application_lookup '{"customer":"ACME Corp"}'
//
// Tool results print as JSON. If a result contains a `csv` field it is also
// written to artifacts/<tool>-<timestamp>.csv (override with --csv <path>).
import fs from "node:fs";
import path from "node:path";
import { QboClient } from "./qbo/client.js";
import { FulcrumClient } from "./fulcrum/client.js";
import { ZendeskSearch } from "./zendesk/search.js";
import { tools, getTool } from "./tools/index.js";

function usage() {
  console.log("Usage: node src/cli.js <tool-name|list> [json-args] [--csv <path>]");
  console.log("\nAvailable tools:");
  for (const t of tools) console.log(`  ${t.definition.name} — ${t.definition.description.split(". ")[0]}.`);
}

async function main() {
  const args = process.argv.slice(2);
  const csvFlag = args.indexOf("--csv");
  let csvPath = null;
  if (csvFlag !== -1) {
    csvPath = args[csvFlag + 1];
    args.splice(csvFlag, 2);
  }
  const [name, json] = args;

  if (!name || name === "list" || name === "--help") return usage();

  const tool = getTool(name);
  if (!tool) {
    console.error(`Unknown tool: ${name}\n`);
    return usage();
  }

  const input = json ? JSON.parse(json) : {};
  // Only stand up the clients this tool's domain needs — system tools (log
  // search, notes) shouldn't demand QBO/Fulcrum credentials to run.
  const needsQbo = name.startsWith("qbo_");
  const needsFulcrum = name.startsWith("fulcrum_");
  const needsZendesk = name.startsWith("zendesk_");
  if (needsQbo || needsFulcrum || needsZendesk)
    console.error(`[cli] Initializing ${[needsQbo && "QBO", needsFulcrum && "Fulcrum", needsZendesk && "Zendesk"].filter(Boolean).join(" + ")} client...`);
  const [qbo, fulcrum, zendesk] = await Promise.all([
    needsQbo ? QboClient.create() : null,
    needsFulcrum ? FulcrumClient.create() : null,
    needsZendesk ? ZendeskSearch.create() : null,
  ]);
  console.error(`[cli] Running ${name}...`);
  const result = await tool.run(input, { qbo, fulcrum, zendesk });

  if (result && typeof result.csv === "string") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const out = csvPath || path.join("artifacts", `${name}-${stamp}.csv`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, result.csv);
    console.error(`[cli] CSV written to ${out}`);
    delete result.csv;
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
