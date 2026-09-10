#!/usr/bin/env node
import { createExternalSystemPort } from "../src/eval/recording.mjs";
import { JsonlEventWriter } from "../src/eval/journal.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const mode = option("--mode") || process.env.HARNESS_EVAL_EXTERNAL_PORT_MODE || "none";
const fixture = option("--fixture") || process.env.HARNESS_EVAL_EXTERNAL_RECORDING || null;
const runtimePath = option("--runtime") || process.env.HARNESS_EVAL_EXTERNAL_RUNTIME || null;
const eventsPath = option("--events") || process.env.HARNESS_EVAL_EXTERNAL_EVENTS || null;
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
const eventWriter = process.exitCode === 2 || !eventsPath
  ? null
  : await new JsonlEventWriter(eventsPath, { streamId: `external-${process.env.HARNESS_EVAL_CASE_ID || "unknown"}` }).init();
const port = process.exitCode === 2
  ? null
  : await createExternalSystemPort({
    mode,
    fixture,
    runtimePath,
    integration,
    integrationResource,
    onEvent: async (event) => eventWriter?.append(event.type, event.payload || {}, { critical: true }),
  }).init();
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
if (!port) process.exit(2);
try {
  for (const line of input.split(/\r?\n/).filter(Boolean)) {
    try {
      const response = await port.execute(JSON.parse(line));
      process.stdout.write(`${JSON.stringify({ ok: true, response })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, reason: error.reason || "external_port_error", message: error.message })}\n`);
    }
  }
} finally {
  await eventWriter?.close();
}
