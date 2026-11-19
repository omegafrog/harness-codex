import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { LEGACY_PROJECT_AGENT_DIRECTORY, PROJECT_AGENT_DIRECTORY, PROJECT_AGENT_FILES, currentProjectAgentPath } from '../workflow/project-agent-paths.mjs';

async function regularFile(root, path) {
  await assertWorkspaceTarget(root, path);
  const info = await lstat(join(root, path)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (info && !info.isFile()) throw new Error(`Expected a regular project guidance file: ${path}`);
  return info;
}

export async function migrateProjectAgentFiles(root) {
  const moved = [];
  const conflicts = [];
  for (const name of PROJECT_AGENT_FILES) {
    const from = `${LEGACY_PROJECT_AGENT_DIRECTORY}/${name}`;
    const to = `${PROJECT_AGENT_DIRECTORY}/${name}`;
    const info = await regularFile(root, from);
    if (!info) continue;
    const source = join(root, from);
    const target = join(root, to);
    const original = await readFile(source).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!original) continue;
    const exists = await regularFile(root, to);
    // Preserve everything except references to the known project files that are moving.
    const text = original.toString('utf8');
    const updated = text.replace(/docs\/agents\/[\w.-]+/g, currentProjectAgentPath);
    const content = updated === text ? original : Buffer.from(updated);
    if (!exists) {
      const directory = join(root, PROJECT_AGENT_DIRECTORY);
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `.migration-${randomUUID()}`);
      await writeFile(temporary, content, { flag: 'wx', mode: info.mode & 0o777 });
      try {
        // Publish the complete file without overwriting a concurrent edit at the new path.
        await link(temporary, target).catch((error) => { if (error.code !== 'EEXIST') throw error; });
      } finally {
        await unlink(temporary);
      }
    }
    const remaining = await readFile(source).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!remaining) continue;
    if (!(await readFile(target)).equals(content) || !remaining.equals(original)) {
      conflicts.push({ from, to });
      continue;
    }
    await unlink(source).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    moved.push({ from, to });
  }
  if (moved.length) await rmdir(join(root, LEGACY_PROJECT_AGENT_DIRECTORY)).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
  });
  return { moved, conflicts };
}
