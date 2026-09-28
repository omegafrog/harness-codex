#!/usr/bin/env node
import { readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const [action, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!["--root", "--manifest"].includes(key) || !rest[index + 1]) throw new Error(`Invalid argument: ${key}`);
    options[key.slice(2)] = rest[++index];
  }
  if (!['snapshot', 'cleanup'].includes(action)) throw new Error("Usage: artifact-guard.mjs <snapshot|cleanup> --root <worktree> --manifest <file-outside-worktree>");
  if (!options.root || !options.manifest) throw new Error("Both --root and --manifest are required");
  return { action, root: resolve(options.root), manifest: resolve(options.manifest) };
}

async function listArtifacts(root) {
  const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "--ignored", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return [...new Set(stdout.split("\0").filter(Boolean))].sort();
}

function safeTarget(root, gitPath) {
  if (isAbsolute(gitPath)) throw new Error(`Refusing absolute artifact path: ${gitPath}`);
  const target = resolve(root, gitPath);
  const pathFromRoot = relative(root, target);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`Refusing artifact path outside worktree: ${gitPath}`);
  }
  return target;
}

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
}

async function validateRoot(root) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  if (resolve(stdout.trim()) !== root) throw new Error(`--root must be the worktree root: ${root}`);
}

async function snapshot(root, manifest) {
  await validateRoot(root);
  if (isWithin(root, manifest)) throw new Error("--manifest must be outside the active worktree");
  const paths = await listArtifacts(root);
  await writeFile(manifest, JSON.stringify({ root, paths }, null, 2), { flag: "wx" });
  return { action: "snapshot", root, manifest, path_count: paths.length };
}

async function cleanup(root, manifest) {
  await validateRoot(root);
  if (isWithin(root, manifest)) throw new Error("--manifest must be outside the active worktree");
  const state = JSON.parse(await readFile(manifest, "utf8"));
  if (resolve(state.root) !== root || !Array.isArray(state.paths)) throw new Error("Artifact manifest does not match the requested worktree");
  const initial = new Set(state.paths);
  const current = await listArtifacts(root);
  const created = current.filter((path) => !initial.has(path));
  const removed = [];
  for (const path of created) {
    await rm(safeTarget(root, path), { recursive: true, force: true });
    removed.push(path);
  }
  const remaining = (await listArtifacts(root)).filter((path) => !initial.has(path));
  return { action: "cleanup", root, removed, remaining, status: remaining.length === 0 ? "passed" : "failed" };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = args.action === "snapshot" ? await snapshot(args.root, args.manifest) : await cleanup(args.root, args.manifest);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "failed") process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
