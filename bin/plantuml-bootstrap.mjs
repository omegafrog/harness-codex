#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { mkdir, rename, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import https from "node:https";

export const PLANTUML_VERSION = "1.2024.7";
export const PLANTUML_URL = `https://github.com/plantuml/plantuml/releases/download/v${PLANTUML_VERSION}/plantuml-${PLANTUML_VERSION}.jar`;
// Override with --sha256 when mirroring the pinned artifact internally.
export const PLANTUML_SHA256 = "e34c12bbe9944f1f338ca3d88c9b116b86300cc8e90b35c4086b825b5ae96d24";
const DEFAULT_SHA256 = PLANTUML_SHA256;

function download(url, target) {
  return new Promise((resolvePromise, reject) => {
    https.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) return download(response.headers.location, target).then(resolvePromise, reject);
      if (response.statusCode !== 200) return reject(new Error(`download failed with HTTP ${response.statusCode}`));
      pipeline(response, createWriteStream(target)).then(resolvePromise, reject);
    }).on("error", reject);
  });
}

function parse(argv) {
  const result = { cache: resolve(".harness/cache/plantuml"), url: PLANTUML_URL, sha256: DEFAULT_SHA256 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--cache") result.cache = resolve(argv[++i]);
    else if (argv[i] === "--url") result.url = argv[++i];
    else if (argv[i] === "--sha256") result.sha256 = argv[++i].toLowerCase();
    else if (argv[i] === "--help") { console.log("Usage: plantuml-bootstrap.mjs [--cache DIR] [--url URL] --sha256 HEX"); process.exit(0); }
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  return result;
}

try {
  const options = parse(process.argv.slice(2));
  if (!/^[a-f0-9]{64}$/.test(options.sha256)) throw new Error("a pinned 64-character --sha256 is required");
  await mkdir(options.cache, { recursive: true });
  const jar = resolve(options.cache, `plantuml-${PLANTUML_VERSION}.jar`);
  const temporary = `${jar}.part`;
  await download(options.url, temporary);
  const actual = createHash("sha256").update(await readFile(temporary)).digest("hex");
  if (actual !== options.sha256) throw new Error(`SHA-256 mismatch: expected ${options.sha256}, got ${actual}`);
  await rename(temporary, jar);
  console.log(`PlantUML ${PLANTUML_VERSION} ready: ${jar}`);
} catch (error) {
  console.error(`plantuml-bootstrap: ${error.message}`);
  process.exitCode = 1;
}
