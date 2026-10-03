#!/usr/bin/env node
import { resolve } from "node:path";

import { readClaim, readSource, writeClaim, writeSource } from "../../src/knowledge/registry.mjs";
import { evaluateSource } from "../../src/knowledge/research.mjs";
import { validateClaim, validateSource } from "../../src/knowledge/validation.mjs";

function usage() {
  return "Usage: harness-knowledge.mjs source|claim validate|evaluate|save|show [--json JSON] [--id ID] [--root PATH]";
}

function parseArgs(args) {
  const result = { positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${arg}`);
      const key = arg.slice(2).replaceAll("-", "_");
      if (!new Set(["json", "id", "root"]).has(key)) throw new TypeError(`Unsupported option: ${arg}`);
      result[key] = value;
      index += 1;
    } else result.positionals.push(arg);
  }
  return result;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [kind, action, ...rest] = options.positionals;
  if (rest.length || !["source", "claim"].includes(kind) || !["validate", "evaluate", "save", "show"].includes(action)) throw new TypeError(usage());
  if (options.root) options.root = resolve(options.root);

  if (action === "validate" || action === "evaluate") {
    if (!options.json) throw new TypeError(`${action} requires --json`);
    const object = JSON.parse(options.json);
    if (kind === "source" && action === "evaluate") return emit(evaluateSource(object));
    if (action === "evaluate") throw new TypeError("Claim evaluation is unsupported");
    const result = kind === "source" ? validateSource(object) : validateClaim(object);
    emit(result);
    if (!result.valid) process.exitCode = 1;
    return;
  }

  if (action === "save") {
    if (!options.json) throw new TypeError("save requires --json");
    const object = JSON.parse(options.json);
    if (kind === "source") return emit(await writeSource({ root: options.root, source: object }));
    const source = await readSource({ root: options.root, sourceId: object.source_id });
    return emit(await writeClaim({ root: options.root, claim: object, refs: { sourceIds: [source.id] } }));
  }

  if (!options.id) throw new TypeError("show requires --id");
  if (kind === "source") return emit(await readSource({ root: options.root, sourceId: options.id }));
  return emit(await readClaim({ root: options.root, claimId: options.id }));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
