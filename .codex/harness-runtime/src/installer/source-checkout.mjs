import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

// Source checkouts, including separate Git worktrees, already own the runtime.
export async function isHarnessSourceCheckout(sourceRoot, targetRoot) {
  if (await realpath(sourceRoot) === await realpath(targetRoot)) return true;
  try {
    const sourcePackage = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
    const targetPackage = JSON.parse(await readFile(join(targetRoot, "package.json"), "utf8"));
    if (!sourcePackage.name || sourcePackage.name !== targetPackage.name) return false;
    for (const path of ["bin/harness-install.mjs", "src/installer/update.mjs", ".codex/skills/spec-me/SKILL.md"]) {
      if (!(await stat(join(targetRoot, path))).isFile()) return false;
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}
