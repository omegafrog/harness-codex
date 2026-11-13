import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';

export const id = 'codex';

const snake = (event) => event.replace(/[A-Z]/g, (letter, index) => `${index ? '_' : ''}${letter.toLowerCase()}`);
const SUBAGENT_EVENTS = ['SubagentStart', 'SubagentStop'];
const SUBAGENT_STATUS = 'Recording Harness subagent';
const codexHome = (env) => resolve(env.CODEX_HOME || join(env.HOME || '', '.codex'));

// One user-level hook serves every project and worktree: it runs the active workspace's
// harness-agent-event.mjs only inside a Harness stage and does nothing elsewhere.
export function codexSubagentHook() {
  return {
    type: 'command',
    // Inside a stage HARNESS_WORKSPACE_ROOT names the workspace; in the main orchestrator session the cwd is the worktree.
    command: `sh -c 'f="\${HARNESS_WORKSPACE_ROOT:-.}/.codex/scripts/harness-agent-event.mjs"; [ -f "$f" ] && exec node "$f"; exit 0'`,
    statusMessage: SUBAGENT_STATUS,
    timeout: 10,
  };
}

// Refuses a forked start of a reviewer or E2E runner before it runs. Codex hook matchers do not match spawn_agent, so
// the shell filter keeps node off every other tool call. Optional: without trust, the later fork checks still apply.
const FRESH_AGENT_STATUS = 'Checking Harness fresh agent';
export function codexFreshAgentHook() {
  return {
    type: 'command',
    command: `sh -c 'f="\${HARNESS_WORKSPACE_ROOT:-.}/.codex/scripts/harness-fresh-agent.mjs"; [ -f "$f" ] || exit 0; i=$(cat); case "$i" in *spawn_agent*) printf "%s" "$i" | exec node "$f";; esac; exit 0'`,
    statusMessage: FRESH_AGENT_STATUS,
    timeout: 10,
  };
}
// Denies the orchestrator main session's own writes to product code, tests and contracts (see harness-write-guard.mjs).
// Main may coordinate sibling worktrees without its own record; the script checks registered write targets.
// Stage runners set HARNESS_SKILL_EXECUTION_ID. Codex matchers are not relied on, the script checks the tool.
const WRITE_GUARD_STATUS = 'Guarding Harness orchestrator writes';
export function codexWriteGuardHook() {
  return {
    type: 'command',
    command: `sh -c '[ -n "$HARNESS_SKILL_EXECUTION_ID" ] && exit 0; r=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0; f="$r/.codex/scripts/harness-write-guard.mjs"; [ -f "$f" ] || exit 0; i=$(cat); case "$i" in *apply_patch*|*Bash*|*exec_command*|*shell_command*) printf "%s" "$i" | exec node "$f";; esac; exit 0'`,
    statusMessage: WRITE_GUARD_STATUS,
    timeout: 10,
  };
}
// Codex trusts a hook by its hooks.json path and command, so a project hook written into each new worktree needed a
// new review every time. This user-level hook is trusted once and runs the orchestrator hook of whatever Harness
// workspace the session is in; it steps aside where the project's own hooks.json already has it.
const ORCHESTRATOR_STATUS = 'Running Harness orchestrator hook';
export const ORCHESTRATOR_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop'];
export function codexOrchestratorHook() {
  return {
    type: 'command',
    command: `sh -c 'r=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0; f="$r/.codex/scripts/harness-orchestrator-hook.mjs"; [ -f "$f" ] || exit 0; grep -qs harness-orchestrator-hook.mjs "$r/.codex/hooks.json" && exit 0; exec node "$f"'`,
    statusMessage: ORCHESTRATOR_STATUS,
    timeout: 10,
  };
}
const OWNED_HOOKS = [...SUBAGENT_EVENTS.map((event) => ({ event, status: SUBAGENT_STATUS, handler: codexSubagentHook })), { event: 'PreToolUse', status: FRESH_AGENT_STATUS, handler: codexFreshAgentHook }, { event: 'PreToolUse', status: WRITE_GUARD_STATUS, handler: codexWriteGuardHook }, ...ORCHESTRATOR_EVENTS.map((event) => ({ event, status: ORCHESTRATOR_STATUS, handler: codexOrchestratorHook }))];

// Whether the user-level orchestrator hook is installed; worktrees then need no project hook of their own.
export async function codexUserOrchestratorHookInstalled(env = process.env) {
  const text = await readFile(join(codexHome(env), 'hooks.json'), 'utf8').catch(() => null);
  if (!text) return false;
  try {
    const hooks = JSON.parse(text).hooks || {};
    return ORCHESTRATOR_EVENTS.every((event) => (hooks[event] || []).some((group) => (group.hooks || []).some((handler) => handler?.statusMessage === ORCHESTRATOR_STATUS && handler.command === codexOrchestratorHook().command)));
  } catch { return false; }
}

export async function syncCodexSubagentHook(env = process.env) {
  const path = join(codexHome(env), 'hooks.json');
  const text = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const config = text === null ? { hooks: {} } : JSON.parse(text);
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.hooks !== undefined && (typeof config.hooks !== 'object' || Array.isArray(config.hooks)))) throw new Error(`Invalid Codex hooks configuration: ${path}`);
  config.hooks ||= {};
  let changed = false;
  for (const { event, status, handler } of OWNED_HOOKS) {
    const want = handler();
    const groups = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const owned = groups.flatMap((group) => group.hooks || []).filter((item) => item?.statusMessage === status);
    if (owned.length === 1 && JSON.stringify(owned[0]) === JSON.stringify(want)) continue;
    const kept = groups.map((group) => ({ ...group, hooks: (group.hooks || []).filter((item) => item?.statusMessage !== status) })).filter((group) => group.hooks.length);
    config.hooks[event] = [...kept, { hooks: [want] }];
    changed = true;
  }
  if (!changed) return { path, changed: false };
  await mkdir(dirname(path), { recursive: true });
  if (text !== null) await writeFile(`${path}.harness-backup-${Date.now()}`, text, { flag: 'wx', mode: 0o600 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return { path, changed: true };
}

const sortedKeys = (value) => Array.isArray(value) ? value.map(sortedKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys(value[key])])) : value;

// Codex trusts a hook by this hash (reverse-engineered from recorded trust entries): sha256 over the key-sorted JSON of
// {event_name, hooks:[handler]} with the handler's default `async: false` filled in. Changing a hook's command changes it.
export function codexHookTrustHash(eventName, handler) {
  return createHash('sha256').update(JSON.stringify(sortedKeys({ event_name: eventName, hooks: [{ async: false, ...handler }] }))).digest('hex');
}

// Codex runs a hook only after the user trusts it with `/hooks`; trust is recorded in
// `$CODEX_HOME/config.toml` as `[hooks.state."<hooks.json>:<event>:<group>:<handler>"]` with a trusted hash.
export async function inspectCodexHookTrust(env = process.env) {
  const home = codexHome(env), hooksPath = join(home, 'hooks.json');
  const text = await readFile(hooksPath, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const hooks = text ? JSON.parse(text).hooks || {} : {};
  const config = await readFile(join(home, 'config.toml'), 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const trusted = new Map();
  let current = null;
  for (const line of config.split('\n')) {
    const header = /^\s*\[hooks\.state\."(.+)"\]\s*$/.exec(line);
    if (header) { current = header[1]; continue; }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    const hash = /^\s*trusted_hash\s*=\s*"sha256:([0-9a-f]{64})"/.exec(line)?.[1];
    if (current && hash) trusted.set(current, hash);
  }
  const missing = [], untrusted = [];
  for (const event of SUBAGENT_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const slots = groups.flatMap((group, groupIndex) => (group.hooks || []).map((handler, handlerIndex) => ({ handler, key: `${hooksPath}:${snake(event)}:${groupIndex}:${handlerIndex}` }))).filter(({ handler }) => handler?.statusMessage === SUBAGENT_STATUS);
    if (!slots.length) missing.push(event);
    else if (!slots.some(({ key, handler }) => trusted.get(key) === codexHookTrustHash(snake(event), handler))) untrusted.push(event);
  }
  const freshGroups = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const freshSlots = freshGroups.flatMap((group, groupIndex) => (group.hooks || []).map((handler, handlerIndex) => ({ handler, key: `${hooksPath}:pre_tool_use:${groupIndex}:${handlerIndex}` }))).filter(({ handler }) => handler?.statusMessage === FRESH_AGENT_STATUS);
  const freshAgentCheck = !freshSlots.length ? 'missing' : freshSlots.some(({ key, handler }) => trusted.get(key) === codexHookTrustHash('pre_tool_use', handler)) ? 'trusted' : 'untrusted';
  const slotState = (event, status, handler) => {
    const slots = (Array.isArray(hooks[event]) ? hooks[event] : []).flatMap((group, groupIndex) => (group.hooks || []).map((item, handlerIndex) => ({ item, key: `${hooksPath}:${snake(event)}:${groupIndex}:${handlerIndex}` }))).filter(({ item }) => item?.statusMessage === status);
    return !slots.length ? 'missing' : slots.some(({ key, item }) => trusted.get(key) === codexHookTrustHash(snake(event), item)) ? 'trusted' : 'untrusted';
  };
  const orchestratorStates = ORCHESTRATOR_EVENTS.map((event) => slotState(event, ORCHESTRATOR_STATUS, codexOrchestratorHook));
  const orchestratorHook = orchestratorStates.every((state) => state === 'trusted') ? 'trusted' : orchestratorStates.includes('missing') ? 'missing' : 'untrusted';
  const writeGuard = slotState('PreToolUse', WRITE_GUARD_STATUS, codexWriteGuardHook);
  return { trusted: !missing.length && !untrusted.length, missing, untrusted, fresh_agent_check: freshAgentCheck, write_guard: writeGuard, orchestrator_hook: orchestratorHook, hooks_path: hooksPath };
}


export async function findRollout(directory, sessionId) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const found = await findRollout(path, sessionId); if (found) return found; }
    else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${sessionId}.jsonl`)) return path;
  }
  return null;
}
