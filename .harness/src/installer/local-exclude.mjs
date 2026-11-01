import { readFile, realpath, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { isHarnessSourceCheckout } from "./source-checkout.mjs";
import { discoverManagedAssetPaths } from "./update.mjs";

const LOCAL_GENERATED_EXCLUDES = [
  "/.harness-workflows/",
  "/.io/",
  "/.codex/runtime/io/",
  "/.codex/context-budget.json",
  "/.codex/harness.yaml",
  "/.codex/harness-lock.json",
  "/.codex/hooks.json",
  "/.codex/installer-backups/",
  "/.github/pull_request_template.md",
  "/.github/workflows/harness-contracts.yml",
  "/skills-lock.json",
];
const PREVIOUS_BROAD_EXCLUDES = new Set([".agents/", ".codex/", ".harness/", ".harness/src/", "skills-lock.json"]);
const execFileAsync = promisify(execFile);

export async function protectLocalInstallArtifacts(projectRoot, sourceRoot) {
  const targetPath = await realpath(projectRoot);
  let gitRoot;
  try { gitRoot = await execFileAsync("git", ["-C", projectRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }); }
  catch { return; }
  if (await realpath(gitRoot.stdout.trim()) !== targetPath) return;
  const harnessSourcePath = await realpath(sourceRoot);
  const sourceCheckout = await isHarnessSourceCheckout(harnessSourcePath, targetPath);
  const managedPaths = await discoverManagedAssetPaths(sourceRoot);
  const sourceOwnedPaths = new Set([...managedPaths.map((path) => `/${path}`), "/.codex/harness.yaml", "/.codex/context-budget.json", "/.codex/harness-lock.json", "/.codex/hooks.json"]);
  const exclusions = [
    ...LOCAL_GENERATED_EXCLUDES.filter((entry) => !sourceCheckout || !sourceOwnedPaths.has(entry)),
    ...managedPaths.filter((path) => !sourceCheckout && path !== ".harness/contracts.mjs").map((path) => `/${path}`),
  ];
  let result;
  try { result = await execFileAsync("git", ["-C", projectRoot, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }); }
  catch { return; }
  const excludePath = resolve(projectRoot, (result.stdout || "").trim());
  const existing = await readFile(excludePath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  const normalizedExisting = existing.split(/\r?\n/).filter((entry) => !PREVIOUS_BROAD_EXCLUDES.has(entry)).join("\n");
  const additions = exclusions.filter((entry) => !normalizedExisting.split(/\r?\n/).includes(entry));
  if (additions.length === 0 && normalizedExisting === existing) return;
  const prefix = normalizedExisting.length > 0 && !normalizedExisting.endsWith("\n") ? "\n" : "";
  await writeFile(excludePath, `${normalizedExisting}${prefix}${additions.length > 0 ? `# Harness project-local installation artifacts\n${additions.join("\n")}\n` : ""}`, "utf8");
}
