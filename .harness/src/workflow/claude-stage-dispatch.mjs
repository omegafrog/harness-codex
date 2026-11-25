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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { recordUnitBoundary } from './compaction-boundary.mjs';
import { stripSkillDeclaration } from './skill-declaration.mjs';

export const STAGE_DISPATCH_DIRECTORY = 'runtime/claude-dispatch';
export const MAX_WORKER_REPAIRS = 3;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// Errors a worker can fix by itself in the same turn. Anything else goes to the orchestrator with its `next`.
const WORKER_REPAIRABLE = new Set(['DOMAIN_SYNC_MISSING', 'RESULT_REJECTED']);
const NATIVE = 'node .harness/scripts/harness-native-stage.mjs';

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

// ---- compact refusal text -------------------------------------------------------------------------------------------------

function explain(run) {
  const payload = run.err?.error ? run.err : run.out;
  if (payload?.error && payload.code) return `${payload.error} (${payload.code}). ${payload.why || ''}${payload.next?.length ? ` Next: ${[payload.next].flat().join(' | ')}` : ''}${payload.user_decision ? ` Decision: ${payload.user_decision}` : ''}`.trim();
  if (payload) return JSON.stringify(payload);
  return `The stage command failed${run.error ? `: ${run.error.message}` : ''}${run.stderr ? `: ${run.stderr.trim().slice(-600)}` : ''}`;
}

// ---- PreToolUse(Agent) --------------------------------------------------------------------------------------------------

// The result schema a worker needs while it asks nothing: the two large shapes it rarely uses are named and left in the file.
export function inlineSchema(schema) {
  const copy = structuredClone(schema), result = copy.properties?.result?.properties;
  for (const key of ['questions', 'review_request']) {
    if (!result?.[key] || JSON.stringify(result[key]).length < 600) continue;
    result[key] = { description: key === 'questions' ? 'Use [] when you ask nothing. To ask, first read properties.result.properties.questions in schema_path for the item shape.' : 'Use null when you request no review. To request one, first read properties.result.properties.review_request in schema_path.' };
  }
  return copy;
}

// The worker starts with its GUIDE, input and schema in the prompt: they are fixed by the launch, so reading them would cost a
// turn and the file tool's line numbers. The paths stay for links and for the parts left out.
function workerPrompt(root, launched) {
  const guide = stripSkillDeclaration(readFileSync(launched.guide, 'utf8')).trim();
  const input = JSON.parse(readFileSync(launched.input_path, 'utf8'));
  const schema = inlineSchema(JSON.parse(readFileSync(launched.schema_path, 'utf8')));
  const lines = [
    `Run the Harness stage \`${launched.stage_id}\`.`,
    `- workspace_root: ${root}`,
    `- execution_id: ${launched.execution_id}`,
    `- guide: ${launched.guide}`,
    `- input_path: ${launched.input_path}`,
    `- schema_path: ${launched.schema_path}`,
    ...(launched.answers_path ? [`- answers_path: ${launched.answers_path}`] : []),
    ...(launched.feedback_path ? [`- feedback_path: ${launched.feedback_path}`] : []),
    ...(launched.document_draft_root ? [`- document_draft_root: ${launched.document_draft_root}`] : []),
    ...(launched.browser_environment_path ? [`- browser_environment_path: ${launched.browser_environment_path}`] : []),
    '',
    'The guide, input and schema are included below in full except where the schema says otherwise: do not read those files again. Relative links in the guide resolve from its directory. `context.workspace` in the input already holds the workspace check, the document paths and the source overview. In your first turn read every document and guide reference you need in parallel, by these paths. Write completed documents under document_draft_root at their canonical relative paths.',
    'Submission: there is no receive command and you do not bind or finish anything. Your final message must be exactly one JSON object that matches the schema, with no prose around it. Harness records it when you stop and runs the gates itself. If it answers with format or gate errors you continue: fix only what they name (read the feedback file when one is given) and reply again with the whole corrected JSON object. Run any Harness command yourself; never ask the caller to run one.',
    '', '<guide>', guide, '</guide>',
    '', '<input>', JSON.stringify(input), '</input>',
    '', '<schema>', JSON.stringify(schema), '</schema>',
  ];
  return lines.join('\n');
}

// -> null (not a stage dispatch) | { deny: reason } | { updatedInput }
export async function admitStageDispatch(event) {
  const tool = event.tool_input || {};
  let call;
  try { call = parseStageCall(tool.prompt); } catch (error) { return { deny: `Stage dispatch refused: ${error.message}` }; }
  if (!call) return null;
  if (event.agent_id) return { deny: 'Only the main orchestrator dispatches stages.' };
  const root = typeof event.cwd === 'string' ? event.cwd : process.cwd();
  if (!isHarnessWorktree(root)) return { deny: `Stage dispatch refused: ${root} is not a Harness workflow worktree with the installed stage runner. Change to the workflow worktree first.` };
  const launch = runNative(root, ['launch', ...call.args]);
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
  const record = JSON.parse(await readFile(join(sessionOf(root), recordRef(event.tool_use_id)), 'utf8'));
  const envelope = record.envelope || { status: 'no_result', stage_id: record.stage_id, execution_id: record.execution_id, error: record.error || 'The worker ended without a recorded result.', next: `Check ${NATIVE} inspect --execution-id ${record.execution_id}. If the worker is gone and recorded nothing: ${NATIVE} fail --execution-id ${record.execution_id} --reason '<cause>', then dispatch the stage again with --feedback.` };
  return { ...(event.tool_response && typeof event.tool_response === 'object' ? event.tool_response : {}), content: [{ type: 'text', text: JSON.stringify(envelope) }] };
}

export const claimKey = (event) => `${event.hook_event_name}-${event.agent_id}-${createHash('sha256').update(String(event.last_assistant_message ?? '')).digest('hex').slice(0, 8)}`;
