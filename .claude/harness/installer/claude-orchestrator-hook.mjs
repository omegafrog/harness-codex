import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertWorkspaceTarget } from '../../../.harness/src/eval/case-workspace.mjs';

// Prompt/Stop hooks run the orchestrator start-up script; the subagent hooks record the reviewers the main
// orchestrator spawns (a stage's runner passes the same hook through --settings, and the recorder de-duplicates).
// The PreToolUse hook denies the orchestrator main session's own writes to product code, tests and contracts; it steps
// aside inside stage runners (HARNESS_SKILL_EXECUTION_ID) and sub-agents (agent_id), which share this settings file.
const PROMPT_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop'];
const SUBAGENT_EVENTS = ['SubagentStart', 'SubagentStop'];
const GUARD_EVENTS = ['PreToolUse'];
const EVENTS = [...PROMPT_EVENTS, ...SUBAGENT_EVENTS, ...GUARD_EVENTS];
const SCRIPT = 'harness-claude-orchestrator-hook.mjs';
const SUBAGENT_SCRIPT = 'harness-agent-event.mjs';
const GUARD_SCRIPT = 'harness-write-guard.mjs';
export const WRITE_GUARD_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash';
const owned = (hook) => hook?.type === 'command' && typeof hook.command === 'string' && (hook.command.includes(SCRIPT) || hook.command.includes(SUBAGENT_SCRIPT) || hook.command.includes(GUARD_SCRIPT));

export function claudeOrchestratorHook() {
  return { type: 'command', command: `node "\${CLAUDE_PROJECT_DIR}/.claude/harness/scripts/${SCRIPT}"`, timeout: 10 };
}

export function claudeSubagentHook() {
  return { type: 'command', command: `node "\${CLAUDE_PROJECT_DIR}/.codex/scripts/${SUBAGENT_SCRIPT}"`, timeout: 10 };
}

export function claudeWriteGuardHook() {
  return { type: 'command', command: `node "\${CLAUDE_PROJECT_DIR}/.codex/scripts/${GUARD_SCRIPT}"`, timeout: 10 };
}

const expectedHook = (event) => SUBAGENT_EVENTS.includes(event) ? claudeSubagentHook() : GUARD_EVENTS.includes(event) ? claudeWriteGuardHook() : claudeOrchestratorHook();
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
  for (const event of EVENTS) if (config.hooks[event] !== undefined && (!Array.isArray(config.hooks[event]) || config.hooks[event].some((group) => !Array.isArray(group?.hooks)))) throw new Error(`Invalid Claude Code ${event} hooks`);
  return { path, text, config };
}

export async function inspectClaudeOrchestratorHook(root) {
  const { path, config } = await readSettings(root);
  const valid = EVENTS.every((event) => {
    const groups = (config.hooks[event] || []).filter((group) => group.hooks.some(owned));
    const handlers = groups.flatMap((group) => group.hooks).filter(owned);
    return handlers.length === 1 && groups[0].matcher === expectedMatcher(event) && Object.entries(expectedHook(event)).every(([key, value]) => handlers[0][key] === value);
  });
  return { valid, path, reason: valid ? 'claude_orchestrator_hook_registered' : 'claude_orchestrator_hook_missing_or_stale' };
}

export async function syncClaudeOrchestratorHook(root, { noBackup = false } = {}) {
  const settingsDirectory = join(root, '.claude');
  const directory = await lstat(settingsDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Claude settings directory must be a real directory');
  const { path, text, config } = await readSettings(root);
  if ((await inspectClaudeOrchestratorHook(root)).valid) return;
  for (const event of EVENTS) {
    const groups = (config.hooks[event] || []).flatMap((group) => {
      const hooks = group.hooks.filter((hook) => !owned(hook));
      return hooks.length || !group.hooks.some(owned) ? [{ ...group, hooks }] : [];
    });
    config.hooks[event] = [...groups, { ...(expectedMatcher(event) ? { matcher: expectedMatcher(event) } : {}), hooks: [expectedHook(event)] }];
  }
  if (text !== null && !noBackup) {
    const backup = `.claude/installer-backups/${randomUUID()}/settings.local.json`;
    await assertWorkspaceTarget(root, backup);
    await mkdir(dirname(join(root, backup)), { recursive: true, mode: 0o700 });
    await writeFile(join(root, backup), text, { mode: 0o600 });
  }
  const temporary = join(settingsDirectory, `.settings-${randomUUID()}.json`);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
