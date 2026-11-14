import { access, mkdir, rename, copyFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const HARNESS_CONFIG_PATH = ".harness/harness.yaml";
export const LEGACY_HARNESS_CONFIG_PATH = ".codex/harness.yaml";

const exists = (path) => access(path).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error));

// The project configuration is shared by every provider, so it lives outside provider directories.
// An existing legacy file moves once; a configuration already at the new path is never overwritten.
export async function migrateLegacyHarnessConfig(projectRoot) {
  const legacy = resolve(projectRoot, LEGACY_HARNESS_CONFIG_PATH);
  const current = resolve(projectRoot, HARNESS_CONFIG_PATH);
  if (!(await exists(legacy)) || await exists(current)) return { migrated: false };
  await mkdir(dirname(current), { recursive: true });
  try { await rename(legacy, current); }
  catch (error) {
    if (error.code !== "EXDEV") throw error;
    await copyFile(legacy, current);
    await unlink(legacy);
  }
  return { migrated: true, from: LEGACY_HARNESS_CONFIG_PATH, to: HARNESS_CONFIG_PATH };
}
