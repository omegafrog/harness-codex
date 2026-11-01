import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
  return path;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJsonAtomic(path, value) {
  await ensureDir(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function stableJson(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

export function redact(value) {
  const secretKey = /(^|_)(secret|token|password|credential|authorization|api[_-]?key|private[_-]?key)($|_)/i;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? "[REDACTED]" : redact(item)]));
  }
  if (typeof value === "string") {
    return value.replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]").replace(/(sk-[A-Za-z0-9_-]+)/g, "[REDACTED]");
  }
  return value;
}

export function isWithin(root, candidate) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function expandCommand(command, variables = {}) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    throw new TypeError("Codex command must be a non-empty string array");
  }
  return command.map((part) => part.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => String(variables[key] ?? "")));
}
