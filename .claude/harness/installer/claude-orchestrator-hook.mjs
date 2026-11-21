import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertWorkspaceTarget } from '../../../.harness/src/eval/case-workspace.mjs';

// The subagent hooks record the reviewers the main orchestrator spawns. The stage runner can also pass
// them through --settings, and the recorder de-duplicates.
// The PreToolUse hook denies the orchestrator main session's own writes to product code, tests and contracts; it steps
// aside inside stage runners (HARNESS_STAGE_EXECUTION_ID) and sub-agents (agent_id), which share this settings file.
const RETIRED_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop'];
const SUBAGENT_EVENTS = ['SubagentStart', 'SubagentStop'];
const GUARD_EVENTS = ['PreToolUse'];
const EVENTS = [...SUBAGENT_EVENTS, ...GUARD_EVENTS];
const retiredStartup = (hook) => hook?.type === 'command'
  && hook.command === 'node "${CLAUDE_PROJECT_DIR}/.claude/harness/scripts/harness-claude-orchestrator-hook.mjs"';
const SUBAGENT_SCRIPT = 'harness-agent-event.mjs';
const GUARD_SCRIPT = 'harness-write-guard.mjs';
const ADMISSION_SCRIPT = 'harness-agent-admission.mjs';
export const WRITE_GUARD_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash';
const owned = (hook) => hook?.type === 'command' && typeof hook.command === 'string' && [SUBAGENT_SCRIPT, GUARD_SCRIPT, ADMISSION_SCRIPT].some((script) => hook.command.includes(script));
const admissionHook = () => ({ type: 'command', command: `HARNESS_NATIVE_ADMISSION=1 node "\${CLAUDE_PROJECT_DIR}/.claude/harness/scripts/${ADMISSION_SCRIPT}"`, timeout: 10 });

export function claudeSubagentHook() {
  return { type: 'command', command: `node "\${CLAUDE_PROJECT_DIR}/.harness/scripts/${SUBAGENT_SCRIPT}"`, timeout: 10 };
}

export function claudeWriteGuardHook() {
  return { type: 'command', command: `node "\${CLAUDE_PROJECT_DIR}/.harness/scripts/${GUARD_SCRIPT}"`, timeout: 10 };
}

const expectedHook = (event) => SUBAGENT_EVENTS.includes(event) ? claudeSubagentHook() : claudeWriteGuardHook();
const expectedMatcher = (event) => GUARD_EVENTS.includes(event) ? WRITE_GUARD_MATCHER : undefined;

async function readSettings(root) {
  const path = join(root, '.claude/settings.local.json');
  const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('Claude local settings must be a regular file');
  const text = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const config = text === null ? {} : JSON.parse(text);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid Claude Code settings');
  config.hooks ||= {};
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error('Invalid Claude Code hooks settings');
  for (const event of [...EVENTS, ...RETIRED_EVENTS]) if (config.hooks[event] !== undefined && (!Array.isArray(config.hooks[event]) || config.hooks[event].some((group) => !Array.isArray(group?.hooks)))) throw new Error(`Invalid Claude Code ${event} hooks`);
  return { path, text, config };
}

export async function inspectClaudeOrchestratorHook(root) {
  const { path, config } = await readSettings(root);
  const retired_startup = RETIRED_EVENTS.some((event) => (config.hooks[event] || []).some((group) => group.hooks.some(retiredStartup)));
  const valid = EVENTS.every((event) => {
    const groups = (config.hooks[event] || []).filter((group) => group.hooks.some(owned));
    const handlers = groups.flatMap((group) => group.hooks).filter(owned);
    const expected = [{ matcher: expectedMatcher(event), hook: expectedHook(event) }, ...(event === 'PreToolUse' ? [{ matcher: 'Agent', hook: admissionHook() }] : [])];
    return handlers.length === expected.length && expected.every(({ matcher, hook }) => groups.some((group) => group.matcher === matcher && group.hooks.some((candidate) => Object.entries(hook).every(([key, value]) => candidate[key] === value))));
  });
  return { valid, retired_startup, path, reason: valid ? 'claude_workflow_hooks_registered' : 'claude_workflow_hooks_missing_or_stale' };
}

export async function syncClaudeOrchestratorHook(root, { noBackup = false } = {}) {
  const settingsDirectory = join(root, '.claude');
  const directory = await lstat(settingsDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Claude settings directory must be a real directory');
  const { path, text, config } = await readSettings(root);
  const { valid, retired_startup } = await inspectClaudeOrchestratorHook(root);
  if (valid && !retired_startup) return;
  for (const event of RETIRED_EVENTS) {
    const groups = config.hooks[event];
    if (!groups?.some((group) => group.hooks.some(retiredStartup))) continue;
    const kept = groups.flatMap((group) => {
      const hooks = group.hooks.filter((hook) => !retiredStartup(hook));
      return hooks.length === group.hooks.length ? [group] : hooks.length ? [{ ...group, hooks }] : [];
    });
    if (kept.length) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  if (!valid) for (const event of EVENTS) {
    const groups = (config.hooks[event] || []).flatMap((group) => {
      const hooks = group.hooks.filter((hook) => !owned(hook));
      return hooks.length || !group.hooks.some(owned) ? [{ ...group, hooks }] : [];
    });
    config.hooks[event] = [...groups, { ...(expectedMatcher(event) ? { matcher: expectedMatcher(event) } : {}), hooks: [expectedHook(event)] }];
    if (event === 'PreToolUse') config.hooks[event].push({ matcher: 'Agent', hooks: [admissionHook()] });
  }
  if (text !== null && (!noBackup || retired_startup)) {
    const backup = `.claude/installer-backups/${randomUUID()}/settings.local.json`;
    await assertWorkspaceTarget(root, backup);
    await mkdir(dirname(join(root, backup)), { recursive: true, mode: 0o700 });
    await writeFile(join(root, backup), text, { mode: 0o600 });
  }
  const temporary = join(settingsDirectory, `.settings-${randomUUID()}.json`);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
