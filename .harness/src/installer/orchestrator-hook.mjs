import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';

const STATUS = 'Preparing Harness workflow composition';
const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop'];
const SCRIPT = 'harness-orchestrator-hook.mjs';
const retiredBeadsHook = (handler) => typeof handler?.command === 'string' && /^bd codex-hook (PostCompact|PreCompact|SessionStart|UserPromptSubmit)$/.test(handler.command);
const retiredStartupHook = (handler) => handler?.type === 'command' && handler.statusMessage === STATUS
  && typeof handler.command === 'string' && handler.command.replaceAll('\\', '/').includes(`.codex/scripts/${SCRIPT}`);

async function readHooks(root) {
  const path = join(root, '.codex/hooks.json');
  let text;
  try {
    if (!(await lstat(path)).isFile()) throw new Error('hooks.json must be a regular file');
    text = await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return { path, text: null, config: { hooks: {} } }; throw error; }
  const config = JSON.parse(text);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid native hooks configuration');
  if (config.hooks === undefined) config.hooks = {};
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error('Invalid native hooks configuration');
  for (const event of EVENTS) {
    const groups = config.hooks[event];
    if (groups !== undefined && (!Array.isArray(groups) || groups.some((group) => !Array.isArray(group?.hooks)))) throw new Error(`Invalid ${event} hooks`);
  }
  return { path, text, config };
}

export async function inspectRetiredProjectHooks(root) {
  const { path, config } = await readHooks(root);
  const handlers = (groups) => Array.isArray(groups) ? groups.flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : []) : [];
  return {
    path,
    beads: Object.values(config.hooks).flatMap(handlers).filter(retiredBeadsHook).length,
    startup: EVENTS.flatMap((event) => handlers(config.hooks[event])).filter(retiredStartupHook).length,
  };
}

export async function retireProjectHooks(root) {
  const { path, text, config } = await readHooks(root);
  if (text === null) return;
  const directory = await lstat(join(root, '.codex'));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Hook directory must be a real directory');
  let retired = false;
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups) || groups.some((group) => !Array.isArray(group?.hooks))) continue;
    const shouldRetire = (handler) => retiredBeadsHook(handler) || (EVENTS.includes(event) && retiredStartupHook(handler));
    config.hooks[event] = groups.flatMap((group) => {
      const hooks = group.hooks.filter((handler) => !shouldRetire(handler));
      if (hooks.length === group.hooks.length) return [group];
      retired = true;
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (groups.length && !config.hooks[event].length) delete config.hooks[event];
  }
  if (!retired) return;
  const backup = `.harness/installer-backups/hooks-${randomUUID()}`;
  await assertWorkspaceTarget(root, `${backup}/hooks.json`);
  await mkdir(join(root, backup), { recursive: true, mode: 0o700 });
  await writeFile(join(root, backup, 'hooks.json'), text, { mode: 0o600 });
  const temporary = join(root, '.codex', `.hooks-${randomUUID()}.json`);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
