import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';

const STATUS = 'Preparing Harness workflow composition';
const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop'];
const SCRIPT = 'harness-orchestrator-hook.mjs';
const quote = (value) => process.platform === 'win32' ? `"${value.replaceAll('"', '\\"')}"` : `'${value.replaceAll("'", "'\\''")}'`;
const owned = (handler) => handler?.statusMessage === STATUS && typeof handler.command === 'string' && handler.command.includes(SCRIPT);

export function orchestratorHook(root) {
  return { type: 'command', command: `${quote(process.execPath)} ${quote(join(root, '.codex/scripts', SCRIPT))}`, statusMessage: STATUS, timeout: 10 };
}

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

export async function inspectOrchestratorHook(root) {
  const { path, config } = await readHooks(root);
  const expected = orchestratorHook(root);
  const valid = EVENTS.every((event) => {
    const handlers = (config.hooks[event] || []).flatMap((group) => group.hooks).filter(owned);
    return handlers.length === 1 && Object.entries(expected).every(([key, value]) => handlers[0][key] === value);
  });
  return { valid, path, reason: valid ? 'orchestrator_hook_registered' : 'orchestrator_hook_missing_or_stale' };
}

export async function syncOrchestratorHook(root) {
  const directory = await lstat(join(root, '.codex'));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Hook directory must be a real directory');
  const { path, text, config } = await readHooks(root);
  if ((await inspectOrchestratorHook(root)).valid) return;
  for (const event of EVENTS) {
    const groups = (config.hooks[event] || []).flatMap((group) => {
      const hooks = group.hooks.filter((handler) => !owned(handler));
      return hooks.length || !group.hooks.some(owned) ? [{ ...group, hooks }] : [];
    });
    config.hooks[event] = [...groups, { hooks: [orchestratorHook(root)] }];
  }
  if (text !== null) {
    const backup = `.codex/installer-backups/hooks-${randomUUID()}`;
    await assertWorkspaceTarget(root, `${backup}/hooks.json`);
    await mkdir(join(root, backup), { recursive: true, mode: 0o700 });
    await writeFile(join(root, backup, 'hooks.json'), text, { mode: 0o600 });
  }
  const temporary = join(root, '.codex', `.hooks-${randomUUID()}.json`);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
