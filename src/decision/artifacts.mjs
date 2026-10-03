import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { parseYaml } from "../eval/yaml.mjs";
import { isWithin } from "../eval/util.mjs";
import { validateSystemTargets } from "./validation.mjs";

const SAFE_TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function artifactPath(root, ticketId) {
  if (typeof ticketId !== "string" || !SAFE_TICKET_ID.test(ticketId)) throw new TypeError("ticketId must be a safe ticket identifier");
  const path = resolve(root, join("docs", "specs", ticketId, "system-targets.yaml"));
  if (!isWithin(root, path)) throw new TypeError("system target artifact path escapes the project root");
  return path;
}

async function assertContainedNoSymlinks(root, path) {
  const rootPath = await realpath(root);
  if (!isWithin(rootPath, path)) throw new TypeError("system target artifact path escapes the project root");
  let current = dirname(path);
  while (isWithin(rootPath, current) && current !== rootPath) {
    const info = await lstat(current).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) throw new TypeError("system target artifact path cannot pass through a symlink");
    current = dirname(current);
  }
}

function validate(targets) {
  const result = validateSystemTargets(targets);
  if (!result.valid) {
    const first = result.errors[0];
    const error = new TypeError(`${first.path}: ${first.message}`);
    error.validation = result;
    throw error;
  }
}

export async function readSystemTargets({ root = process.cwd(), ticketId }) {
  const path = artifactPath(root, ticketId);
  await assertContainedNoSymlinks(root, path);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new TypeError("system target artifact must be a regular file");
  const targets = parseYaml(await readFile(path, "utf8"));
  validate(targets);
  return targets;
}

export async function writeSystemTargets(options = {}) {
  const { root = process.cwd(), ticketId, targets } = options;
  if ("path" in options) throw new TypeError("system target artifact path is not configurable");
  validate(targets);
  const path = artifactPath(root, ticketId);
  await assertContainedNoSymlinks(root, path);
  await mkdir(dirname(path), { recursive: true });
  await assertContainedNoSymlinks(root, path);
  const existing = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new TypeError("system target artifact must be a regular file");
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(targets, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { path, targets };
}
