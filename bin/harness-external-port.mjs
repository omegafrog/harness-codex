#!/usr/bin/env node
import { ExternalSystemPort } from "../src/eval/recording.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const mode = option("--mode") || process.env.HARNESS_EVAL_EXTERNAL_PORT_MODE || "none";
const fixture = option("--fixture") || process.env.HARNESS_EVAL_EXTERNAL_RECORDING || null;
const integration = process.env.HARNESS_EVAL_INTEGRATION === "true";
const resourceText = process.env.HARNESS_EVAL_INTEGRATION_RESOURCE || "";
let integrationResource = null;
if (resourceText) {
  try {
    integrationResource = JSON.parse(resourceText);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, reason: "invalid_integration_resource", message: error.message })}\n`);
    process.exitCode = 2;
  }
}
const port = process.exitCode === 2
  ? null
  : await new ExternalSystemPort({ mode, fixture, integration, integrationResource }).init();
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
if (!port) process.exit(2);
for (const line of input.split(/\r?\n/).filter(Boolean)) {
  try {
    const response = await port.execute(JSON.parse(line));
    process.stdout.write(`${JSON.stringify({ ok: true, response })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: error.reason || "external_port_error", message: error.message })}\n`);
  }
}
