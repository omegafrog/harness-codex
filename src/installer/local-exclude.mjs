import { readFile, realpath, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const LOCAL_INSTALL_EXCLUDES = [
  ".agents/",
  ".codex/",
  "skills-lock.json",
];

export async function protectLocalInstallArtifacts(projectRoot, sourceRoot) {
  const targetPath = await realpath(projectRoot);
  const harnessSourcePath = await realpath(sourceRoot);
  // The Harness repository owns and versions its .codex source assets. Only a
  // consumer project should hide an installed .codex runtime from Git.
  const exclusions = targetPath === harnessSourcePath
    ? LOCAL_INSTALL_EXCLUDES.filter((entry) => entry !== ".codex/")
    : LOCAL_INSTALL_EXCLUDES;
  const result = spawnSync("git", ["-C", projectRoot, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" });
  if (result.status !== 0) return;
  const excludePath = resolve(projectRoot, (result.stdout || "").trim());
  const existing = await readFile(excludePath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  const normalizedExisting = targetPath === harnessSourcePath
    ? existing.split(/\r?\n/).filter((entry) => entry !== ".codex/").join("\n")
    : existing;
  const additions = exclusions.filter((entry) => !normalizedExisting.split(/\r?\n/).includes(entry));
  if (additions.length === 0 && normalizedExisting === existing) return;
  const prefix = normalizedExisting.length > 0 && !normalizedExisting.endsWith("\n") ? "\n" : "";
  await writeFile(excludePath, `${normalizedExisting}${prefix}${additions.length > 0 ? `# Harness project-local installation artifacts\n${additions.join("\n")}\n` : ""}`, "utf8");
}
