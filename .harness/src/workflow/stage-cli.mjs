// What the stage commands print for the orchestrator (harness-prepare-input.mjs, harness-native-stage.mjs,
// harness-context.mjs). The orchestrator's context grows with every byte these print, and a refusal it cannot act on
// sends it reading Harness source. So the default output holds only what the next step needs (ids, paths, status, the
// next command, and the payloads that must be relayed), `--verbose` prints the full detail, and every error names what
// happened, why, and the exact next command or the decision the user must make.
import { PRE_SPEC_STAGES } from './worktree-stages.mjs';
import { cliContext, orchestratorState } from './cli-context.mjs';

const NATIVE = 'node .codex/scripts/harness-native-stage.mjs';
const PREPARE = 'node .codex/scripts/harness-prepare-input.mjs';
const CONTEXT = 'node .codex/scripts/harness-context.mjs';
const FEEDBACK_ARG = "--feedback '<actual reason or user instruction>'";
const USER_FEEDBACK_ARG = "--feedback '<user instruction verbatim>'";
const ANSWER_ARG = `--answer '[{"question_id":"<id from the question>","answer":"<user answer>"}]'`;
const NO_SOURCE = 'Do not read Harness source or state files to diagnose this; follow the next step or report this error to the user.';

export const launchCommand = (stage, extra = '') => `${NATIVE} launch --stage-id ${stage}${extra ? ` ${extra}` : ''}`;
export const nativeCommand = (action, executionId, extra = '') => `${NATIVE} ${action} --execution-id ${executionId}${extra ? ` ${extra}` : ''}`;
export const contextCommand = () => CONTEXT;

// The feedback a taken-over stage resumes with. It is internal agent input, so it is English, and it holds no quote
// because the printed command wraps it in single quotes.
export const TAKEOVER_FEEDBACK = 'The previous run of this stage was interrupted when the Codex conversation that started it ended, and it recorded no result. Continue from the committed documents and the previous input, and keep any answers already given.';
export const takeoverCommand = (stage) => launchCommand(stage, '--take-over true');

// The current stage is a native run that another Codex conversation started and never finished. Only that case can be
// taken over: this conversation cannot wait for, finish or reconcile an agent it did not spawn.
export function foreignRunningStage(state, sessionId = process.env.CODEX_THREAD_ID) {
  const stage = state?.current_stage;
  const entry = stage ? state.stages?.[stage] : null;
  if (!sessionId || state?.orchestrator_provider !== 'codex' || !state.orchestrator_session_id || state.orchestrator_session_id === sessionId) return null;
  if (!entry || entry.status !== 'running' || !entry.native_managed || entry.result_ref) return null;
  return { stage, entry, owner: state.orchestrator_session_id };
}

export const takeoverStep = ({ stage, owner }) => `${stage} is still recorded as running by another Codex conversation (${owner}). Do not send the user back to that conversation. If it and its agent have ended, take the stage over with ${takeoverCommand(stage)}; it checks that they ended and, if they may still be running, refuses with the next step.`;

// `--verbose` is a bare flag. A following `true` is accepted so `--verbose true` also works.
export function extractVerbose(argv) {
  const args = [];
  let verbose = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--verbose') { args.push(argv[i]); continue; }
    verbose = true;
    if (argv[i + 1] === 'true') i += 1;
  }
  return { args, verbose };
}

const clip = (value, length) => typeof value === 'string' && value.length > length ? `${value.slice(0, length)}… (${value.length - length} more characters)` : value;
const sizeOf = (value) => Buffer.byteLength(JSON.stringify(value) ?? '');

// ---- compact outputs -------------------------------------------------------------------------------------------

// prepare: the execution to start, not the stored input (that is the stage's to read, and `--verbose` prints it).
export function compactPrepared(prepared) {
  const input = prepared.input;
  if (!input?.execution_id) {
    // waiting_for_answers / waiting_for_running_stage / restart / discard results: already small, keep them and add the step.
    const { questions, answers, ...rest } = prepared;
    return {
      ...rest,
      ...(questions ? { questions: questions.map(({ question_id, title }) => ({ question_id, title })) } : {}),
      ...(answers ? { answered: Array.isArray(answers) ? answers.length : Object.keys(answers).length } : {}),
      ...(prepared.waiting_for_answers ? { next: `Ask the user the remaining questions (ids above), then pass their answers: ${PREPARE} --stage-id <stage> ${ANSWER_ARG}` } : {}),
      ...(prepared.waiting_for_running_stage ? { next: `The answer is saved. Wait for the running native subagent to end, then ${nativeCommand('finish', prepared.execution_id)}; if the stage asks again, prepare it again (no new answer needed).` } : {}),
    };
  }
  const stageId = input.context?.stage_id || input.skill;
  const transition = input.context?.transition;
  return {
    status: 'prepared',
    execution_id: input.execution_id,
    stage_id: stageId,
    ...(input.skill !== stageId ? { skill: input.skill } : {}),
    ...(transition ? { from_stage: transition.from_stage, from_code: transition.code } : {}),
    ...(input.context?.plan_id ? { plan_id: input.context.plan_id } : {}),
    ...(prepared.answer !== undefined ? { answered: true } : {}),
    next: nativeCommand('start', input.execution_id),
  };
}

// start: what spawn_agent (or Agent) needs, then the bind command. The caller passed the execution ID, the sandbox follows
// from agent_profile and the workspace is the current directory, so none of them is repeated.
export function compactStarted(started, { executionId }) {
  const { workspace, sandbox, binding, execution_id, ...rest } = started;
  const { skill, ...modelBinding } = binding || {};
  return {
    ...rest,
    binding: modelBinding,
    next: `Spawn the subagent, then bind its real id: ${nativeCommand('bind', executionId, '--agent-id <agent_id>')}`,
  };
}

export function launchResult({ prepared, started }) {
  const input = prepared.input;
  const executionId = input.execution_id;
  const stageId = input.context?.stage_id || input.skill;
  const transition = input.context?.transition;
  const { execution_id, next, ...rest } = started;
  return {
    status: 'launched',
    execution_id: executionId,
    stage_id: stageId,
    ...(transition ? { from_stage: transition.from_stage, from_code: transition.code } : {}),
    ...(input.context?.plan_id ? { plan_id: input.context.plan_id } : {}),
    ...(prepared.answer !== undefined ? { answered: true } : {}),
    ...rest,
    next: {
      bind: nativeCommand('bind', executionId, '--agent-id <agent_id>'),
      finish: nativeCommand('finish', executionId),
    },
  };
}

// The result of a finished stage, without what the orchestrator never uses: the fields already at the top level, file
// hashes, the commit request the runner consumed and empty arrays.
export function compactResult(result = {}) {
  const { schema_version, execution_id, skill, status, code, summary, artifacts, questions, review_request, unplanned_additions, commit_request, commit_sha, ...extra } = result;
  const out = {};
  if (summary !== undefined) out.summary = clip(summary, 4000);
  out.artifacts = (Array.isArray(artifacts) ? artifacts : []).map(({ base, path, kind }) => ({ kind, path, ...(base && base !== 'workspace' ? { base } : {}) }));
  if (Array.isArray(questions) && questions.length) out.questions = questions;
  if (review_request) out.review_request = review_request;
  if (Array.isArray(unplanned_additions) && unplanned_additions.length) out.unplanned_additions = unplanned_additions;
  if (commit_sha) out.commit_sha = commit_sha;
  for (const [key, value] of Object.entries(extra)) {
    const size = sizeOf(value);
    out[key] = size <= 1200 ? value : `<omitted ${size} bytes; use --verbose to print it>`;
  }
  return out;
}

// harness-context: one status read of the workflow. A finished stage is one short entry; the stage that is current or
// needs attention keeps its summary, questions and execution id.
export function compactContext(context) {
  const current = context.current_stage;
  const stages = Object.fromEntries(Object.entries(context.stages || {}).map(([id, entry]) => {
    const settled = entry.status === 'completed' && entry.code === 'OK' && id !== current;
    if (settled) return [id, { status: entry.status, code: entry.code }];
    const { attempts, summary, questions, ...rest } = entry;
    return [id, { ...rest, ...(attempts > 1 ? { attempts } : {}), ...(summary ? { summary: clip(summary, 300) } : {}), ...(questions?.length ? { questions } : {}) }];
  }));
  const turn = context.orchestrator_last_turn;
  const kept = {
    ...context,
    stages,
    ...(turn ? { orchestrator_last_turn: { ...turn, message: clip(turn.message, 1500) } } : {}),
  };
  const empty = (value) => value === null || value === undefined || (Array.isArray(value) && !value.length) || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length);
  return Object.fromEntries(Object.entries(kept).filter(([, value]) => !empty(value)));
}

export function finishNext({ status, code, stageId, executionId }) {
  if (status === 'completed') return 'Continue with the next stage (orchestrator skill).';
  if (code === 'USER_DECISION_REQUIRED') return `Show result.questions to the user verbatim and wait; then ${launchCommand(stageId, ANSWER_ARG)}`;
  if (code === 'REVIEW_REQUIRED') return `Run the independent review named in result.review_request, then ${launchCommand(stageId, "--feedback '<review result>'")}`;
  const revision = { SPEC_REVISION_REQUIRED: 'spec-me', PLAN_REVISION_REQUIRED: 'to-ticket', IMPLEMENTATION_REVISION_REQUIRED: 'implement-wrapper' }[code];
  if (revision) return `Return to its owner: ${launchCommand(revision, revision === 'implement-wrapper' ? '--plan <plan-id>' : '')}`.trim();
  if (status === 'blocked') return `Report the unblock condition in result.summary to the user; once resolved: ${launchCommand(stageId, "--feedback '<how it was resolved>'")}`;
  if (status === 'failed' || status === 'cancelled') return `Report the cause; do not rerun automatically. If the user wants to continue: ${launchCommand(stageId, FEEDBACK_ARG)}`;
  return `Resolve ${executionId} per the orchestrator skill.`;
}

export function compactFinished({ envelope, stageId, executionId }) {
  return {
    status: envelope.status,
    code: envelope.code,
    execution_id: executionId,
    stage_id: stageId,
    result_ref: envelope.result_ref,
    result: compactResult(envelope.result),
    next: finishNext({ status: envelope.status, code: envelope.code, stageId, executionId }),
  };
}

// format_error: the paths, rules and expectations go back to the same subagent, so each value is clipped.
export function formatErrorResult({ executionId, errors, schemaPath, outputPath, verbose }) {
  return {
    status: 'format_error',
    execution_id: executionId,
    errors: verbose ? errors : errors.slice(0, 20).map((item) => ({ ...item, value: clip(item.value, 300), expected: clip(item.expected, 300) })),
    ...(!verbose && errors.length > 20 ? { errors_omitted: errors.length - 20 } : {}),
    schema_path: schemaPath,
    output_path: outputPath,
    code: 'FORMAT_ERROR',
    why: 'The stage output does not match its schema; the stage is still running and nothing was recorded.',
    next: [
      'Send errors (path, rule, expected, value) to the same subagent and ask it to re-read schema_path and rewrite output_path; do not edit the output yourself.',
      `Then run again: ${nativeCommand('finish', executionId)}`,
      'If the same errors come back after the rewrite, report them to the user and stop.',
    ],
  };
}

export function gateErrorResult({ gate, executionId, stage, errors, instruction, outputPath }) {
  return {
    status: 'gate_error',
    gate,
    execution_id: executionId,
    stage,
    errors,
    instruction,
    output_path: outputPath,
    code: 'GATE_ERROR',
    why: 'The finished stage was rejected by its gate; nothing was committed or recorded and the stage is still running.',
    next: [
      'Send errors to the same subagent unchanged. If an error names an earlier owner_stage, the subagent must return blocked / DEPENDENCY_INCOMPLETE pointing at that stage instead of editing its section.',
      `Then run again: ${nativeCommand('finish', executionId)}`,
      'If the subagent cannot fix it after a repeat, report the errors to the user and stop; do not edit documents or record completion yourself.',
    ],
  };
}

// ---- state-aware next steps ---------------------------------------------------------------------------------------

function loadState(context) {
  try { return orchestratorState(context.root || cliContext().root); } catch { return null; }
}

// What moves `stage`, as recorded in `entry`, forward.
function resumeStage(stage, entry, state) {
  if (!entry) return { steps: [launchCommand(stage)] };
  const { status, code } = entry;
  if (status === 'running') {
    const foreign = foreignRunningStage(state);
    if (foreign?.stage === stage) return { steps: [takeoverStep(foreign), ...(entry.execution_id ? [`If its state is unclear: ${nativeCommand('inspect', entry.execution_id)}`] : [])] };
    return { steps: [
      ...(entry.execution_id ? [`Wait for its native subagent to end (do not start another), then: ${nativeCommand('finish', entry.execution_id)}`, `If its state is unclear: ${nativeCommand('inspect', entry.execution_id)}`] : [`Wait for its native subagent to end, then run finish for its execution (${CONTEXT} shows it).`]),
    ] };
  }
  if (code === 'USER_DECISION_REQUIRED') return { steps: [launchCommand(stage, ANSWER_ARG)], decision: `${stage} waits for the user's answer to its question (${CONTEXT} lists stages.${stage}.questions). Show it verbatim and wait for the real answer.` };
  if (code === 'REVIEW_REQUIRED') return { steps: [`Run the independent review ${stage} asked for, then: ${launchCommand(stage, "--feedback '<review result>'")}`] };
  const revision = { SPEC_REVISION_REQUIRED: 'spec-me', PLAN_REVISION_REQUIRED: 'to-ticket', IMPLEMENTATION_REVISION_REQUIRED: 'implement-wrapper' }[code];
  if (revision) return { steps: [launchCommand(revision, revision === 'implement-wrapper' ? '--plan <plan-id>' : '')] };
  if (status === 'blocked') return { steps: [launchCommand(stage, "--feedback '<how the blocker was resolved>'")], decision: `${stage} is blocked (${code}). Tell the user the unblock condition from its summary (${CONTEXT}) and wait until it is resolved.` };
  if (status === 'failed' || status === 'cancelled') return { steps: [`After its native subagent has ended: ${launchCommand(stage, FEEDBACK_ARG)}`] };
  if (status === 'completed' && code === 'OK') return { steps: [`${stage} is already completed; continue with the stage after it.`] };
  return { steps: [CONTEXT] };
}

// ---- error catalogue -------------------------------------------------------------------------------------------------

const entryOf = (state, stage) => state?.stages?.[stage] ?? null;
const describe = (entry) => entry ? `${entry.status}${entry.code ? `/${entry.code}` : ''}` : 'not started';
const stageAfter = (previous) => {
  if (previous === 'workflow-compose') return PRE_SPEC_STAGES[0];
  const index = PRE_SPEC_STAGES.indexOf(previous);
  return index >= 0 ? PRE_SPEC_STAGES[index + 1] ?? 'spec-me' : null;
};

// First match wins. Every explanation returns `why` and either `next` (exact commands or steps) or `decision` (what the
// user must decide); the fallback keeps that true for errors this table does not know.
const RULES = [
  { re: /^Result rejected: /, explain: ({ message, context }) => ({
    code: 'RESULT_REJECTED',
    why: `The output passed the schema, but the runner refused to record it (${message.replace(/^Result rejected: /, '')}). Nothing was committed or recorded and the stage is still running.`,
    next: [
      'Send this error to the same subagent unchanged and ask it to correct its output file (artifact paths, questions, review request); do not edit the output yourself.',
      `Then run again: ${nativeCommand('finish', context.executionId || '<execution_id>')}`,
    ],
    decision: 'If the same error returns after the rewrite, report it to the user and stop.',
  }) },
  { re: /^(\S+) cannot start before (\S+):/, explain: ({ m, message, state }) => {
    const [, stage, required] = m;
    const resume = resumeStage(required, entryOf(state, required), state);
    return {
      code: 'STAGE_ORDER',
      why: `The flow before spec-me runs in a fixed order, and ${required} is ${describe(entryOf(state, required))} (it must be completed/OK) before ${stage} may start. Your instruction to start ${stage} is stale; the flow decides.`,
      next: [...resume.steps, ...(/--discard-out-of-order true/.test(message) ? [`Only because ${stage} is recorded without a result (an older Harness started it out of order), once its native run has ended and its Codex session is closed: ${PREPARE} --stage-id ${stage} --discard-out-of-order true`] : [])],
      decision: resume.decision,
    };
  } },
  { re: /^Native stage is not running for this execution/, explain: ({ state, context }) => {
    const id = context.executionId;
    const found = Object.entries(state?.stages || {}).find(([, entry]) => entry?.execution_id === id)
      ?? Object.entries(state?.stages || {}).find(([, entry]) => (entry?.attempts || []).some((attempt) => attempt.execution_id === id));
    const [stage, entry] = found || [];
    if (stage && entry?.execution_id === id && entry.status !== 'running') {
      return {
        code: 'NOT_RUNNING',
        why: `Execution ${id} of ${stage} is already ${describe(entry)}; this command only applies to a running native stage, so it was probably repeated or the stage ended another way.`,
        next: [
          entry.status === 'completed' || entry.status === 'waiting' ? `Do not run it again. Its result is recorded (${describe(entry)}); continue from it per the orchestrator skill (${CONTEXT} shows the summary and questions).` : `It ended as ${describe(entry)}. If the user wants to continue: ${launchCommand(stage, FEEDBACK_ARG)}`,
        ],
      };
    }
    if (stage) {
      return { code: 'NOT_RUNNING', why: `Execution ${id} is an earlier attempt of ${stage}; a newer execution replaced it (${entry ? describe(entry) : 'unknown'}).`, next: [`Use the execution_id of the latest launch/prepare output. Current state: ${CONTEXT}`] };
    }
    return { code: 'NOT_RUNNING', why: `Execution ${id} is not the running native stage of this workflow: it was never started, was replaced, or the ID was mistyped.`, next: [`${CONTEXT} shows the current stage and its execution_id`, `To run a stage: ${launchCommand('<stage-id>')} and use the execution_id it prints`] };
  } },
  { re: /^Previous stage has no usable result(?:: (\S+) is (\w+)(?:\/(\w+))?)?/, explain: ({ m, state, stage }) => {
    const last = m[1] || state?.current_stage;
    const entry = entryOf(state, last) ?? (m[2] ? { status: m[2], code: m[3] } : null);
    const resume = last ? resumeStage(last, entry, state) : { steps: [CONTEXT] };
    return {
      code: 'PREVIOUS_RESULT_MISSING',
      why: `${stage || 'The requested stage'} continues from the workflow's current stage${last ? ` (${last}, ${describe(entry)})` : ''}, but that stage has no recorded usable result (it is running, failed, blocked or cancelled), so there is nothing to hand over. Resolve ${last || 'it'} first instead of selecting another stage.`,
      next: resume.steps,
      decision: resume.decision,
    };
  } },
  { re: /^Resolve the previous stage before selecting another(?:: (\S+) returned (\w+)\/(\w+))?/, explain: ({ m, state, stage }) => {
    const last = m[1] || state?.current_stage;
    const resume = last ? resumeStage(last, entryOf(state, last) ?? (m[2] ? { status: m[2], code: m[3] } : null), state) : { steps: [CONTEXT] };
    return { code: 'PREVIOUS_UNRESOLVED', why: `${last || 'The previous stage'} returned ${m[2] ? `${m[2]}/${m[3]}` : 'a result'} that must be handled before ${stage || 'another stage'} can start (a question to answer, a review to run, or a blocker).`, next: resume.steps, decision: resume.decision };
  } },
  { re: /^Revision must return to (\S+)/, explain: ({ m }) => ({ code: 'REVISION_TARGET', why: `The previous result asked for a revision owned by ${m[1]}, so no other stage may be prepared in between.`, next: [launchCommand(m[1], m[1] === 'implement-wrapper' ? '--plan <plan-id>' : '')] }) },
  { re: /^Revision repeated without changed evidence/, explain: ({ stage }) => ({
    code: 'REVISION_REPEATED',
    why: `${stage || 'The stage'} has already been reopened twice for the same revision request and returned an identical result both times; a third identical run would repeat the loop.`,
    next: [`If the user gives an instruction: ${launchCommand(stage || '<owner-stage>', `--user-revision true ${USER_FEEDBACK_ARG}`)}`],
    decision: 'Report to the user that this revision returned the same unresolved result twice (summary: ' + CONTEXT + ') and ask whether to give a new instruction, change the requirement, or stop. Do not retry without new evidence.',
  }) },
  { re: /^Dependency incomplete: (\S+)/, explain: ({ m, state }) => { const resume = resumeStage(m[1], entryOf(state, m[1]), state); return { code: 'DEPENDENCY_INCOMPLETE', why: `${m[1]} must be completed before this stage; it is ${describe(entryOf(state, m[1]))}.`, next: resume.steps, decision: resume.decision }; } },
  { re: /^User revision requires feedback for/, explain: ({ stage }) => ({ code: 'USER_REVISION_REFUSED', why: `--user-revision reopens a finished stage and only exists for the user's own correction, so it needs --feedback with the user's instruction verbatim, and only requirements-fix, a tactical design stage, spec-me, to-ticket or implement-wrapper can be reopened${stage ? ` (${stage} was requested)` : ''}.`, next: [launchCommand(stage || '<stage-id>', `--user-revision true ${USER_FEEDBACK_ARG}`)], decision: 'If the user did not give a correction, do not use --user-revision; run the stage normally.' }) },
  { re: /^User revision requires a completed stage or one waiting on its question/, explain: ({ stage, state }) => ({ code: 'USER_REVISION_REFUSED', why: `${stage || 'The stage'} is ${describe(entryOf(state, stage))}; only a completed stage, or one waiting on its question, can be reopened by the user.`, next: [`To run it normally (not as a user revision): ${launchCommand(stage || '<stage-id>')}`, `To see its state: ${CONTEXT}`] }) },
  { re: /^User revision cannot start while another stage is running/, explain: ({ state }) => {
    const running = Object.entries(state?.stages || {}).find(([, entry]) => entry?.status === 'running');
    return { code: 'USER_REVISION_REFUSED', why: `${running ? `${running[0]} is still running` : 'Another stage is still running'}; a user revision cannot start until its native subagent has ended.`, next: running?.[1]?.execution_id ? [`Wait for its native subagent, then ${nativeCommand('finish', running[1].execution_id)}`, `Then repeat the same user-revision command.`] : [CONTEXT] };
  } },
  { re: /^(Implementation revision|Repair receipt|Test defect evidence|E2E repair|E2E failure|E2E request|E2E stage requires|Invalid E2E)/, explain: ({ message }) => ({ code: 'USER_REVISION_REFUSED', why: `The E2E repair or request does not satisfy its recorded evidence (${message}). These checks tie a repair to the exact failed E2E receipt and the user's approval.`, next: ['Use the failure receipt, approval answer and plan exactly as the E2E result and the user\'s own words recorded them; see orchestrator references/implementation.md.'], decision: 'If the receipt or approval no longer matches (stale commit, changed profile), report it to the user and ask whether to rerun the E2E.' }) },
  { re: /^Restart applies only to to-ticket|^A to-ticket restart|^Cannot restart|^Restart requires a (waiting|completed)|^This waiting to-ticket execution|^Archived restart|^Restart archive|^Multiple restart archives/, explain: ({ message }) => ({ code: 'RESTART_REFUSED', why: `A to-ticket restart is only valid for a waiting or failed to-ticket stage after spec-me, before tracker-publish (${message}).`, next: [CONTEXT], decision: 'Report this refusal to the user and wait for their direction; do not edit state or retry the restart.' }) },
  { re: /^Restart target must be completed/, explain: ({ stage, state }) => ({ code: 'RESTART_REFUSED', why: `${stage || 'The stage'} is ${describe(entryOf(state, stage))}; only a completed stage can be restarted, because a restart rewinds what it already wrote.`, next: [`To run it for the first time or continue it: ${launchCommand(stage || '<stage-id>')}`, `State: ${CONTEXT}`] }) },
  { re: /^Requirements restart must be requested alone/, explain: ({ stage }) => ({ code: 'RESTART_REFUSED', why: '--restart-requirements must be the only option besides --stage-id.', next: [`${PREPARE} --stage-id ${stage || '<stage-id>'} --restart-requirements true`] }) },
  { re: /^Restart requires a clean project/, explain: () => ({ code: 'RESTART_REFUSED', why: 'A restart rewinds the plan set documents and must not overwrite project changes, so the project worktree and index must be clean.', next: ['git status --short (read only) shows what is changed'], decision: 'Ask the user to commit or stash their project changes (never discard them yourself), then repeat the same restart command.' }) },
  { re: /^Restart target must be a requirements|^Later workflow stages prevent|^Restart checkpoint commit not found|^Unrelated or later commits prevent|^Previous stage is not completed|^Invalid checkpoint path/, explain: ({ message }) => ({
    code: 'RESTART_REFUSED',
    why: /Later workflow stages/.test(message) ? 'A stage after the flow before spec-me has already started, so the flow can no longer be rewound without losing that work.' : /target must be a requirements/.test(message) ? 'A restart exists only for the stages before spec-me (requirements and tactical design flows).' : `The restart would rewind work it cannot prove is only this flow's (${message}).`,
    next: [CONTEXT],
    decision: 'Report this refusal to the user; a restart is not possible for this workflow state, and they decide how to proceed (for example a user revision of one stage with --user-revision).',
  }) },
  { re: /^Takeover refused: |^Taking over an interrupted stage must be requested alone/, explain: ({ message, stage, context, state }) => {
    const reason = message.replace(/^Takeover refused: /, '');
    const target = stage || '<stage-id>';
    const retry = takeoverCommand(target);
    const base = { code: 'TAKEOVER_REFUSED', why: `A stage that another Codex conversation started is taken over only when that conversation and its agent provably ended, the stage recorded no result and the project tree is clean (${reason}). Nothing was changed.` };
    if (/must be requested alone/.test(message)) return { ...base, why: `${message}. Pass only --stage-id with --take-over true.`, next: [retry] };
    if (/uncommitted changes/.test(reason)) return { ...base, next: ['git status --short (read only) lists the changes'], decision: `The interrupted stage may have left these changes. Show them to the user and ask them to commit or stash what they want to keep (never discard them yourself); then repeat: ${retry}` };
    if (/wrote its output/.test(reason)) {
      const id = /finish --execution-id (\S+)/.exec(reason)?.[1] || context.executionId || entryOf(state, stage)?.execution_id;
      return { ...base, next: [id ? nativeCommand('finish', id) : `${CONTEXT} shows its execution_id; then run finish for it`] };
    }
    if (/conversation started .+ itself/.test(reason)) {
      const id = entryOf(state, stage)?.execution_id;
      return { ...base, next: id ? [`Wait for its native subagent to end, then: ${nativeCommand('finish', id)}`, `If its state is unclear: ${nativeCommand('inspect', id)}`] : [CONTEXT] };
    }
    if (/must be the current native stage|is not recorded|another stage is running/.test(reason)) return { ...base, next: [CONTEXT], decision: 'The stage is not an interrupted run this conversation can take over; read its state and continue from it, or report the refusal to the user.' };
    if (/CODEX_THREAD_ID/.test(reason)) return { ...base, decision: 'Run the command from the Codex conversation that orchestrates this workflow (Codex sets CODEX_THREAD_ID there). If this is not a Codex CLI session, ask the user to continue in the conversation that started the stage.' };
    if (/only a stage that a Codex conversation/.test(reason)) return { ...base, decision: 'Ask the user to continue in the conversation that started this stage; another provider cannot verify that the run ended.' };
    return { ...base, next: [CONTEXT], decision: 'Report this refusal to the user and wait for their direction; do not edit state files.' };
  } },
  { re: /^Running stage cannot be verified stopped/, explain: ({ message, stage, context }) => ({
    code: context.mode === 'takeover' ? 'TAKEOVER_REFUSED' : context.mode === 'discard' ? 'DISCARD_REFUSED' : 'RESTART_REFUSED',
    why: `The runner will not ${context.mode === 'takeover' ? 'take a stage over' : 'rewind state'} while a stage's native agent may still be running (${message.replace(/^Running stage cannot be verified stopped:? ?/, '') || 'no proof that it ended'}).`,
    next: context.mode === 'takeover'
      ? [`Close the Codex conversation that started the stage (or let its agent end), then repeat the same command: ${takeoverCommand(stage || '<stage-id>')}`]
      : [`Wait for the native subagent to end, or close the orchestrator Codex session that started it, then repeat the same command.`, ...(/subagent started after the claim/.test(message) ? [`A subagent started after the claim was never bound: bind it with ${nativeCommand('bind', '<execution_id>', '--agent-id <agent_id>')} or inspect it with ${nativeCommand('inspect', '<execution_id>')}.`] : [])],
    decision: 'If you cannot establish that it ended, ask the user to close the Codex session and tell you.',
  }) },
  { re: /is not out of order|must be the current native stage|^Another stage is running|^Only a stage run by a Codex orchestrator|^Discarding requires a clean|already committed documents|is not recorded in the workflow state|^No completed stage to return to|^Discarding an out-of-order stage must be requested alone/, explain: ({ message, stage }) => ({
    code: 'DISCARD_REFUSED',
    why: `--discard-out-of-order only removes a stage that an older Harness started before the flow allowed it and that has no result (${message}).`,
    next: /alone/.test(message) ? [`${PREPARE} --stage-id ${stage || '<stage-id>'} --discard-out-of-order true`] : /not out of order/.test(message) ? [`Resume it instead: ${launchCommand(stage || '<stage-id>')}`, `Or, if the user asks to redo it: ${PREPARE} --stage-id ${stage || '<stage-id>'} --restart-requirements true`] : [CONTEXT],
    decision: /clean/.test(message) ? 'Ask the user to commit or stash project changes (never discard them yourself), then repeat the command.' : /alone|not out of order/.test(message) ? undefined : 'Report this refusal to the user and wait; do not edit state files.',
  }) },
  { re: /^Feedback requires|^Feedback target|^Invalid execution feedback/, explain: ({ stage, state }) => ({
    code: 'FEEDBACK_REFUSED',
    why: `--feedback only continues a stage that failed, was cancelled, was blocked, asked for a review or a matching revision, or was interrupted; ${stage || 'this stage'} is ${describe(entryOf(state, stage))}.`,
    next: [
      `If the user wants to change a completed stage: ${launchCommand(stage || '<stage-id>', `--user-revision true ${USER_FEEDBACK_ARG}`)} (only requirements-fix, tactical design stages, spec-me, to-ticket, implement-wrapper)`,
      `If it waits for the user's answer: ${launchCommand(stage || '<stage-id>', ANSWER_ARG)}`,
      `State: ${CONTEXT}`,
    ],
  }) },
  { re: /^User answer required|^Stage is not waiting|^Answers must be a JSON array|^Invalid, duplicate, or stale answer|^Answers for a running stage|^Conflicting deferred answer|^Recorded decision answers|^Duplicate question ID|^User answer must not be empty|^Pending response does not match|^Pending decision belongs|^Invalid deferred answers|^Deferred answers|^Pending answers/, explain: ({ message, stage }) => ({
    code: 'ANSWER_REFUSED',
    why: `The answer was not accepted (${message}). Answers must be a JSON array of {question_id, answer} using the question_id values of the stage's current question; once every answer of a batch is recorded it cannot be replaced.`,
    next: [`${CONTEXT} lists the stage's current questions (stages.${stage || '<stage-id>'}.questions)`, launchCommand(stage || '<stage-id>', ANSWER_ARG)],
    decision: /stale|Conflicting|differ/.test(message) ? 'Ask the user again for the answer to the current question; do not copy an earlier answer to a new question id.' : undefined,
  }) },
  { re: /^Native subagent status is not confirmed|^Stage already running/, explain: ({ message, stage, state }) => {
    const entry = entryOf(state, stage);
    const id = /\(execution (\S+)\)/.exec(message)?.[1] || entry?.execution_id;
    const foreign = foreignRunningStage(state);
    if (foreign) {
      return {
        code: 'STAGE_RUNNING',
        why: `${foreign.stage} is recorded as running by another Codex conversation (${foreign.owner}); this conversation did not spawn its agent, so it cannot wait for or finish it, and the runner will not start a second run of it.`,
        next: [takeoverStep(foreign), ...(foreign.entry.execution_id ? [`If you need its state first: ${nativeCommand('inspect', foreign.entry.execution_id)}`] : [])],
      };
    }
    return {
      code: 'STAGE_RUNNING',
      why: `${stage || 'The stage'} is recorded as running and its native subagent has not reported the end, so the runner will not start a second run of it.`,
      next: id ? [`Wait for the subagent to end, then: ${nativeCommand('finish', id)}`, `Unsure whether it is alive: ${nativeCommand('inspect', id)}`, `Only after the host reports the agent failed or was cancelled: ${nativeCommand('fail', id, "--reason '<the actual failure>'")}`] : [CONTEXT],
    };
  } },
  { re: /^Native stage must be bound to the actual subagent ID/, explain: ({ context }) => ({ code: 'NOT_BOUND', why: 'finish only reads the output of a subagent that was bound to the execution; the real agent id has not been recorded yet.', next: [nativeCommand('bind', context.executionId || '<execution_id>', '--agent-id <agent_id>')] }) },
  { re: /^Native subagent binding|^Native stage changed before terminal|^Invalid native subagent ID/, explain: ({ context }) => ({ code: 'BIND_MISMATCH', why: 'The agent id does not match the one bound to this running execution, or the stage changed while this command ran.', next: [`State and bound agent: ${nativeCommand('inspect', context.executionId || '<execution_id>')}`, 'Use the agent id returned by the spawn tool, never a guessed one.'] }) },
  { re: /^Execution input not found|^Invalid execution ID|^Duplicate execution inputs|^Execution input identity mismatch/, explain: ({ context }) => ({ code: 'INPUT_NOT_FOUND', why: `No prepared input exists for execution ${context.executionId || 'this ID'}: it was mistyped, copied wrongly, or never prepared in this worktree.`, next: [`Prepare and start the stage again and use the execution_id it prints: ${launchCommand('<stage-id>')}`, `Current state: ${CONTEXT}`] }) },
  { re: /change directory|does not match the current worktree|cannot select another workspace|^Workflow commands require a registered linked worktree|^Run this command from the target worktree/, explain: ({ message }) => {
    const target = /\(([^)]+)\)/.exec(message)?.[1];
    return { code: 'WRONG_WORKSPACE', why: 'Workflow commands run only inside the worktree that owns the workflow, and they find its root, plan set and worktree.json themselves.', next: [target ? `cd ${target}, then repeat the command without --root, --plan-set or --worktree-ref` : 'Repeat the command from the workflow worktree without --root, --plan-set or --worktree-ref'], decision: target ? undefined : 'If you do not know the worktree path, ask the user which workspace to continue in.' };
  } },
  { re: /^PERMISSION_REQUIRED: the Harness subagent hook/, explain: ({ message }) => ({ code: 'HOOK_NOT_TRUSTED', why: 'Codex stages need the Harness subagent hook to record native subagent identity, and it is missing or not trusted.', next: [], decision: `Ask the user to ${/missing/.test(message) ? 'run Harness setup with the codex provider' : 'open Codex, run /hooks and trust "Recording Harness subagent" for SubagentStart and SubagentStop'}, then repeat the command. Stages do not start without it.` }) },
  { re: /^Worktree preparation is incomplete|^Workflow composition record is missing|^Worktree record is not active|^Worktree reference does not match|^Worktree record must be|requires plan_set_id in worktree\.json/, explain: ({ message }) => ({ code: 'WORKFLOW_NOT_READY', why: `This directory is not an active, composed workflow worktree (${message}).`, next: [CONTEXT], decision: 'If workflow-compose never completed, start the workflow through the orchestrator skill (workflow-compose); otherwise report this error to the user.' }) },
  { re: /needs --plan|needs the assigned plan|--plan applies only|--plan needs|^Invalid plan ID|is not part of plan set/, explain: ({ message }) => ({ code: 'PLAN_ARGUMENT', why: `implement-wrapper builds exactly one plan that you assign, and --plan must name a plan file of this plan set (${message}).`, next: [`${CONTEXT} lists plans, plan_tickets and implementation_reviews; pick the next ready plan from there`, launchCommand('implement-wrapper', '--plan <plan-id>')] }) },
  { re: /^Completed to-ticket and user publication approval|^Publication approval is only valid|^publication-approved must be/, explain: () => ({ code: 'PRECONDITION', why: 'tracker-publish needs a completed to-ticket and the user\'s real approval of the plan to publish.', next: [], decision: 'Show the reviewed plan to the user and ask for publication approval; only after they approve: ' + launchCommand('tracker-publish', '--publication-approved true') }) },
  { re: /^Completed (\S+) result is required for implementation/, explain: ({ m }) => ({ code: 'PRECONDITION', why: `Implementation builds on the recorded result of ${m[1]}, which is not completed.`, next: [launchCommand(m[1])] }) },
  { re: /^sync-contracts starts only|^Plan PR requires|^Integration PR requires|^Pull request authoring requires/, explain: ({ message }) => ({ code: 'PRECONDITION', why: `${message}. These stages only start after the stages they summarize are done.`, next: [CONTEXT], decision: 'Finish the missing earlier stage first (state shows which); if the tracker mode is not GitHub, skip the PR stages.' }) },
  { re: /^Spec (review|overwrite)|^Plan review requires|^Review admission|^spec-overwrite-approved|^Spec approval requires/, explain: ({ message }) => ({ code: 'PRECONDITION', why: `${message}. Review and overwrite approvals are tied to an admitted snapshot or the user's real approval.`, next: [CONTEXT], decision: 'Follow the owning skill (spec-me / plan-review) for the admission or approval step; do not invent either.' }) },
  { re: /runs in the main session|must select a (registered )?sub-agent skill|^Invalid argument|^Usage:|^Invalid native stage arguments|^Native agent ID is required|[Ff]ailure reason|^restart must be true|^user-revision must be true|^Absolute root|^Valid execution-id|^Absolute .*required/, explain: ({ message }) => ({ code: 'INVALID_ARGUMENT', why: `The command line was rejected (${message}).`, next: [`Prepare and start a sub-agent stage in one step: ${launchCommand('<stage-id>')}`, `Then: ${nativeCommand('bind', '<execution_id>', '--agent-id <agent_id>')} and ${nativeCommand('finish', '<execution_id>')}; fail/cancel also take --reason '<text>'`] }) },
  { re: /^Command failed: git |^Index already holds files|^Commit request/, explain: () => ({ code: 'COMMIT_BLOCKED', why: 'The runner commits a finished stage\'s documents itself and Git refused (a dirty index, changes outside the stage\'s files, or a hook). The orchestrator must not run git add or commit for the stage.', next: ['git status --short (read only) to see what is staged or modified'], decision: 'Report the Git problem to the user; the stage stays running until the cause is fixed, then repeat the same finish command.' }) },
  { re: /^Skill instruction is missing|^Execution provider must match|^Invalid native stage workspace or input|^Workflow stage is ambiguous/, explain: ({ message }) => ({ code: 'INSTALL_OR_BINDING', why: `The stage cannot start with this installation or provider binding (${message}).`, next: [], decision: 'Report this to the user: the Harness installation is incomplete or was run by a different provider than the one that composed the workflow. Run Harness maintenance (update/doctor) from the orchestrator skill; do not edit files.' }) },
];

const FALLBACK = (message) => ({
  code: 'HARNESS_ERROR',
  why: `Harness refused or failed this command and has no specific recovery step for it: ${message}`,
  next: [`${CONTEXT} shows the workflow state`, NO_SOURCE],
  decision: 'If the state does not explain it, report this error to the user as written and wait for their direction.',
});

// One JSON object: `error` (what happened), `code`, `why`, and `next` (exact commands or steps) and/or `user_decision`.
export function explainError(error, context = {}) {
  const message = String(error?.message ?? error);
  const state = loadState(context);
  const stage = context.stageId;
  let explained = null;
  for (const rule of RULES) {
    const m = rule.re.exec(message);
    if (m) { explained = rule.explain({ m, message, state, stage, context }); break; }
  }
  explained ??= FALLBACK(message);
  const next = (explained.next || []).filter(Boolean);
  const decision = explained.decision;
  // A refusal always leaves the orchestrator a step: if no command applies it is the user's decision or a report.
  return {
    error: message,
    code: explained.code,
    why: explained.why,
    ...(next.length ? { next } : {}),
    ...(decision || !next.length ? { user_decision: decision || `Report this to the user and wait for their direction. ${NO_SOURCE}` } : {}),
    ...(context.preparedExecutionId ? { prepared_execution_id: context.preparedExecutionId } : {}),
  };
}

export function writeError(stream, error, context = {}) {
  // An error that already carries the explanation (re-thrown from a child command) is passed through unchanged.
  const payload = error?.explained ?? explainError(error, context);
  stream.write(`${JSON.stringify(payload)}\n`);
}

export { stageAfter };
