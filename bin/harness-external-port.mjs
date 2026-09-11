#!/usr/bin/env node
import { createExternalSystemPort } from "../src/eval/recording.mjs";
import { JsonlEventWriter } from "../src/eval/journal.mjs";
import { createInterface } from "node:readline";

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
if (!port) process.exit(2);
try {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const envelope = JSON.parse(line);
      const requestId = envelope.request_id;
      const request = envelope.request || envelope;
      const response = await port.execute(request);
      process.stdout.write(`${JSON.stringify({ ...(requestId ? { request_id: requestId } : {}), ok: true, response })}\n`);
    } catch (error) {
      const parsed = (() => { try { return JSON.parse(line); } catch { return {}; } })();
      const reason = error.reason || "external_port_error";
      process.stdout.write(`${JSON.stringify({ ...(parsed.request_id ? { request_id: parsed.request_id } : {}), ok: false, reason, message: error.message })}\n`);
      if (["destructive_action", "security_boundary_violation", "unauthorized_external_mutation", "workspace_escape", "forbidden_secret_access"].includes(reason)) {
        process.exitCode = 3;
        break;
      }
    }
  }
} finally {
  await eventWriter?.close();
}
