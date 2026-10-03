import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isWithin } from "../eval/util.mjs";
import { parseYaml } from "../eval/yaml.mjs";
import { validateClaim, validateSource } from "./validation.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function registryPath(root, kind, id) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) throw new TypeError(`${kind} ID must be a safe identifier.`);
  const path = resolve(root, "knowledge", kind === "Source" ? "sources" : "claims", `${id}.yaml`);
  if (!isWithin(root, path)) throw new TypeError(`${kind} registry path escapes the project root`);
  return path;
}

async function assertContainedNoSymlinks(root, path, label) {
  const rootPath = await realpath(root);
  if (!isWithin(rootPath, path)) throw new TypeError(`${label} registry path escapes the project root`);
  let current = dirname(path);
  while (isWithin(rootPath, current) && current !== rootPath) {
    const info = await lstat(current).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) throw new TypeError(`${label} registry path cannot pass through a symlink`);
    current = dirname(current);
  }
}

function validateObject(value, validateFn, label) {
  const result = validateFn(value);
  if (!result.valid) {
    const first = result.errors[0];
    const error = new TypeError(`${first.code}: ${first.path}: ${first.message}`);
    error.validation = result;
    throw error;
  }
  return label === "Source" ? value.id : value.id;
}

function validateIdentity(value, id, label) {
  if (value?.id !== id) {
    const error = new TypeError(`${label} file ${id}.yaml contains a different object ID.`);
    error.code = `${label.toLowerCase()}_id_mismatch`;
    throw error;
  }
}

async function readObject({ root, kind, id, validateFn, refs = {} }) {
  const path = registryPath(root, kind, id);
  await assertContainedNoSymlinks(root, path, kind);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new TypeError(`${kind} registry entry must be a regular file`);
  const value = parseYaml(await readFile(path, "utf8"));
  validateIdentity(value, id, kind);
  validateObject(value, (object) => validateFn(object, refs), kind);
  return value;
}

async function writeObject({ root, kind, value, validateFn, refs = {} }) {
  validateObject(value, (object) => validateFn(object, refs), kind);
  const path = registryPath(root, kind, value.id);
  await assertContainedNoSymlinks(root, path, kind);
  await mkdir(dirname(path), { recursive: true });
  await assertContainedNoSymlinks(root, path, kind);
  const existing = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new TypeError(`${kind} registry entry must be a regular file`);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { path, [kind.toLowerCase()]: value };
}

export function readSource({ root = process.cwd(), sourceId }) {
  return readObject({ root, kind: "Source", id: sourceId, validateFn: validateSource });
}

export function writeSource({ root = process.cwd(), source }) {
  return writeObject({ root, kind: "Source", value: source, validateFn: validateSource });
}

export async function readClaim({ root = process.cwd(), claimId, refs = {} }) {
  const claim = await readObject({ root, kind: "Claim", id: claimId, validateFn: validateClaim, refs });
  if (refs.sourceIds === undefined) {
    const source = await readSource({ root, sourceId: claim.source_id });
    validateObject(claim, (value) => validateClaim(value, { sourceIds: [source.id] }), "Claim");
  }
  return claim;
}

export async function writeClaim({ root = process.cwd(), claim, refs = {} }) {
  if (refs.sourceIds === undefined) {
    const source = await readSource({ root, sourceId: claim?.source_id });
    refs = { ...refs, sourceIds: [source.id] };
  }
  return writeObject({ root, kind: "Claim", value: claim, validateFn: validateClaim, refs });
}
