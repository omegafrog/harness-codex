#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installed = new URL("../../.harness/src/doctor/index.mjs", import.meta.url);
const installedRuntime = existsSync(installed);

function usage() {
  return `Usage: harness-codex-doctor [options]

Options:
  --project <path>  Project to inspect (default: current directory)
  --native-profile <name>  Native Codex permission profile available to verify (repeatable)
  --json            Print the structured diagnostic report as JSON
  -h, --help        Show this help
`;
}

function parseArgs(argv) {
  const options = { project: process.cwd(), json: false, nativeProfiles: [] };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--project") {
      const value = args.shift();
      if (!value) throw new Error("--project requires a path");
      options.project = value;
    } else if (arg === "--native-profile") {
      const value = args.shift();
      if (!value) throw new Error("--native-profile requires a name");
      options.nativeProfiles.push(value);
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
    let runDoctor;
    try {
      ({ runDoctor } = await import(installedRuntime ? installed.href : new URL("../.harness/src/doctor/index.mjs", import.meta.url).href));
    } catch (error) {
      const message = `Doctor runtime could not be loaded: ${error.message}`;
      const report = { schema_version: 1, root: resolve(options.project), passed: false, summary: { errors: 1, warnings: 0, info: 0 }, diagnostics: [{ code: 'doctor_runtime_unavailable', severity: 'error', message, path: fileURLToPath(installed) }] };
      console.log(options.json ? JSON.stringify(report, null, 2) : `Harness doctor: FAIL\nERROR doctor_runtime_unavailable: ${message}`);
      process.exitCode = 1;
      return;
    }
    const report = await runDoctor({ root: options.project, sourceRoot: installedRuntime ? null : packageRoot, nativePermissionProfiles: options.nativeProfiles.length > 0 ? options.nativeProfiles : null });
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
