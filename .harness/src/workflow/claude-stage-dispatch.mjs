// Claude Code stage path. The orchestrator makes one Agent call per stage (prompt `harness-stage: <stage> [options]`);
// hooks do the rest, each with the identity Claude Code gives it:
//   PreToolUse(Agent)  admitStageDispatch  runs `launch`, reserves the execution and rewrites the call into the stage worker
//   SubagentStart      bindStageWorker     binds the reserved execution to the real agent id (same checks as `bind`)
//   SubagentStop       finishStageWorker   records the worker's final JSON (`receive` + `finish`); a format or gate error
//                                          goes back to the same worker, which continues and answers again
//   PostToolUse(Agent) stageResultOutput   replaces the Agent result with the compact envelope Harness recorded
// The orchestrator never authors, relays or reads a result; the worker never needs a receive command.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { recordUnitBoundary } from './compaction-boundary.mjs';
import { buildAssignment, inlineSchema } from './stage-assignment.mjs';

export const STAGE_DISPATCH_DIRECTORY = 'runtime/claude-dispatch';
export const MAX_WORKER_REPAIRS = 3;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// Errors a worker can fix by itself in the same turn. Anything else goes to the orchestrator with its `next`.
const WORKER_REPAIRABLE = new Set(['DOMAIN_SYNC_MISSING', 'RESULT_REJECTED']);
const NATIVE = 'node .harness/scripts/harness-native-stage.mjs';
// A worker whose last transcript entry is an API error (usage limit, overload, 5xx) cannot answer anything. The runner fails its
// execution itself once the transcript has been quiet this long and the dispatching Agent call is not the current session's live call.
export const DEAD_WORKER_QUIET_MS = 60 * 1000;
export const WORKER_API_ERROR = 'WORKER_API_ERROR';
export const DEAD_WORKER_FEEDBACK = 'The previous worker of this stage ended on an API error (for example a usage limit) and recorded no result. Continue from the committed documents and the previous input, and keep any answers already given.';
export const DISPATCH_AGAIN = 'Dispatch the same stage again after the limit resets';
const API_ERROR_MESSAGE = /^\s*(?:You['\u2019]ve (?:hit|reached) your\b|API Error\b|Claude (?:AI )?usage limit\b|Overloaded\b|Request timed out\b)/i;

export function shellSplit(text) {
  const tokens = [];
  let current = '', quote = null, started = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += char;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === '\\' && i + 1 < text.length) { current += text[++i]; started = true; }
    else if (/\s/.test(char)) { if (started || current) tokens.push(current); current = ''; started = false; }
    else { current += char; started = true; }
  }
  if (quote) throw new Error('Unclosed quote in the harness-stage line');
  if (started || current) tokens.push(current);
  return tokens;
}

// `harness-stage: <stage-id|answer> [launch options]` on the first line; the lines below are the body, which an option
// takes with the value `@body` (feedback or a user reply with any quotes or line breaks). `answer` is `--answer-text @body`; `revise` is `--revise-text @body`: Harness picks the earliest owner stage and reopens it with --user-revision.
export function parseStageCall(prompt) {
  if (typeof prompt !== 'string') return null;
  const match = /^harness-stage:[ \t]*([^\n]*)(?:\n([\s\S]*))?$/.exec(prompt.replace(/^\s+/, ''));
  if (!match) return null;
  const body = (match[2] ?? '').trim();
  const [head, ...options] = shellSplit(match[1]);
  if (!head || !(head === 'answer' || head === 'revise' || /^[a-z][a-z0-9-]*$/.test(head))) throw new Error('The first line must be "harness-stage: <stage-id>" or "harness-stage: answer"');
  const values = options.map((option) => option === '@body' ? body : option);
  if (values.some((value) => value === '')) throw new Error('A harness-stage option value is empty; put long text below the first line and pass @body');
  if (head === 'answer') {
    if (!body) throw new Error('"harness-stage: answer" needs the user\'s reply verbatim on the lines below it');
    return { stage: null, args: ['--answer-text', body, ...values] };
  }
  if (head === 'revise') {
    if (!body) throw new Error('"harness-stage: revise" needs the user\'s change request verbatim on the lines below it');
    return { stage: null, args: ['--revise-text', body, ...values] };
  }
  return { stage: head, args: ['--stage-id', head, ...values] };
}

function lastJson(text) {
  const output = String(text || '').trimEnd();
  const start = output.lastIndexOf('\n') + 1;
  for (const candidate of [output.slice(start), output]) {
    try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch { /* try the whole output */ }
  }
  return null;
}

function runNative(root, args, { input } = {}) {
  const run = spawnSync(process.execPath, [join(root, '.harness/scripts/harness-native-stage.mjs'), ...args], {
    cwd: root, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 9 * 60 * 1000,
    env: { ...process.env, HARNESS_PROVIDER_ID: 'claude-code', HARNESS_NATIVE_ADMISSION: '', HARNESS_STAGE_EXECUTION_ID: '', HARNESS_REVIEW_EXECUTION_ID: '' },
  });
  return { status: run.status ?? 1, stdout: run.stdout || '', stderr: run.stderr || '', out: lastJson(run.stdout), err: lastJson(run.stderr), error: run.error };
}

// ---- dispatch records ---------------------------------------------------------------------------------------------------

const sessionOf = (root) => join(root, '.io');
const recordRef = (toolUseId) => `${STAGE_DISPATCH_DIRECTORY}/${toolUseId}.json`;

async function writeRecord(root, record) {
  if (!SAFE_ID.test(record.tool_use_id || '')) throw new Error('Agent tool_use_id is unavailable');
  const session = sessionOf(root), ref = recordRef(record.tool_use_id);
  await assertWorkspaceTarget(session, ref);
  await mkdir(join(session, STAGE_DISPATCH_DIRECTORY), { recursive: true, mode: 0o700 });
  const temporary = join(session, `${STAGE_DISPATCH_DIRECTORY}/.${record.tool_use_id}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ ...record, updated_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, join(session, ref));
}

function readRecords(root) {
  const directory = join(sessionOf(root), STAGE_DISPATCH_DIRECTORY);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith('.json') && !name.startsWith('.')).flatMap((name) => {
    try { return [JSON.parse(readFileSync(join(directory, name), 'utf8'))]; } catch { return []; }
  });
}

const isHarnessWorktree = (root) => existsSync(join(root, '.harness/scripts/harness-native-stage.mjs')) && existsSync(join(sessionOf(root), 'worktree.json'));

// ---- dead worker detection ---------------------------------------------------------------------------------------------------

// Claude Code keeps a project's transcripts in <config dir>/projects/<path with every non-alphanumeric character as "-">/; a
// subagent's own transcript is <session id>/subagents/agent-<agent id>.jsonl beside the session's transcript.
export const claudeProjectSlug = (path) => String(path).replace(/[^A-Za-z0-9]/g, '-');
const claudeProjectsDirectory = () => join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || '', '.claude'), 'projects');

export function workerTranscriptPath({ root, sessionId, agentId, transcriptPath = null }) {
  if (!SAFE_ID.test(sessionId || '') || !SAFE_ID.test(agentId || '')) return null;
  const file = join(sessionId, 'subagents', `agent-${agentId}.jsonl`);
  const projects = claudeProjectsDirectory();
  const bases = [];
  if (typeof transcriptPath === 'string' && transcriptPath) bases.push(dirname(transcriptPath));
  for (const directory of [root, (() => { try { return realpathSync(root); } catch { return root; } })()]) bases.push(join(projects, claudeProjectSlug(directory)));
  try { bases.push(...readdirSync(projects).map((name) => join(projects, name))); } catch { /* no projects directory */ }
  return bases.map((base) => join(base, file)).find((candidate) => existsSync(candidate)) ?? null;
}

function tailRows(path, bytes = 512 * 1024) {
  const fd = openSync(path, 'r');
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (size > length) lines.shift();
    return lines.filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  } finally { closeSync(fd); }
}

const rowText = (row) => {
  const content = row.message?.content;
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : '';
};

// -> { message } when the last assistant entry of the transcript is an API error (rate limit, overload, 5xx), else null.
export function transcriptApiError(path) {
  if (typeof path !== 'string' || !path) return null;
  try {
    const rows = tailRows(path);
    const last = rows.findLast((row) => row?.type === 'assistant' || row?.message?.role === 'assistant');
    if (!last) return null;
    const synthetic = last.message?.model === '<synthetic>' && typeof last.error === 'string';
    return last.isApiErrorMessage === true || synthetic ? { message: rowText(last).trim() || String(last.error ?? 'API error'), error: last.error ?? null } : null;
  } catch { return null; }
}

// Whether the bound worker of `record` is provably dead. Safe by construction: a live worker is never reported dead.
// Dead needs all of: an API error as the worker's last assistant entry; a transcript quiet for DEAD_WORKER_QUIET_MS;
// a dispatching session that is not the current one, or whose Agent call already returned.
export function deadWorkerEvidence({ root, record, currentSessionId = null, transcriptPath = null, now = Date.now() }) {
  if (record?.status !== 'bound' || !record.agent_id) return null;
  if ((!currentSessionId || record.session_id === currentSessionId) && !record.agent_returned_at) return null;
  const path = workerTranscriptPath({ root, sessionId: record.session_id, agentId: record.agent_id, transcriptPath });
  const error = path && transcriptApiError(path);
  if (!error) return null;
  let quiet;
  try { quiet = now - statSync(path).mtimeMs; } catch { return null; }
  if (quiet <= DEAD_WORKER_QUIET_MS) return null;
  return { reason: `Worker ended on an API error: ${clipText(error.message, 300)}`, message: error.message, transcript: path };
}

const readStateSync = (root) => { try { return JSON.parse(readFileSync(join(sessionOf(root), 'runtime/orchestrator/state.json'), 'utf8')); } catch { return null; } };

// The dead worker (record and evidence) of the stage the workflow state records as running, or null.
export function deadWorkerOfStage({ root, state = readStateSync(root), stage, currentSessionId = null, transcriptPath = null, now }) {
  const entry = state?.stages?.[stage];
  if (!entry || entry.status !== 'running' || !entry.native_managed || entry.result_ref || !SAFE_ID.test(entry.execution_id || '')) return null;
  const record = readRecords(root).find((item) => item.execution_id === entry.execution_id && item.status === 'bound');
  const evidence = record && deadWorkerEvidence({ root, record, currentSessionId, transcriptPath, now });
  return evidence ? { record, ...evidence } : null;
}

export const workerApiErrorEnvelope = (record, message) => ({ status: 'error', code: WORKER_API_ERROR, stage_id: record.stage_id, execution_id: record.execution_id, error: clipText(message, 400), next: DISPATCH_AGAIN });

// Fails the worker's execution through the existing fail path and records the dispatch as failed with the envelope.
// `keepOnError` leaves the record bound when the fail path refused (admission then keeps today's refusal) and returns null.
async function failWorkerOnApiError(root, record, message, { keepOnError = false } = {}) {
  const failed = runNative(root, ['fail', '--execution-id', record.execution_id, '--reason', `Worker ended on an API error: ${clipText(message, 300).replace(/\s+/g, ' ')}`]);
  if (failed.status !== 0 && keepOnError) return null;
  const envelope = workerApiErrorEnvelope(record, message);
  await writeRecord(root, { ...record, status: 'failed', envelope, ...(failed.status === 0 ? {} : { fail_error: explain(failed) }) });
  return envelope;
}

// ---- compact refusal text -------------------------------------------------------------------------------------------------

function explain(run) {
  const payload = run.err?.error ? run.err : run.out;
  if (payload?.error && payload.code) return `${payload.error} (${payload.code}). ${payload.why || ''}${payload.next?.length ? ` Next: ${[payload.next].flat().join(' | ')}` : ''}${payload.user_decision ? ` Decision: ${payload.user_decision}` : ''}`.trim();
  if (payload) return JSON.stringify(payload);
  return `The stage command failed${run.error ? `: ${run.error.message}` : ''}${run.stderr ? `: ${run.stderr.trim().slice(-600)}` : ''}`;
}

// ---- PreToolUse(Agent) --------------------------------------------------------------------------------------------------

export { inlineSchema };

// The worker starts with its GUIDE, input and schema in the prompt (see stage-assignment.mjs).
const workerPrompt = (root, launched) => buildAssignment(root, launched, { provider: 'claude-code' });

// -> null (not a stage dispatch) | { deny: reason } | { updatedInput }
export async function admitStageDispatch(event) {
  const tool = event.tool_input || {};
  let call;
  try { call = parseStageCall(tool.prompt); } catch (error) { return { deny: `Stage dispatch refused: ${error.message}` }; }
  if (!call) return null;
  if (event.agent_id) return { deny: 'Only the main orchestrator dispatches stages.' };
  const root = typeof event.cwd === 'string' ? event.cwd : process.cwd();
  if (!isHarnessWorktree(root)) return { deny: `Stage dispatch refused: ${root} is not a Harness workflow worktree with the installed stage runner. Change to the workflow worktree first.` };
  // A worker that ended on an API error left its stage `running`: the runner fails it and launches the stage again in this call.
  let launchArgs = call.args;
  const dead = call.stage ? deadWorkerOfStage({ root, stage: call.stage, currentSessionId: event.session_id, transcriptPath: event.transcript_path }) : null;
  if (dead) {
    if (await failWorkerOnApiError(root, dead.record, dead.message, { keepOnError: true }) && !launchArgs.includes('--feedback')) launchArgs = [...launchArgs, '--feedback', DEAD_WORKER_FEEDBACK];
  }
  const launch = runNative(root, ['launch', ...launchArgs]);
  if (launch.status !== 0 || !launch.out) return { deny: `Nothing was started. ${explain(launch)}` };
  const launched = launch.out;
  if (launched.status !== 'launched') return { deny: `Nothing was started. ${JSON.stringify(launched)}` };
  const failLaunch = (reason) => { runNative(root, ['fail', '--execution-id', launched.execution_id, '--reason', reason]); return { deny: `Nothing was started: ${reason}` }; };
  if (launched.binding?.provider !== 'claude-code' || typeof launched.agent_profile !== 'string') return failLaunch('The stage binding does not belong to Claude Code.');
  try {
    await writeRecord(root, { schema_version: 1, tool_use_id: event.tool_use_id, session_id: event.session_id, stage_id: launched.stage_id, execution_id: launched.execution_id, agent_profile: launched.agent_profile, status: 'dispatched', repairs: 0 });
  } catch (error) { return failLaunch(`The stage dispatch could not be recorded: ${error.message}`); }
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(launched.binding.reasoning_effort) ? { effort: launched.binding.reasoning_effort } : {};
  const { resume, fork, fork_context, ...kept } = tool;
  let prompt;
  try { prompt = workerPrompt(root, launched); } catch (error) { return failLaunch(`The worker assignment could not be read: ${error.message}`); }
  return { updatedInput: { ...kept, description: kept.description || launched.stage_id, subagent_type: launched.agent_profile, ...(launched.binding.model ? { model: launched.binding.model } : {}), ...effort, run_in_background: false, prompt } };
}

// ---- SubagentStart ------------------------------------------------------------------------------------------------------

// -> null (not a dispatched stage worker) | { additionalContext }
export async function bindStageWorker(event) {
  if (event.hook_event_name !== 'SubagentStart' || event.parent_agent_id) return null;
  const root = typeof event.cwd === 'string' ? event.cwd : process.cwd();
  const pending = readRecords(root).filter((record) => record.status === 'dispatched' && record.session_id === event.session_id && record.agent_profile === event.agent_type);
  if (!pending.length) return null;
  if (pending.length > 1) throw new Error('More than one stage dispatch is waiting for its worker; dispatch stages one at a time');
  const [record] = pending;
  const bound = runNative(root, ['bind', '--execution-id', record.execution_id, '--agent-id', event.agent_id]);
  if (bound.status !== 0) {
    await writeRecord(root, { ...record, status: 'bind_failed', error: explain(bound) });
    throw new Error(`Could not bind ${record.execution_id} to ${event.agent_id}: ${explain(bound)}`);
  }
  await writeRecord(root, { ...record, status: 'bound', agent_id: event.agent_id });
  return { record, additionalContext: `Harness: you are the bound worker of stage ${record.stage_id} (execution ${record.execution_id}, agent_id ${event.agent_id}). Run Harness commands from ${root} as: node .harness/scripts/harness-native-command.mjs --root ${root} --execution-id ${record.execution_id} --agent-id ${event.agent_id} -- node .harness/scripts/<command> ... Your final message is your submission (one JSON object).` };
}

// ---- SubagentStop -------------------------------------------------------------------------------------------------------

function lastAssistantText(path) {
  if (typeof path !== 'string' || !path) return '';
  try {
    const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = JSON.parse(rows[i]);
      const content = row.message?.role === 'assistant' ? row.message.content : null;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : '';
      if (text.trim()) return text;
    }
  } catch { /* an unreadable transcript is the same as no message */ }
  return '';
}

// The worker's one JSON object, from its final message (bare, fenced, or with prose around it).
export function extractSubmission(message) {
  const text = String(message ?? '').trim();
  if (!text) return null;
  const candidates = [text, text.replace(/^```[a-z]*\s*\n/i, '').replace(/\n```\s*$/, '')];
  const open = text.indexOf('{'), close = text.lastIndexOf('}');
  if (open >= 0 && close > open) candidates.push(text.slice(open, close + 1));
  for (const candidate of candidates) {
    try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return candidate; } catch { /* next */ }
  }
  return null;
}

const clipText = (value, length) => String(value ?? '').length > length ? `${String(value).slice(0, length)}…` : String(value ?? '');

function repairReason(run) {
  const { out, err } = run;
  if (out?.status === 'format_error') {
    const errors = (out.errors || []).slice(0, 15).map((item) => `${item.path}: ${item.rule}${item.expected !== undefined ? ` (expected ${clipText(JSON.stringify(item.expected), 120)})` : ''}${item.missing ? ' missing' : ''}`).join('; ');
    return `Harness rejected your final message (format_error): ${errors}. Schema: ${out.schema_path}. Fix only these and reply again with the whole corrected JSON object as your final message.`;
  }
  if (out?.status === 'gate_error') {
    const errors = (out.errors || []).slice(0, 12).map((item) => typeof item === 'string' ? item : clipText(item.message || item.code ? `${item.code ? `${item.code}: ` : ''}${item.message || ''}` : JSON.stringify(item), 300)).join('; ');
    return `Harness gate ${out.gate} rejected your result: ${errors}. Instruction: ${clipText(out.instruction, 900)} The persisted rejection is in ${out.feedback_path}; read it, correct only what it names (documents under document_draft_root and the result), and reply again with the whole corrected JSON object as your final message. If an error names an earlier owner_stage, return blocked / DEPENDENCY_INCOMPLETE with result.owner_stage and result.dependency_gap instead.`;
  }
  if (out?.status === 'output_missing') return 'Harness found no recorded result. Reply with the one JSON object that matches your schema as your whole final message.';
  const steps = [err?.next].flat().filter(Boolean).filter((step) => !/^Send this|^Then run the same finish|^Then run again|finish --execution-id/.test(step));
  return `Harness refused your result (${err?.code}): ${err?.error}. ${err?.why || ''}${steps.length ? ` Do this yourself: ${steps.join(' ')}` : ''} Then reply again with the whole result JSON object as your final message.`;
}

const repairable = (run) => ['format_error', 'gate_error', 'output_missing'].includes(run.out?.status) || (run.status !== 0 && WORKER_REPAIRABLE.has(run.err?.code));

async function envelopeOf(run, record) {
  const { stageEnvelope } = await import('./stage-cli.mjs');
  const out = run.out;
  if (run.status === 0 && out?.code && out.status) return stageEnvelope(out);
  if (run.status === 0 && out?.status) {
    return { status: out.status, stage_id: record.stage_id, execution_id: record.execution_id, ...(out.review ? { review: out.review } : {}), ...(out.agent_profile ? { agent_profile: out.agent_profile, binding: out.binding } : {}), next: `${out.status} is a hand-off the orchestrator completes: follow Harness's dispatch.md section "결과 처리" (writer or independent review), then run ${NATIVE} finish --execution-id ${record.execution_id}.` };
  }
  const payload = run.err || out || {};
  return { status: 'error', code: payload.code || 'HARNESS_ERROR', stage_id: record.stage_id, execution_id: record.execution_id, error: clipText(payload.error || run.stderr || 'finish failed', 400), why: clipText(payload.why, 400), next: payload.next || payload.user_decision || `${NATIVE} inspect --execution-id ${record.execution_id}` };
}

// -> null (not a dispatched stage worker) | { block: reason } | { recorded: envelope }
export async function finishStageWorker(event) {
  if (event.hook_event_name !== 'SubagentStop') return null;
  const root = typeof event.cwd === 'string' ? event.cwd : process.cwd();
  const record = readRecords(root).find((item) => item.agent_id === event.agent_id && item.session_id === event.session_id && item.status === 'bound');
  if (!record) return null;
  const repair = async (reason) => {
    if (record.repairs >= MAX_WORKER_REPAIRS) {
      const envelope = { status: 'repair_exhausted', stage_id: record.stage_id, execution_id: record.execution_id, error: clipText(reason, 600), next: `The worker could not fix this in ${MAX_WORKER_REPAIRS} tries. Report it to the user and stop; do not edit documents or record completion yourself. If the user wants to continue: ${NATIVE} fail --execution-id ${record.execution_id} --reason 'repair exhausted', then dispatch the stage again with --feedback.` };
      await writeRecord(root, { ...record, status: 'repair_exhausted', envelope });
      return { recorded: envelope };
    }
    await writeRecord(root, { ...record, repairs: record.repairs + 1 });
    recordUnitBoundary(root, event.agent_id);
    return { block: reason };
  };
  const message = event.last_assistant_message || lastAssistantText(event.agent_transcript_path);
  const submission = extractSubmission(message);
  // An API error (usage limit, overload) ended the worker: it cannot answer a repair request, so the execution is failed here.
  const ended = submission ? null : transcriptApiError(event.agent_transcript_path || workerTranscriptPath({ root, sessionId: record.session_id, agentId: event.agent_id, transcriptPath: event.transcript_path })) ?? (API_ERROR_MESSAGE.test(message) ? { message: message.trim() } : null);
  if (ended) return { recorded: await failWorkerOnApiError(root, record, ended.message) };
  if (!submission) return repair('Your final message holds no JSON object. Reply with exactly one JSON object that matches your schema (schema_path) as your whole final message.');
  const received = runNative(root, ['receive', '--execution-id', record.execution_id, '--agent-id', event.agent_id], { input: submission });
  if (received.status !== 0) {
    const envelope = await envelopeOf(received, record);
    await writeRecord(root, { ...record, status: 'failed', envelope });
    return { recorded: envelope };
  }
  const finished = runNative(root, ['finish', '--execution-id', record.execution_id]);
  if (repairable(finished)) return repair(repairReason(finished));
  const envelope = await envelopeOf(finished, record);
  await writeRecord(root, { ...record, status: finished.status === 0 && envelope.code ? 'finished' : finished.status === 0 ? 'handoff' : 'failed', envelope });
  return { recorded: envelope };
}

// ---- PostToolUse(Agent) --------------------------------------------------------------------------------------------------

// -> null (not a stage dispatch) | the Agent tool response with the envelope as its text
export async function stageResultOutput(event) {
  const root = typeof event.cwd === 'string' ? event.cwd : process.cwd();
  if (!SAFE_ID.test(event.tool_use_id || '') || !existsSync(join(sessionOf(root), recordRef(event.tool_use_id)))) return null;
  let record = JSON.parse(await readFile(join(sessionOf(root), recordRef(event.tool_use_id)), 'utf8'));
  if (!record.envelope && record.status === 'bound') {
    // The Agent call returned without a recorded result: an API error as the worker's last entry fails it now; any other end is noted
    // so that the next dispatch of the stage can tell that this call is over.
    const path = workerTranscriptPath({ root, sessionId: record.session_id, agentId: record.agent_id, transcriptPath: event.transcript_path });
    const ended = path && transcriptApiError(path);
    if (ended) record = { ...record, envelope: await failWorkerOnApiError(root, record, ended.message), status: 'failed' };
    else await writeRecord(root, record = { ...record, agent_returned_at: new Date().toISOString() });
  }
  const envelope = record.envelope || { status: 'no_result', stage_id: record.stage_id, execution_id: record.execution_id, error: record.error || 'The worker ended without a recorded result.', next: `Check ${NATIVE} inspect --execution-id ${record.execution_id}. If the worker is gone and recorded nothing: ${NATIVE} fail --execution-id ${record.execution_id} --reason '<cause>', then dispatch the stage again with --feedback.` };
  return { ...(event.tool_response && typeof event.tool_response === 'object' ? event.tool_response : {}), content: [{ type: 'text', text: JSON.stringify(envelope) }] };
}

export const claimKey = (event) => `${event.hook_event_name}-${event.agent_id}-${createHash('sha256').update(String(event.last_assistant_message ?? '')).digest('hex').slice(0, 8)}`;
