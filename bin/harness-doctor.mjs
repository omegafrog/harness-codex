#!/usr/bin/env node

import { runDoctor } from "../src/doctor/index.mjs";

function usage() {
  return `Usage: harness-codex-doctor [options]

Options:
  --project <path>  Project to inspect (default: current directory)
  --json            Print the structured diagnostic report as JSON
  -h, --help        Show this help
`;
}

function parseArgs(argv) {
  const options = { project: process.cwd(), json: false };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--project") {
      const value = args.shift();
      if (!value) throw new Error("--project requires a path");
      options.project = value;
    } else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const report = await runDoctor({ root: options.project });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Harness doctor: ${report.passed ? "PASS" : "FAIL"}`);
      console.log(`Errors: ${report.summary.errors}, warnings: ${report.summary.warnings}, info: ${report.summary.info}`);
      for (const item of report.diagnostics) console.log(`${item.severity.toUpperCase()} ${item.code}: ${item.message} (${item.path})`);
    }
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(`Doctor failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
