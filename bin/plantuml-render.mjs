#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

function fail(message) {
  console.error(`plantuml-render: ${message}`);
  process.exitCode = 1;
}

function args(argv) {
  const result = { workspace: process.cwd(), jar: null, output: null, png: false, input: null, sha256: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace") result.workspace = resolve(argv[++index]);
    else if (arg === "--jar") result.jar = resolve(argv[++index]);
    else if (arg === "--output") result.output = resolve(argv[++index]);
    else if (arg === "--sha256") result.sha256 = argv[++index];
    else if (arg === "--png") result.png = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: plantuml-render.mjs [--workspace DIR] --jar FILE [--output DIR] [--sha256 HEX] [--png] INPUT.puml");
      process.exit(0);
    } else if (!result.input) result.input = resolve(arg);
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return result;
}

function within(root, path) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(".." + "/") && !isAbsolute(value));
}

function checkIncludes(input, workspace) {
  const source = readFileSync(input, "utf8");
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*!include\s+(\S+)/);
    if (!match) continue;
    const target = match[1];
    if (/^(https?:|file:|https?:\/\/)/i.test(target)) {
      throw new Error(`!include at ${input}:${index + 1} must use a local workspace path`);
    }
    const resolved = resolve(dirname(input), target);
    if (!within(workspace, resolved)) {
      throw new Error(`!include at ${input}:${index + 1} is outside workspace: ${target}`);
    }
  }
}

function verifyOutput(path) {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`renderer produced no non-empty output: ${path}`);
  }
}

try {
  const options = args(process.argv.slice(2));
  if (!options.input || !options.jar) throw new Error("input .puml and --jar are required");
  if (!existsSync(options.input)) throw new Error(`input file not found: ${options.input}`);
  if (!options.input.endsWith(".puml")) throw new Error(`input must be a .puml file: ${options.input}`);
  checkIncludes(options.input, resolve(options.workspace));
  if (!existsSync(options.jar)) throw new Error(`PlantUML JAR not found: ${options.jar}; run plantuml-bootstrap.mjs first`);
  if (options.sha256) {
    const actual = createHash("sha256").update(readFileSync(options.jar)).digest("hex");
    if (actual !== options.sha256.toLowerCase()) throw new Error(`PlantUML JAR SHA-256 mismatch: expected ${options.sha256}, got ${actual}`);
  }
  const java = spawnSync("java", ["-version"], { encoding: "utf8" });
  if (java.error || java.status !== 0) throw new Error("Java is unavailable; install Java and retry");
  const graphviz = spawnSync("dot", ["-V"], { encoding: "utf8" });
  if (graphviz.error || graphviz.status !== 0) throw new Error("Graphviz is unavailable; install Graphviz and retry");
  const outputDir = options.output || dirname(options.input);
  mkdirSync(outputDir, { recursive: true });
  for (const format of options.png ? ["svg", "png"] : ["svg"]) {
    const process = spawnSync("java", ["-jar", options.jar, `-t${format}`, "-o", outputDir, options.input], { encoding: "utf8" });
    if (process.error || process.status !== 0) {
      const detail = (process.stderr || process.stdout || "").trim();
      throw new Error(`PlantUML ${format} render failed for ${options.input}${detail ? `: ${detail}` : ""}`);
    }
    verifyOutput(resolve(outputDir, `${basename(options.input, ".puml")}.${format}`));
  }
} catch (error) {
  fail(error.message);
}
