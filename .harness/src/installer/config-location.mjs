import { constants } from 'node:fs';
import { access, lstat, mkdir, rename, copyFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';

export const HARNESS_CONFIG_PATH = ".harness/harness.yaml";
export const LEGACY_HARNESS_CONFIG_PATH = ".codex/harness.yaml";
export const HARNESS_LOCK_PATH = '.harness/harness-lock.json';
export const LEGACY_HARNESS_LOCK_PATH = '.codex/harness-lock.json';

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

export async function copyLegacyProjectGuidance(root) {
  const copied = [];
  for (const name of ['EXEC.md', 'execution.json', 'implementation-guidance.md', 'testing-guidance.md']) {
    const source = `docs/agents/${name}`;
    const target = `.harness/agents/${name}`;
    if (await lstat(resolve(root, target)).catch(missing)) continue;
    if (!(await lstat(resolve(root, source)).catch(missing))?.isFile()) continue;
    await assertWorkspaceTarget(root, source);
    await assertWorkspaceTarget(root, target);
    await mkdir(dirname(resolve(root, target)), { recursive: true });
    try {
      await copyFile(resolve(root, source), resolve(root, target), constants.COPYFILE_EXCL);
      copied.push(target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return copied;
}

export async function migrateLegacyRuntimeConfig(root, from, to) {
  if (await lstat(resolve(root, to)).catch(missing)) return false;
  const info = await lstat(resolve(root, from)).catch(missing);
  if (!info) return false;
  if (!info.isFile()) throw new Error(`Legacy Harness configuration must be a regular file: ${from}`);
  await assertWorkspaceTarget(root, from);
  await assertWorkspaceTarget(root, to);
  await mkdir(dirname(resolve(root, to)), { recursive: true });
  await copyFile(resolve(root, from), resolve(root, to), constants.COPYFILE_EXCL);
  await unlink(resolve(root, from));
  return true;
}

function missing(error) {
  if (error.code === 'ENOENT') return null;
  throw error;
}
