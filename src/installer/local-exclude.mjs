import { readFile, realpath, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { isHarnessSourceCheckout } from "./source-checkout.mjs";

const LOCAL_INSTALL_EXCLUDES = [
  ".harness-workflows/",
  ".io/",
  ".codex/runtime/io/",
  ".agents/",
  ".codex/",
  ".harness/",
  ".github/pull_request_template.md",
  ".github/workflows/harness-contracts.yml",
  "skills-lock.json",
];

export async function protectLocalInstallArtifacts(projectRoot, sourceRoot) {
  const targetPath = await realpath(projectRoot);
  const gitRoot = spawnSync("git", ["-C", projectRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (gitRoot.status !== 0 || await realpath(gitRoot.stdout.trim()) !== targetPath) return;
  const harnessSourcePath = await realpath(sourceRoot);
  const sourceCheckout = await isHarnessSourceCheckout(harnessSourcePath, targetPath);
  // The Harness repository owns and versions these source assets; consumers should ignore generated copies.
  const sourceOwnedPaths = new Set([".codex/", ".harness/", ".github/pull_request_template.md", ".github/workflows/harness-contracts.yml"]);
  const exclusions = sourceCheckout ? LOCAL_INSTALL_EXCLUDES.filter((entry) => !sourceOwnedPaths.has(entry)) : LOCAL_INSTALL_EXCLUDES;
  const result = spawnSync("git", ["-C", projectRoot, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" });
  if (result.status !== 0) return;
  const excludePath = resolve(projectRoot, (result.stdout || "").trim());
  const existing = await readFile(excludePath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  const normalizedExisting = sourceCheckout
    ? existing.split(/\r?\n/).filter((entry) => (entry === ".codex/runtime/io/" || !entry.startsWith(".codex/")) && !sourceOwnedPaths.has(entry)).join("\n")
    : existing;
  const additions = exclusions.filter((entry) => !normalizedExisting.split(/\r?\n/).includes(entry));
  if (additions.length === 0 && normalizedExisting === existing) return;
  const prefix = normalizedExisting.length > 0 && !normalizedExisting.endsWith("\n") ? "\n" : "";
  await writeFile(excludePath, `${normalizedExisting}${prefix}${additions.length > 0 ? `# Harness project-local installation artifacts\n${additions.join("\n")}\n` : ""}`, "utf8");
}
