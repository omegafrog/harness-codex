// Read-only audit of how a workflow's stages actually ran: every stage execution and every retry (state.stages[*] and
// its attempts[]), the native thread that ran it, how it was spawned (fork_turns), the model and reasoning effort its
// turns really used, and the runtime attestation the runner recorded. It also reports, for the implementation workers,
// which files the worker read compared with the paths its ticket declared. Nothing here changes workflow state or
// gates anything: it collects evidence for an observer and flags what does not look like a fresh, correctly bound run.
import { constants } from 'node:fs';
import { open, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { sessionOutputPath } from './session-output.mjs';
import { findExecutionInput } from './execution-input.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_ROLLOUTS = 400;
const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
// Bind and spawn are separate tool calls; allow the activity timestamp a little slack around the recorded stage times.
const WINDOW_SLACK_MS = 10_000;
export const IMPLEMENTATION_SKILLS = Object.freeze(['tactical-code', 'implement', 'implement-wrapper', 'frontend-implement']);
// Harness agent types that must start from an empty context (kept in step with harness-fresh-agent.mjs).
const FRESH_AGENT_TYPES = new Set([
  'code_researcher', 'contract_reviewer', 'diagram_creator', 'e2e_test_runner', 'execution_runner',
  'frontend_designer', 'frontend_implementation_agent', 'frontend_visual_reviewer', 'human_approver',
  'implementation_agent', 'knowledge_claim_extractor', 'knowledge_principle_reviewer',
  'knowledge_principle_synthesizer', 'knowledge_source_researcher', 'plan_reviewer', 'pr_author',
  'spec_adversarial_reviewer', 'spec_reviewer', 'stakeholder_persona', 'standards_reviewer',
  'tactical_designer', 'tactical_implementation_agent', 'to_ticket', 'tracker_publisher', 'workflow_stage',
]);

const codexHome = () => resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
const time = (value) => { const at = Date.parse(value || ''); return Number.isFinite(at) ? at : null; };

async function readJsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readJsonLines(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.split('\n').filter(Boolean).map(parseJson).filter(Boolean);
}

const sessionFile = (root, relativePath) => { try { return sessionOutputPath(root, relativePath, { create: false }); } catch { return null; } };

async function findRolloutIn(directory, id) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const found = await findRolloutIn(path, id); if (found) return found; }
    else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`)) return path;
  }
  return null;
}

async function findRollout(id) {
  const home = codexHome();
  return await findRolloutIn(join(home, 'sessions'), id) || await findRolloutIn(join(home, 'archived_sessions'), id);
}

async function readRolloutEntries(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_ROLLOUT_BYTES) throw new Error('Unsafe or oversized Codex transcript');
    const entries = [];
    for (const [index, line] of (await handle.readFile('utf8')).split('\n').entries()) {
      if (!line.trim()) continue;
      const entry = parseJson(line);
      if (entry) entries.push({ ...entry, line: index + 1 });
    }
    return entries;
  } finally { await handle.close(); }
}

// The shell commands a Codex tool call ran: exec_command/shell arguments, or the `cmd` string literals of an `exec`
// JavaScript cell (the form Codex v2 uses: `await tools.exec_command({cmd:"..."})`).
const JS_STRING = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`([^`]*)`/g;
function toolCommands(item) {
  if (['exec_command', 'shell', 'shell_command'].includes(item.name)) {
    const args = parseJson(item.arguments || '');
    const cmd = args?.cmd ?? args?.command;
    return typeof cmd === 'string' ? [cmd] : Array.isArray(cmd) ? [cmd.join(' ')] : [];
  }
  if (item.name !== 'exec' || typeof item.input !== 'string') return [];
  const commands = [];
  for (const match of item.input.matchAll(/\bcmd\s*:\s*/g)) {
    JS_STRING.lastIndex = match.index + match[0].length;
    const literal = JS_STRING.exec(item.input);
    if (!literal || literal.index !== match.index + match[0].length) continue;
    const [, double, single, template] = literal;
    commands.push(double !== undefined ? (parseJson(`"${double}"`) ?? double) : single !== undefined ? single.replace(/\\'/g, "'") : template);
  }
  return commands;
}

// The facts of one rollout the audit needs: identity, fork origin, spawn calls with their arguments, the child threads
// it started, the model/effort of each completed turn, and the shell commands it ran.
function rolloutFacts(entries) {
  const meta = entries[0]?.type === 'session_meta' ? entries[0].payload || {} : null;
  const spawns = [], started = [], commands = [], fileReads = [];
  const turns = new Map();
  const turn = (id) => { if (!turns.has(id)) turns.set(id, { turn_id: id, status: 'running' }); return turns.get(id); };
  for (const entry of entries.slice(1)) {
    const payload = entry.payload || {};
    if (entry.type === 'turn_context' && typeof payload.turn_id === 'string') {
      const current = turn(payload.turn_id);
      if (typeof payload.model === 'string') current.model = payload.model;
      const effort = payload.effort ?? payload.collaboration_mode?.settings?.reasoning_effort;
      if (typeof effort === 'string') current.reasoning_effort = effort;
      continue;
    }
    if (entry.type === 'event_msg') {
      if (payload.type === 'task_started' && typeof payload.turn_id === 'string') turn(payload.turn_id);
      if (payload.type === 'task_complete' && typeof payload.turn_id === 'string') turn(payload.turn_id).status = payload.error ? 'failed' : 'completed';
      if (payload.type === 'turn_aborted' && typeof payload.turn_id === 'string') turn(payload.turn_id).status = 'interrupted';
      const item = payload.item;
      if (payload.type === 'item_completed' && item?.type === 'SubAgentActivity' && item.kind === 'started' && UUID.test(item.agent_thread_id || '')) {
        started.push({ agent_path: item.agent_path || null, thread_id: item.agent_thread_id, call_id: item.id || null, model: item.model ?? null, reasoning_effort: item.reasoning_effort ?? null, at: entry.timestamp, line: entry.line });
      }
      continue;
    }
    if (entry.type !== 'response_item') continue;
    if (payload.type === 'function_call' && /(?:^|\.)spawn_agent$/.test(payload.name || '')) {
      const args = parseJson(payload.arguments || '') || {};
      spawns.push({ call_id: payload.call_id || payload.id || null, task_name: args.task_name ?? null, agent_type: args.agent_type ?? null, fork_turns: args.fork_turns ?? null, model: args.model ?? null, reasoning_effort: args.reasoning_effort ?? null, at: entry.timestamp, line: entry.line });
    }
    if (['function_call', 'custom_tool_call'].includes(payload.type)) {
      const list = toolCommands(payload);
      if (list.length) commands.push({ line: entry.line, at: entry.timestamp, commands: list });
      // Dedicated file tools (read_file/view_image) name the path directly.
      if (payload.type === 'function_call' && /(?:^|\.)(?:read_file|view_image|open_file)$/.test(payload.name || '')) {
        const args = parseJson(payload.arguments || '') || {};
        const path = args.path ?? args.file_path;
        if (typeof path === 'string') fileReads.push({ line: entry.line, path, tool: payload.name });
      }
    }
  }
  return { meta, forked_from_id: meta?.forked_from_id || null, spawns, started, commands, fileReads, turns: [...turns.values()] };
}

// Reads the orchestrator rollouts and, breadth first, every child rollout they (and their children) started.
async function loadThreadGraph(parentIds) {
  const threads = new Map(), missing = [];
  const queue = [...new Set(parentIds.filter((id) => UUID.test(id || '')))].map((id) => ({ id, parent: null, depth: 0 }));
  while (queue.length && threads.size < MAX_ROLLOUTS) {
    const { id, parent, depth } = queue.shift();
    if (threads.has(id)) continue;
    const path = await findRollout(id);
    if (!path) { missing.push({ thread_id: id, reason: 'rollout_missing' }); threads.set(id, null); continue; }
    let facts;
    try { facts = rolloutFacts(await readRolloutEntries(path)); }
    catch (error) { missing.push({ thread_id: id, reason: 'rollout_unreadable', error: error.message }); threads.set(id, null); continue; }
    if (facts.meta?.id !== id) { missing.push({ thread_id: id, reason: 'rollout_identity_mismatch' }); threads.set(id, null); continue; }
    threads.set(id, { id, parent, depth, path, ...facts });
    for (const child of facts.started) if (!threads.has(child.thread_id)) queue.push({ id: child.thread_id, parent: id, depth: depth + 1 });
  }
  return { threads, missing, truncated: queue.length > 0 };
}

// agent path -> every thread started under it, with the spawn call (fork_turns, requested model) that created it.
function agentIndex(threads) {
  const index = new Map(), byThread = new Map();
  for (const thread of threads.values()) {
    if (!thread) continue;
    for (const activity of thread.started) {
      const spawn = thread.spawns.find((item) => item.call_id && item.call_id === activity.call_id)
        || thread.spawns.filter((item) => item.task_name && activity.agent_path?.endsWith(`/${item.task_name}`) && (time(item.at) ?? 0) <= (time(activity.at) ?? Infinity)).at(-1)
        || null;
      const record = { ...activity, parent_thread_id: thread.id, spawn };
      byThread.set(activity.thread_id, record);
      if (!activity.agent_path) continue;
      if (!index.has(activity.agent_path)) index.set(activity.agent_path, []);
      index.get(activity.agent_path).push(record);
    }
  }
  return { index, byThread };
}

function resolveThread(execution, { index, byThread }) {
  const agent = execution.native_agent_id;
  if (typeof agent !== 'string' || !agent.trim()) return { thread_id: null, reason: 'agent_id_unrecorded' };
  if (UUID.test(agent)) return { thread_id: agent, activity: byThread.get(agent) || null, resolved_by: 'thread_id' };
  const path = agent.startsWith('/') ? agent : `/root/${agent}`;
  const all = index.get(path) || [];
  const from = time(execution.started_at), to = time(execution.finished_at) ?? time(execution.updated_at);
  const inWindow = all.filter((item) => {
    const at = time(item.at);
    return at !== null && (from === null || at >= from - WINDOW_SLACK_MS) && (to === null || at <= to + WINDOW_SLACK_MS);
  });
  const owned = execution.parent_session_id ? inWindow.filter((item) => path.split('/').length > 3 || item.parent_thread_id === execution.parent_session_id) : inWindow;
  const candidates = owned.length ? owned : inWindow.length ? inWindow : all.length === 1 ? all : [];
  if (!candidates.length) return { thread_id: null, reason: all.length ? 'thread_outside_execution_window' : 'thread_not_found', agent_path: path };
  if (candidates.length > 1) return { thread_id: candidates.at(-1).thread_id, activity: candidates.at(-1), resolved_by: 'agent_path', ambiguous: candidates.map((item) => item.thread_id), agent_path: path };
  return { thread_id: candidates[0].thread_id, activity: candidates[0], resolved_by: 'agent_path', agent_path: path };
}

async function attestationOf(root, executionId) {
  const file = sessionFile(root, `runtime/executions/${executionId}/native-attestation.jsonl`);
  const rows = file ? await readJsonLines(file).catch(() => []) : [];
  const latest = rows.at(-1);
  if (!latest) return { status: 'not_recorded' };
  return { status: latest.status, ...(latest.reason ? { reason: latest.reason } : {}), thread_id: latest.thread_id || null, source: latest.source || null, rows: rows.length };
}

async function hookSubagents(root, executionId) {
  const file = sessionFile(root, `runtime/executions/${executionId}/subagents.jsonl`);
  const rows = file ? await readJsonLines(file).catch(() => []) : [];
  return rows.filter((row) => row.event === 'SubagentStart' || row.forked).map((row) => ({ agent_id: row.agent_id, agent_type: row.agent_type, ...(row.forked ? { forked: true } : {}), ...(row.admitted === false ? { admitted: false } : {}) }));
}

// Every execution the canonical state remembers: each stage's earlier attempts first, then its current execution.
function stageExecutions(state) {
  const list = [];
  for (const [stageId, entry] of Object.entries(state?.stages || {})) {
    const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
    [...attempts, entry].forEach((item, index) => {
      if (!item?.execution_id) return;
      list.push({
        stage_id: stageId, execution_id: item.execution_id, skill: item.skill || entry.skill || stageId, attempt: index + 1, attempts: attempts.length + 1,
        retry: index > 0, current: index === attempts.length, status: item.status || null, code: item.code || null,
        started_at: item.started_at || null, finished_at: item.finished_at || null, updated_at: item.updated_at || null,
        native_managed: Boolean(item.native_managed), native_agent_id: item.native_agent_id || null,
        parent_session_id: item.native_agent_session_id || state.orchestrator_session_id || null,
        requested: { model: item.model ?? null, reasoning_effort: item.reasoning_effort ?? null },
      });
    });
  }
  return list.sort((a, b) => (time(a.started_at) ?? 0) - (time(b.started_at) ?? 0));
}

function observedBinding(turns) {
  const completed = turns.filter((turn) => turn.status === 'completed');
  const pick = completed.length ? completed : turns;
  return {
    turns: pick.length,
    models: [...new Set(pick.map((turn) => turn.model).filter(Boolean))],
    reasoning_efforts: [...new Set(pick.map((turn) => turn.reasoning_effort).filter(Boolean))],
  };
}

// A spawn call the fresh-agent hook refused never starts a thread; only calls that started one can be "not fresh".
function nestedSpawns(thread, threads) {
  return (thread?.spawns || []).map((spawn) => {
    const activity = thread.started.find((item) => item.call_id && item.call_id === spawn.call_id);
    const child = activity ? threads.get(activity.thread_id) : null;
    const notFresh = activity && FRESH_AGENT_TYPES.has(spawn.agent_type) && (spawn.fork_turns !== 'none' || child?.forked_from_id);
    return {
      task_name: spawn.task_name, agent_type: spawn.agent_type, fork_turns: spawn.fork_turns,
      model: spawn.model, reasoning_effort: spawn.reasoning_effort, line: spawn.line,
      started: Boolean(activity), ...(activity ? { thread_id: activity.thread_id } : {}),
      ...(notFresh ? { flag: 'subagent_not_fresh' } : {}),
    };
  });
}

// The ticket an execution worked on, from its recorded input. A per-ticket stage (tactical-code, frontend-implementation)
// records the execution of the next ticket among its attempts too; that execution is new work, not a retry.
async function planOf(root, executionId) {
  try { return (await findExecutionInput(root, executionId)).input?.context?.plan_id || null; } catch { return null; }
}

export async function auditExecutions({ root }) {
  const state = await readJsonFile(sessionFile(root, 'runtime/orchestrator/state.json') || join(root, '.io/runtime/orchestrator/state.json'));
  if (!state) return { status: 'unavailable', reason: 'orchestrator_state_missing', executions: [] };
  const provider = state.orchestrator_provider || 'codex';
  const executions = stageExecutions(state);
  for (const execution of executions) { const plan = await planOf(root, execution.execution_id); if (plan) execution.plan_id = plan; }
  for (const execution of executions.filter((item) => item.retry)) {
    const previous = executions.find((item) => item.stage_id === execution.stage_id && item.attempt === execution.attempt - 1);
    if (previous?.plan_id && execution.plan_id && previous.plan_id !== execution.plan_id) execution.retry = false;
  }
  const native = executions.filter((item) => item.native_managed);
  let graph = { threads: new Map(), missing: [], truncated: false };
  const observable = provider === 'codex';
  if (observable) graph = await loadThreadGraph([state.orchestrator_session_id, ...native.map((item) => item.parent_session_id)]);
  const indexes = agentIndex(graph.threads);
  const threadOwners = new Map();
  const rows = [];
  for (const execution of executions) {
    const row = { ...execution, flags: [] };
    row.attestation = await attestationOf(root, execution.execution_id);
    row.hook_subagents = await hookSubagents(root, execution.execution_id);
    if (row.hook_subagents.some((item) => item.forked)) row.flags.push('hook_recorded_forked_subagent');
    if (!execution.native_managed) { row.observation = 'not_native'; rows.push(row); continue; }
    if (!observable) { row.observation = 'unavailable'; row.observation_reason = `rollout_audit_not_supported_for_${provider}`; rows.push(row); continue; }
    const resolved = resolveThread(execution, indexes);
    row.thread_id = resolved.thread_id;
    if (resolved.agent_path) row.agent_path = resolved.agent_path;
    if (!resolved.thread_id) { row.flags.push('thread_unresolved'); row.observation = resolved.reason; rows.push(row); continue; }
    if (resolved.ambiguous) { row.flags.push('thread_ambiguous'); row.thread_candidates = resolved.ambiguous; }
    // A thread recorded by ID may have been started outside the orchestrator's tree (by an interrupted run's helper):
    // read it and its parent, whose rollout holds the spawn call.
    if (!graph.threads.has(resolved.thread_id)) {
      const direct = await loadThreadGraph([resolved.thread_id]);
      const parentId = direct.threads.get(resolved.thread_id)?.meta?.parent_thread_id;
      const extra = parentId && !graph.threads.has(parentId) ? await loadThreadGraph([parentId]) : { threads: new Map(), missing: [] };
      for (const loaded of [direct, extra]) {
        for (const [id, value] of loaded.threads) if (!graph.threads.has(id)) graph.threads.set(id, value);
        graph.missing.push(...loaded.missing);
      }
      Object.assign(indexes, agentIndex(graph.threads));
      resolved.activity ||= indexes.byThread.get(resolved.thread_id) || null;
    }
    const spawn = resolved.activity?.spawn || null;
    row.fork_turns = spawn?.fork_turns ?? null;
    row.agent_type = spawn?.agent_type ?? null;
    row.spawn_requested = spawn ? { model: spawn.model, reasoning_effort: spawn.reasoning_effort } : null;
    const thread = graph.threads.get(resolved.thread_id);
    row.forked_from_id = thread?.forked_from_id || null;
    row.observed = thread ? observedBinding(thread.turns) : null;
    row.subagents = nestedSpawns(thread, graph.threads);
    if (!spawn) row.flags.push('spawn_unobserved');
    else if (spawn.fork_turns !== 'none') row.flags.push('not_fresh');
    if (row.forked_from_id) row.flags.push('forked_transcript');
    if (!thread) row.flags.push('rollout_unavailable');
    // A spawn without an explicit model inherits it; the observed turns below show what actually ran.
    if (spawn && ((spawn.model && execution.requested.model && spawn.model !== execution.requested.model) || (spawn.reasoning_effort && execution.requested.reasoning_effort && spawn.reasoning_effort !== execution.requested.reasoning_effort))) row.flags.push('spawn_binding_mismatch');
    if (row.observed) {
      const { models, reasoning_efforts: efforts, turns } = row.observed;
      if (!turns) row.flags.push('turn_metadata_missing');
      else if ((execution.requested.model && models.some((model) => model !== execution.requested.model)) || (execution.requested.reasoning_effort && efforts.some((effort) => effort !== execution.requested.reasoning_effort))) row.flags.push('model_mismatch');
    }
    if (row.attestation.status !== 'captured') row.flags.push('attestation_not_captured');
    if (row.attestation.thread_id && row.attestation.thread_id !== resolved.thread_id) row.flags.push('attestation_thread_mismatch');
    if (row.subagents.some((item) => item.flag)) row.flags.push('subagent_not_fresh');
    if (!threadOwners.has(resolved.thread_id)) threadOwners.set(resolved.thread_id, []);
    threadOwners.get(resolved.thread_id).push(row);
    rows.push(row);
  }
  // A retry that reached the same native thread as an earlier execution did not start fresh.
  for (const owners of threadOwners.values()) if (owners.length > 1) for (const row of owners) { row.flags.push('thread_reused'); row.thread_shared_with = owners.filter((item) => item !== row).map((item) => item.execution_id); }
  // Orchestrator-level spawns that no stage execution owns (code reviewers, basis rechecks, personas of the main session).
  const bound = new Set(rows.map((row) => row.thread_id).filter(Boolean));
  const orchestrator = graph.threads.get(state.orchestrator_session_id);
  const other = [];
  for (const activity of orchestrator?.started || []) {
    if (bound.has(activity.thread_id)) continue;
    const record = indexes.byThread.get(activity.thread_id);
    const spawn = record?.spawn;
    const thread = graph.threads.get(activity.thread_id);
    other.push({ thread_id: activity.thread_id, agent_path: activity.agent_path, agent_type: spawn?.agent_type ?? null, fork_turns: spawn?.fork_turns ?? null, forked_from_id: thread?.forked_from_id || null, observed: thread ? observedBinding(thread.turns) : null,
      ...(spawn && FRESH_AGENT_TYPES.has(spawn.agent_type) && (spawn.fork_turns !== 'none' || thread?.forked_from_id) ? { flags: ['not_fresh'] } : {}) });
  }
  const orchestratorHook = await readJsonLines(sessionFile(root, 'runtime/orchestrator/subagents.jsonl') || join(root, '.io/runtime/orchestrator/subagents.jsonl')).catch(() => []);
  const flagCounts = {};
  for (const row of rows) for (const flag of new Set(row.flags)) flagCounts[flag] = (flagCounts[flag] || 0) + 1;
  for (const item of other) for (const flag of item.flags || []) flagCounts[`other_spawn_${flag}`] = (flagCounts[`other_spawn_${flag}`] || 0) + 1;
  const flagged = rows.filter((row) => row.flags.length);
  return {
    status: !observable ? 'partial' : graph.missing.length || graph.truncated ? 'partial' : 'complete',
    provider, orchestrator_session_id: state.orchestrator_session_id || null,
    summary: { executions: rows.length, native: native.length, retries: rows.filter((row) => row.retry).length, flagged: flagged.length, flags: flagCounts },
    executions: rows,
    other_spawns: other,
    orchestrator_hook_subagents: orchestratorHook.filter((row) => row.event === 'SubagentStart' || row.forked).map((row) => ({ agent_id: row.agent_id, agent_type: row.agent_type, ...(row.forked ? { forked: true } : {}) })),
    missing_rollouts: graph.missing,
    ...(graph.truncated ? { truncated: true } : {}),
    _threads: graph.threads,
  };
}

// ---- read scope ------------------------------------------------------------------------------------------------

const READ_COMMANDS = new Set(['cat', 'sed', 'head', 'tail', 'less', 'more', 'nl', 'bat', 'wc', 'jq']);
const SEARCH_COMMANDS = new Set(['rg', 'grep', 'find', 'fd', 'ls', 'tree']);
// Value-taking options whose argument is not a file to read.
const OPTION_VALUES = { sed: new Set(['-e', '--expression']), head: new Set(['-n', '-c', '--lines', '--bytes']), tail: new Set(['-n', '-c', '--lines', '--bytes']), rg: new Set(['-e', '-g', '--glob', '-t', '--type', '-m', '--max-count', '-A', '-B', '-C', '--max-depth', '-M']), grep: new Set(['-e', '-m', '-A', '-B', '-C', '--include', '--exclude']), find: new Set(['-name', '-iname', '-type', '-maxdepth', '-mindepth', '-path', '-newer', '-printf', '-not', '-prune']), jq: new Set(['--arg', '--argjson']), nl: new Set(['-b', '-w']) };

function shellWords(segment) {
  const words = [];
  let current = '', quote = null, started = false;
  for (const char of segment) {
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started || current) words.push(current); current = ''; started = false; continue; }
    current += char;
  }
  if (started || current) words.push(current);
  return words;
}

function splitSegments(command) {
  const segments = [];
  let current = '', quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) { current += char; if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '\n' || char === ';' || char === '|' || (char === '&' && command[index + 1] === '&')) {
      segments.push(current); current = '';
      if ((char === '&' || char === '|') && command[index + 1] === char) index += 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

// The files (read) and directories (search) a shell command names. Redirections and heredoc writers are not reads.
export function commandPaths(command) {
  const found = [];
  for (const segment of splitSegments(command)) {
    let words = shellWords(segment);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
    if (words[0] === 'env' || words[0] === 'command' || words[0] === 'sudo') words = words.slice(1);
    const name = words[0]?.split('/').at(-1);
    const kind = READ_COMMANDS.has(name) ? 'read' : SEARCH_COMMANDS.has(name) ? 'search' : null;
    if (!kind || words.some((word) => word === '>' || word === '>>' || /^\d?>{1,2}/.test(word) || word.startsWith('<<'))) continue;
    const valued = OPTION_VALUES[name] || new Set();
    const args = [];
    for (let index = 1; index < words.length; index += 1) {
      const word = words[index];
      if (word === '--') { args.push(...words.slice(index + 1)); break; }
      if (word.startsWith('-')) { if (valued.has(word)) index += 1; continue; }
      args.push(word);
    }
    // sed without -e and rg/grep take their script or pattern first.
    const operands = (name === 'sed' && !words.includes('-e')) || ((name === 'rg' || name === 'grep') && !words.includes('-e') && !words.includes('--files')) || name === 'jq' ? args.slice(1) : args;
    for (const operand of operands) if (/[\w.-]/.test(operand) && !/[%\\]/.test(operand) && !/^[\d,;$pq]+$/.test(operand) && !/[()$`*?\[\]{}]/.test(operand.replace(/\*\*?/g, ''))) found.push({ kind, path: operand });
  }
  return found;
}

function workspacePath(root, path) {
  const absolute = isAbsolute(path) ? normalize(path) : resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel) return '.';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

// What a ticket declares as its scope: backticked workspace paths (files and directories, a glob kept up to its last
// literal directory) and its bounded contexts. Code identifiers such as `Conversation.create` are not paths.
const FILE_EXTENSION = /\.(?:m?[jt]sx?|c[jt]s|json|ya?ml|toml|sql|css|scss|less|html?|vue|svelte|md|txt|py|rb|go|rs|java|kt|kts|swift|cs|php|sh|xml|gradle|properties|env|lock|puml|svg|png)$/i;
const DIRECTORY_SEGMENT = /^\.?[\w@-][\w@.-]*$/;
export function declaredScope(ticketText) {
  const paths = new Set(), contexts = new Set();
  for (const [, token] of String(ticketText || '').matchAll(/`([^`\n]+)`/g)) {
    const value = token.trim().replace(/^\.\//, '');
    if (!value || /\s/.test(value) || value.startsWith('/') || /^[a-z]+:/i.test(value)) continue;
    let segments = value.replace(/\/$/, '').split('/');
    const glob = segments.findIndex((part) => /[*?[\]{}]/.test(part));
    if (glob === 0) continue;
    if (glob > 0) segments = segments.slice(0, glob);
    const last = segments.at(-1);
    const directories = glob > 0 ? segments : segments.slice(0, -1);
    if (!directories.every((part) => DIRECTORY_SEGMENT.test(part) && !/\.[A-Za-z]/.test(part.slice(1)))) continue;
    if (glob < 0 && !(segments.length > 1 && /^[\w@-]+$/.test(last)) && !(DIRECTORY_SEGMENT.test(last) && FILE_EXTENSION.test(last))) continue;
    paths.add(segments.join('/'));
  }
  for (const [, list] of String(ticketText || '').matchAll(/컨텍스트\s*\(BC\)\s*\|?\s*[:|]?\s*([^\n|]+)/g)) {
    for (const [, id] of list.matchAll(/(?:^|[,\s])([a-z][a-z0-9-]*)(?=\s|\(|,|$)/g)) contexts.add(id);
  }
  return { paths: [...paths].sort(), contexts: [...contexts].sort() };
}

const BASELINE = [/^\.(?:harness|io|codex|claude|agents|git)(?:\/|$)/, /^(?:AGENTS|CLAUDE|CONTEXT|CONTEXT-MAP|README)\.md$/, /^package(?:-lock)?\.json$/, /^\.gitignore$/, /^\.$/];

export function classifyRead(path, { planSetId, declared, kind = 'read' }) {
  if (BASELINE.some((pattern) => pattern.test(path))) return 'harness_or_project_baseline';
  if (planSetId && ['docs/specs', 'docs/plans', 'docs/implementation'].some((base) => path === `${base}/${planSetId}` || path.startsWith(`${base}/${planSetId}/`))) return 'plan_set_document';
  if (/^docs\/(?:contracts|architecture)\//.test(path)) return 'project_contract';
  for (const item of declared.paths) {
    const directory = item.includes('.') && !item.endsWith('/') ? item.split('/').slice(0, -1).join('/') : item;
    if (path === item || path.startsWith(`${item}/`) || (directory && (path === directory || path.startsWith(`${directory}/`)))) return 'declared';
  }
  if (path.split('/').some((part) => declared.contexts.includes(part.replace(/\.[^.]+$/, '')))) return 'declared_context';
  // Searching a directory that contains a declared path looks for the declared files; it is broad, not out of scope.
  if (kind === 'search' && declared.paths.some((item) => item.startsWith(`${path}/`))) return 'declared_ancestor_search';
  return null;
}

export function readScopeOf({ root, planSetId, ticketText, thread }) {
  const declared = declaredScope(ticketText);
  const reads = new Map();
  const note = (path, kind, line) => {
    const rel = workspacePath(root, path);
    const key = rel ?? `external:${path}`;
    const existing = reads.get(key) || { path: rel ?? path, kind, lines: [], ...(rel === null ? { outside_workspace: true } : {}) };
    if (kind === 'read') existing.kind = 'read';
    existing.lines.push(line);
    reads.set(key, existing);
  };
  for (const call of thread.commands) for (const command of call.commands) for (const item of commandPaths(command)) note(item.path, item.kind, call.line);
  for (const item of thread.fileReads) note(item.path, 'read', item.line);
  const listed = [...reads.values()].map((item) => {
    const scope = item.outside_workspace ? null : classifyRead(item.path, { planSetId, declared, kind: item.kind });
    return { ...item, lines: [...new Set(item.lines)].slice(0, 10), scope: scope || 'out_of_scope' };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const outOfScope = listed.filter((item) => item.scope === 'out_of_scope');
  return { declared, reads: listed, out_of_scope: outOfScope.map(({ path, kind, lines }) => ({ path, kind, lines })), counts: { reads: listed.filter((item) => item.kind === 'read').length, searched: listed.filter((item) => item.kind === 'search').length, out_of_scope: outOfScope.length } };
}

// Observational only: for each implementation worker execution, the files its rollout read compared with the paths and
// contexts its ticket declares. A read outside them is flagged for a reviewer to judge; it never blocks anything.
export async function auditReadScope({ root, audit = null, planId = null }) {
  const executions = audit || await auditExecutions({ root });
  if (executions.status === 'unavailable') return { status: 'unavailable', reason: executions.reason, workers: [] };
  const worktree = await readJsonFile(join(root, '.io/worktree.json')).catch(() => null);
  const planSetId = worktree?.plan_set_id || null;
  const workers = [];
  for (const row of executions.executions) {
    if (!IMPLEMENTATION_SKILLS.includes(row.skill)) continue;
    let input = null;
    try { input = (await findExecutionInput(root, row.execution_id)).input; } catch { input = null; }
    const plan = input?.context?.plan_id || null;
    if (planId && plan !== planId) continue;
    const ticketRef = input?.input_refs?.find((item) => item.kind === 'ticket' && item.base === 'workspace')?.path
      || (plan && planSetId && ID.test(plan) ? `docs/plans/${planSetId}/${plan}.md` : null);
    const worker = { stage_id: row.stage_id, execution_id: row.execution_id, attempt: row.attempt, plan_id: plan, ticket: ticketRef, thread_id: row.thread_id || null };
    const thread = row.thread_id ? executions._threads?.get(row.thread_id) : null;
    if (!thread) { workers.push({ ...worker, status: 'unavailable', reason: row.thread_id ? 'rollout_unavailable' : row.observation || 'thread_unresolved' }); continue; }
    const ticketText = ticketRef ? await readFile(join(root, ticketRef), 'utf8').catch(() => null) : null;
    if (ticketText === null) { workers.push({ ...worker, status: 'unavailable', reason: 'ticket_unreadable' }); continue; }
    workers.push({ ...worker, status: 'observed', ...readScopeOf({ root, planSetId, ticketText, thread }) });
  }
  return {
    status: workers.some((item) => item.status === 'unavailable') ? 'partial' : workers.length ? 'complete' : 'no_implementation_workers',
    blocking: false,
    plan_set_id: planSetId,
    summary: { workers: workers.length, out_of_scope_reads: workers.reduce((sum, item) => sum + (item.counts?.out_of_scope || 0), 0) },
    workers,
  };
}

export function publicAudit(audit) {
  const { _threads, ...rest } = audit;
  return rest;
}
