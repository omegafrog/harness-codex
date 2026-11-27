// What the stage commands print for the orchestrator (harness-prepare-input.mjs, harness-native-stage.mjs,
// harness-context.mjs). The orchestrator's context grows with every byte these print, and a refusal it cannot act on
// sends it reading Harness source. So the default output holds only what the next step needs (ids, paths, status, the
// next command, and the payloads that must be relayed), `--verbose` prints the full detail, and every error names what
// happened, why, and the exact next command or the decision the user must make.
import { DESIGN_APPROVAL_CHAIN, PRE_SPEC_STAGES, REQUIREMENTS_REVISION_STAGES, TACTICAL_DESIGN_STAGES, TACTICAL_IMPLEMENTATION_STAGES } from './worktree-stages.mjs';
import { cliContext, orchestratorState } from './cli-context.mjs';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { OWNER_REQUIRED_STAGES } from './stage-reopen.mjs';
import { summarizeReplySearch } from './approval-search.mjs';
import { runtimeAgentProvider } from './agent-config.mjs';

const NATIVE = 'node .harness/scripts/harness-native-stage.mjs';
const PREPARE = 'node .harness/scripts/harness-prepare-input.mjs';
const CONTEXT = 'node .harness/scripts/harness-context.mjs';
const FEEDBACK_ARG = "--feedback '<actual reason or user instruction>'";
const USER_FEEDBACK_ARG = "--feedback '<user instruction verbatim>'";
const ANSWER_ARG = `--answer '[{"question_id":"<id from the question>","answer":"<user answer>"}]'`;
const NO_SOURCE = 'Do not read Harness source or state files to diagnose this; follow the next step or report this error to the user.';

export const launchCommand = (stage, extra = '') => `${NATIVE} launch --stage-id ${stage}${extra ? ` ${extra}` : ''}`;
export const nativeCommand = (action, executionId, extra = '') => `${NATIVE} ${action} --execution-id ${executionId}${extra ? ` ${extra}` : ''}`;
export const nativeReceiveCommand = (executionId, agentId) => nativeCommand('receive', executionId, `--agent-id '${agentId.replaceAll("'", "'\\''")}'`);
export const contextCommand = () => CONTEXT;

// How the orchestrator starts a stage's worker. A Codex start that omits `fork_turns: "none"` (or forks the parent history)
// is denied by the Harness fresh-agent hook before anything starts, so the instruction states it in the launch result.
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
export function spawnInstruction({ agent_profile: profile, binding, assignment_path: assignment } = {}) {
  const name = profile || 'workflow_stage';
  if (binding?.provider === 'claude-code') {
    // Claude Code's Agent tool takes the model and the effort of the binding; without them the worker inherits the session's.
    const effort = CLAUDE_EFFORTS.has(binding.reasoning_effort) ? `, effort: "${binding.reasoning_effort}"` : '';
    const model = binding.model ? `, model: "${binding.model}"` : '';
    return `Start a fresh Agent with subagent_type "${name}"${model}${effort} and without the parent conversation, in the foreground (run_in_background: false); do not end your turn until it returns`;
  }
  const pass = assignment ? '; give the worker only assignment_path (it holds the guide, input, schema and references) with workspace_root, execution_id, agent_id and receive_command' : '';
  return `spawn_agent {agent_type: "${name}", fork_turns: "none"} with the binding's model and reasoning_effort${pass}; a start without fork_turns: "none" is denied and starts nothing, so repeat it`;
}

export function launchAttemptDirectory(attemptId) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(attemptId || '')) throw new Error('Invalid native launch attempt ID');
  return `runtime/launch-attempts/${attemptId}`;
}

export function launchChildError({ phase, missingResult, command, preparedExecutionId, canStart, explained, evidenceError }) {
  const outcome = command.spawn_error ? `${command.spawn_error.code || command.spawn_error.name}: ${command.spawn_error.message}`
    : command.signal ? `signal ${command.signal}` : `exit status ${command.exit_code ?? 'unknown'}`;
  const message = `Native launch ${phase} ${missingResult ? 'returned no usable result' : 'failed'} (${outcome}).`;
  const inspect = preparedExecutionId && phase === 'start' && !canStart ? nativeCommand('inspect', preparedExecutionId) : CONTEXT;
  return {
    ...(explained || {
      error: message,
      code: missingResult ? 'LAUNCH_RESULT_MISSING' : 'LAUNCH_CHILD_FAILED',
      why: message,
      next: canStart ? [nativeCommand('start', preparedExecutionId)] : [inspect],
    }),
    ...(preparedExecutionId ? { prepared_execution_id: preparedExecutionId } : {}),
    launch_command: { ...command, ...(evidenceError ? { evidence_error: evidenceError } : {}) },
  };
}

// The feedback a taken-over stage resumes with. It is internal agent input, so it is English, and it holds no quote
// because the printed command wraps it in single quotes.
export const TAKEOVER_FEEDBACK = 'The previous run of this stage was interrupted when the conversation that started it ended, and it recorded no result. Continue from the committed documents and the previous input, and keep any answers already given.';
export const takeoverCommand = (stage) => launchCommand(stage, '--take-over true');

// The current stage is a native run that a Codex conversation started and never finished, and this conversation (Codex
// or Claude Code) did not spawn. Only that case can be taken over: this conversation cannot wait for, finish or
// reconcile an agent it did not spawn. A Claude Code caller never owns a Codex-started stage.
export function foreignRunningStage(state, sessionId = process.env.CODEX_THREAD_ID) {
  const stage = state?.current_stage;
  const entry = stage ? state.stages?.[stage] : null;
  const claudeCaller = !sessionId && runtimeAgentProvider() === 'claude-code';
  if ((!sessionId && !claudeCaller) || state?.orchestrator_provider !== 'codex' || !state.orchestrator_session_id || state.orchestrator_session_id === sessionId) return null;
  if (!entry || entry.status !== 'running' || !entry.native_managed || entry.result_ref) return null;
  return { stage, entry, owner: state.orchestrator_session_id };
}

export const takeoverStep = ({ stage, owner }) => `${stage} is still recorded as running by another conversation (${owner}). Do not send the user back to that conversation. If it and its agent have ended, take the stage over with ${takeoverCommand(stage)}; it checks that they ended and, if they may still be running, refuses with the next step.`;

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

const oneLine = (value, length = 160) => clip(String(value ?? '').replace(/\s+/g, ' ').trim(), length);

// What the user needs to decide, small enough that the orchestrator never opens a file to show it: the title, at most two
// context lines, the reason for the recommended option, and per option its label, one-line effect and example and whether it is the recommended one. A technology option keeps
// up to three evidence lines and a visual_direction option its preview paths, because the user cannot decide without them.
export function compactQuestions(questions, { session = null } = {}) {
  return (Array.isArray(questions) ? questions : []).map((question) => {
    const context = question.context ? [question.context.why_now, ...(question.context.settled_rules || []).slice(0, 1)].filter(Boolean).map((line) => oneLine(line)).slice(0, 2) : [];
    return {
      question_id: question.question_id,
      title: question.title,
      ...(context.length ? { context } : {}),
      ...(question.decision_kind ? { kind: question.decision_kind } : {}),
      ...(question.recommended_option_id && question.rationale ? { reason: oneLine(question.rationale) } : {}),
      options: (question.options || []).map((option) => ({
        id: option.id,
        label: option.label,
        effect: oneLine(option.effect ?? option.consequence),
        ...(option.example ? { example: oneLine(option.example) } : {}),
        ...(option.id === question.recommended_option_id ? { recommended: true } : {}),
        ...(Array.isArray(option.evidence) && option.evidence.length ? { evidence: option.evidence.slice(0, 3).map((item) => oneLine(`${item.criterion}: ${item.result} (${item.source_title}, ${item.url})`)) } : {}),
        ...(Array.isArray(option.previews) && option.previews.length ? { previews: option.previews.map(({ path, viewport }) => `${viewport}: ${session && !isAbsolute(path) ? join(session, path) : path}`) } : {}),
      })),
    };
  });
}

// Commands below are written as Codex `launch` commands. A Claude Code orchestrator runs each as one Agent call instead.
export const CLAUDE_DISPATCH_HINT = 'On Claude Code do not run a launch command: dispatch it as one Agent call (subagent_type "workflow_stage") whose prompt first line is "harness-stage: <stage> <the launch options>"; a long --feedback or the user\'s reply goes on the lines below with @body (judge the reply yourself and declare it: "harness-stage: approve" only when the user meant approval, "harness-stage: recommended" when they take the recommended option for every open question, "harness-stage: answer" with the JSON choices [{question_id, option_id or text}] on the first line below, "harness-stage: revise <owning stage-id>" for a change to finished work; if unsure ask).';
export const withDispatchHint = (payload, provider = runtimeAgentProvider()) => provider === 'claude-code' && /launch --stage-id|prepare-input\.mjs --stage-id/.test(JSON.stringify(payload)) ? { ...payload, dispatch: CLAUDE_DISPATCH_HINT } : payload;

// The orchestrator's next dispatch, in the form its provider uses: a Claude Code Agent call whose prompt the admission
// hook turns into the stage worker, or the Codex launch command.
export const stageCall = (provider, stage, extra = '') => provider === 'claude-code'
  ? `Agent(subagent_type: "workflow_stage", prompt: "harness-stage: ${stage}${extra ? ` ${extra}` : ''}")`
  : launchCommand(stage, extra);
export const answerCall = (provider, intent = null) => {
  const choices = '[{"question_id":"<id>","option_id":"<id>"}]';
  return provider === 'claude-code'
    ? `Agent(subagent_type: "workflow_stage", prompt: "harness-stage: ${intent || `answer\n${choices}`}\n<the user\'s reply verbatim>")`
    : `${NATIVE} answer --text '<the user\'s reply verbatim>'${intent ? ` --intent ${intent}` : ` --choices '${choices}'`}`;
};
// The orchestrator judges what a reply means; the runner never interprets the words.
const REPLY_INTENT_NOTE = 'Judge the meaning yourself, declare an approval only when the user meant it, always pass their words verbatim, tell the user in Korean what you processed them as, and ask when unsure.';


// prepare: the execution to start, not the stored input (that is the stage's to read, and `--verbose` prints it).
export function compactPrepared(prepared) {
  const input = prepared.input;
  if (!input?.execution_id) {
    // waiting_for_answers / waiting_for_running_stage / restart / discard results: already small, keep them and add the step.
    const { questions, answers, ...rest } = prepared;
    const waitingInstruction = prepared.clarifications?.length
      ? 'Address the user’s clarifications in chat and wait for their decisions on the outstanding questions (above).'
      : 'Ask the user the remaining questions (above) and wait for their decisions.';
    return {
      ...rest,
      ...(questions ? { questions: compactQuestions(questions) } : {}),
      ...(answers ? { answered: Array.isArray(answers) ? answers.length : Object.keys(answers).length } : {}),
      ...(prepared.waiting_for_answers ? { next: `${waitingInstruction} Then pass the user's reply verbatim: ${answerCall(runtimeAgentProvider())} (declare each choice: option_id, or text) or ${answerCall(runtimeAgentProvider(), 'recommended')} (recommended option for every open question).` } : {}),
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
    next: `${spawnInstruction({ ...started, binding })}. Then bind its real id: ${nativeCommand('bind', executionId, '--agent-id <agent_id>')}`,
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
      spawn: spawnInstruction(started),
      bind: nativeCommand('bind', executionId, '--agent-id <agent_id>'),
      finish: nativeCommand('finish', executionId),
      // A foreground Claude Agent has ended when the orchestrator learns its ID, so one command binds and finishes.
      ...(started.binding?.provider === 'claude-code' ? { after_agent: `${nativeCommand('bind', executionId, '--agent-id <agent_id>')} && ${nativeCommand('finish', executionId)}` } : {}),
    },
  };
}

// The result of a finished stage, without what the orchestrator never uses: the fields already at the top level, file
// hashes, the commit request the runner consumed and empty arrays.
// Questions are shown from the output itself (compactQuestions), so the orchestrator never opens the result file.
export function compactResult(result = {}, { session = null } = {}) {
  const { schema_version, execution_id, skill, status, code, summary, artifacts, questions, review_request, unplanned_additions, commit_request, commit_sha, owner_stage, dependency_gap, ...extra } = result;
  const out = {};
  if (summary !== undefined) out.summary = clip(summary, 4000);
  out.artifacts = (Array.isArray(artifacts) ? artifacts : []).map(({ base, path, kind }) => ({ kind, path, ...(base && base !== 'workspace' ? { base } : {}) }));
  if (Array.isArray(questions) && questions.length) {
    out.questions = compactQuestions(questions, { session });
  }
  if (review_request) out.review_request = review_request;
  if (Array.isArray(unplanned_additions) && unplanned_additions.length) out.unplanned_additions = unplanned_additions;
  if (commit_sha) out.commit_sha = commit_sha;
  if (owner_stage) out.owner_stage = owner_stage;
  if (dependency_gap) out.dependency_gap = clip(dependency_gap, 2000);
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
    const settled = entry.status === 'completed' && entry.code === 'OK' && id !== current && !entry.stale;
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

const PUBLISH_ARGS = "--publication-approved true --approval-answer '<the user's reply verbatim>'";
const REQUIREMENTS_APPROVAL_ARGS = "--requirements-approved true --approval-answer '<the user's reply verbatim>'";
const DESIGN_APPROVAL_ARGS = "--design-approved true --approval-answer '<the user's reply verbatim>'";
const APPROVAL_REPLY_INSTRUCTION = 'When asking in chat, tell the user to send a standalone `$orchestrator <approval>` (Codex) or `/orchestrator <approval>` (Claude Code) in this worktree’s owner conversation. Pass the exact reply after the command prefix. A reply collected elsewhere (an outer controller or UI form) counts only when it is sent to that conversation the same way.';
// The guard reads only the owner conversation's transcript, so an answer collected anywhere else has to be sent there.
const APPROVAL_ACCEPTED_FORMS = 'Accepted: a new message in the owner conversation, sent after the gate, as `$orchestrator <reply>` (Codex; headless: `codex exec resume <session-id> \'$orchestrator <reply>\'`) or `/orchestrator <reply>` (Claude Code), or the answer to an approval form that the owner conversation itself asked. Not accepted: a plain message without the prefix, a reply collected in another conversation (an outer controller, wrapper or UI form), the orchestrator\'s own words or a bare flag. Pass the reply after the prefix verbatim.';
const approvalRefusalWhy = (message, base, search) => {
  const tail = search ? summarizeReplySearch(search) : message.replace(/^(?:Requirements|Publication|Design) approval answer was not recorded:?\s*/, '');
  return tail ? `${base} Refused because ${tail.charAt(0).toLowerCase()}${tail.slice(1)}${/[.!?]$/.test(tail) ? '' : '.'} The full search is in \`error\`.` : base;
};
// The nearest candidate decides what the user has to do next; the refusal never asks for a different decision.
const approvalRefusalAction = (search) => {
  const near = search?.candidates?.find((candidate) => candidate.problems.length === 1 && candidate.problems[0] === 'missing_orchestrator_prefix') ?? search?.candidates?.at(-1);
  if (near?.problems?.length === 1 && near.problems[0] === 'missing_orchestrator_prefix') return `The user's exact words are already in the owner transcript as a plain message, so do not ask a new question: ask them to send the same text as \`$orchestrator ${search.wanted}\` (Claude Code: \`/orchestrator ${search.wanted}\`) in the owner conversation${search.session_id ? ` (${search.provider} session ${search.session_id})` : ''}.`;
  if (near?.problems?.includes('sent_before_gate')) return 'The matching message predates the gate, so it is not approval of the current result: show the current result and ask again.';
  if (near?.problems?.includes('other_workspace')) return 'The matching message was sent while the conversation worked in another directory: ask the user to send it again from this worktree.';
  if (search?.outcome === 'not_owner_session') return `Continue in the owner conversation${search.owner ? ` (${search.owner.provider} session ${search.owner.session_id})` : ''}; this conversation's transcript is not read.`;
  if (search?.outcome === 'no_matching_message') return `Ask the user for the approval in the owner conversation${search.session_id ? ` (${search.provider} session ${search.session_id})` : ''}; none of their messages after the gate matches the reply passed.`;
  return '';
};
export function finishNext({ status, code, stageId, executionId, ownerStage = null, staleOrder = null, requirementsPresent = true, requirementsRecheck = null, requirementsDefaults = [], designApprovalNeeded = true, provider = 'codex' }) {
  const call = (stage, extra = '') => stageCall(provider, stage, extra);
  const approvalReply = `Only after the user's own approval, in any wording, pass their reply verbatim as an approval: ${answerCall(provider, 'approve')}. ${REPLY_INTENT_NOTE}`;
  if (status === 'blocked' && code === 'DEPENDENCY_INCOMPLETE' && stageId === 'frontend-visual-review' && (!ownerStage || ownerStage === 'frontend-implementation')) return `The visual review found implementation defects. Run the frontend correction for the same ticket: ${call('frontend-implementation', "--plan <ticket-id> --feedback '<visual review findings>'")}. The correction receives the persisted review result; after it completes, rerun frontend-visual-review. Do not ask the user or use --reopen-for.`;
  if (status === 'blocked' && code === 'DEPENDENCY_INCOMPLETE' && ownerStage) return `Do not ask the user about this block. Go back to the owner automatically: ${call(ownerStage, `--reopen-for ${executionId}`)}. Follow each finish instruction during revalidation, including requirements approval after bounded-context.`;
  if (status === 'completed' && code === 'OK' && stageId === 'bounded-context' && requirementsPresent && requirementsRecheck?.applies && !requirementsRecheck.ok) return `Do not ask for the requirements approval yet: the runner rechecked requirements.md and it no longer passes the current requirements-fix rules (${requirementsRecheck.errors.length} error(s)). Tell the user in Korean, in one sentence: "${requirementsRecheck.notice_ko}" Then go back to the owner automatically: ${call('requirements-fix', `--reopen-for ${executionId}`)}. The runner hands the errors to the worker as the reason; this is not a user revision, so do not use --user-revision. Follow each finish instruction during revalidation, including requirements approval after bounded-context.`;
  if (status === 'completed' && code === 'OK' && stageId === 'bounded-context' && requirementsPresent) return `The requirements are fixed. Show the user result.summary (the approval summary) and the requirements.md path from artifacts, in Korean. Open requirements.md once and list its business rules (INV-*) and exceptions (EX-*) in the approval request under the heading "승인할 규칙", one line each, so the user can read what they approve; do not summarise them into counts.${requirementsDefaults.length ? ` The runner found ${requirementsDefaults.length} decision(s) made without asking the user (defaults_ko): show every line verbatim in the approval request under the heading "묻지 않고 정한 것", and say the user may change any of them.` : ''} Ask whether to approve before tactical design. If the user's reply carries a condition or leaves a stated undecided item open, confirm it with the user before sending it as approval. ${APPROVAL_REPLY_INSTRUCTION} ${approvalReply} (it starts domain-model with --requirements-approved true --approval-answer). ${provider === 'claude-code' ? 'For a requested change, pass the user\'s exact words as Agent(subagent_type: "workflow_stage", prompt: "harness-stage: revise <owning requirements stage-id>\\n<the user\'s change request verbatim>").' : "For a requested change, use --user-revision with the user's exact feedback at the earliest owning requirements stage."}`;
  if (status === 'completed' && code === 'OK' && TACTICAL_DESIGN_STAGES.includes(stageId) && designApprovalNeeded) {
    const target = DESIGN_APPROVAL_CHAIN[DESIGN_APPROVAL_CHAIN.indexOf(stageId) + 1];
    const change = provider === 'claude-code' ? 'pass their exact words as Agent(subagent_type: "workflow_stage", prompt: "harness-stage: revise <owning stage-id>\\n<verbatim>")' : call(stageId, "--user-revision true --feedback '<the user\'s exact words>'");
    return `${stageId} is complete. Do not start ${target} yet: it needs the user's approval of this result. Show the user result.summary and the artifact paths from artifacts, in Korean. Open this stage's section of the design document once and list every decision and interpretation it asks the user to check under the heading "확인할 결정·해석", one line each (say so if there is none). Ask whether to approve. If the user's reply carries a condition or leaves a stated undecided item open, confirm it before sending it as approval. ${APPROVAL_REPLY_INSTRUCTION} ${approvalReply} (it starts ${target} with --design-approved true --approval-answer). A change request is not approval: ${change}.`;
  }
  if (status === 'completed' && stageId === 'to-ticket') return `Show the user result.summary (the plan set summary) and the plan paths from artifacts, in Korean, and ask whether to publish it. ${APPROVAL_REPLY_INSTRUCTION} ${approvalReply} (it starts tracker-publish with --publication-approved true --approval-answer).`;
  if (status === 'completed' && ['tracker-publish', 'tactical-code'].includes(stageId)) return `Show result.summary and all artifact paths in Korean, including the ticket outcome when available. Ask for approval and wait; do not take another ticket or run completion before approval. Route approval with ${answerCall(provider, 'approve')}, which selects the next ticket or completion step.`;
  if (status === 'completed') {
    return `Show result.summary and all artifact paths in Korean. Ask for approval and wait; do not start another stage before approval. Route approval with ${answerCall(provider, 'approve')}.${staleOrder?.length ? ' It routes to the earliest stale stage first.' : ''} A change request is not approval; route it to the owning stage with the user's exact words.`;
  }
  if (code === 'USER_DECISION_REQUIRED') return `Show result.questions to the user in Korean (title, context lines, every option's label and effect, mark the recommended one) without opening any file; wait for the reply, then pass it: ${answerCall(provider)} with one declared choice per answered question (option_id, or text for their own words), ${answerCall(provider, 'recommended')} when the user takes the recommended option for every open question. ${REPLY_INTENT_NOTE}`;
  if (code === 'REVIEW_REQUIRED') return `Run the independent review named in result.review_request, then ${call(stageId, "--feedback '<review result>'")}`;
  const revision = { SPEC_REVISION_REQUIRED: 'requirements-fix', PLAN_REVISION_REQUIRED: 'to-ticket', IMPLEMENTATION_REVISION_REQUIRED: 'implement-wrapper' }[code];
  if (revision) return `Return to its owner: ${call(revision, revision === 'implement-wrapper' ? '--plan <plan-id>' : '')}`.trim();
  if (status === 'blocked' && ENVIRONMENT_BLOCK_CODES.has(code)) return `${environmentRetry(stageId, { status, code }).steps[0]} (the stage re-runs its preflight; report to the user only if it is blocked again by the same cause)`;
  if (status === 'blocked') return `Report the unblock condition in result.summary to the user; once resolved: ${call(stageId, "--feedback '<how it was resolved>'")}`;
  if (status === 'failed' || status === 'cancelled') return `Report the cause; do not rerun automatically. If the user wants to continue: ${call(stageId, FEEDBACK_ARG)}`;
  return `Resolve ${executionId} per the orchestrator skill.`;
}

export function compactFinished({ envelope, stageId, executionId, staleOrder = null, requirementsPresent = true, requirementsRecheck = null, requirementsDefaults = [], designApprovalNeeded = true, resultPath = null, session = null, provider = 'codex' }) {
  return {
    status: envelope.status,
    code: envelope.code,
    execution_id: executionId,
    stage_id: stageId,
    result_ref: envelope.result_ref,
    result: compactResult(envelope.result, { session }),
    next: finishNext({ status: envelope.status, code: envelope.code, stageId, executionId, ownerStage: envelope.result?.owner_stage || null, staleOrder, requirementsPresent, requirementsRecheck, requirementsDefaults, designApprovalNeeded, provider }),
    ...(requirementsDefaults.length && !(requirementsRecheck?.applies && !requirementsRecheck.ok) ? { defaults_ko: requirementsDefaults } : {}),
  };
}

// The approval gates keep a longer summary: it is what the user approves, so the orchestrator never opens the document.
const APPROVAL_GATES = new Set(['bounded-context', 'to-ticket', ...TACTICAL_DESIGN_STAGES]);
// Other stages' worker summaries are one line of 500-600 characters; the orchestrator must see what the stage decided.
const SUMMARY_LINES = 6;
const SUMMARY_WIDTH = 1200;
const lines = (text, count, width) => String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, count).map((line) => clip(line, width));

// What the Claude Code orchestrator receives in place of the worker's final message (PostToolUse updatedToolOutput): the
// status and code, a short summary, artifact paths, compact questions and one `next` step. Nothing else is needed to go on.
export function stageEnvelope(finished) {
  const { result = {} } = finished;
  const approval = finished.status === 'completed' && APPROVAL_GATES.has(finished.stage_id);
  // A design stage's worker writes one long summary line and the user approves from it, so it keeps the wide clip.
  const summary = lines(result.summary, approval ? 12 : SUMMARY_LINES, approval && !TACTICAL_DESIGN_STAGES.includes(finished.stage_id) ? 400 : SUMMARY_WIDTH);
  return {
    status: finished.status,
    code: finished.code,
    stage_id: finished.stage_id,
    execution_id: finished.execution_id,
    ...(summary.length ? { summary } : {}),
    ...(result.artifacts?.length ? { artifacts: result.artifacts.map(({ path }) => path) } : {}),
    ...(result.questions?.length ? { questions: result.questions } : {}),
    ...(result.review_request ? { review_request: result.review_request } : {}),
    ...(result.commit_sha ? { commit_sha: result.commit_sha } : {}),
    ...(result.owner_stage ? { owner_stage: result.owner_stage } : {}),
    ...(result.dependency_gap ? { dependency_gap: clip(result.dependency_gap, 400) } : {}),
    ...(finished.stale_stages?.length ? { stale_stages: finished.stale_stages } : {}),
    next: finished.next,
  };
}

// format_error: the paths, rules and expectations go back to the same subagent, so each value is clipped.
export function formatErrorResult({ executionId, agentId, errors, schemaPath, outputPath, verbose }) {
  return {
    status: 'format_error',
    execution_id: executionId,
    errors: verbose ? errors : errors.slice(0, 20).map((item) => ({ ...item, value: clip(item.value, 300), expected: clip(item.expected, 300) })),
    ...(!verbose && errors.length > 20 ? { errors_omitted: errors.length - 20 } : {}),
    schema_path: schemaPath,
    output_path: outputPath,
    receive_command: nativeReceiveCommand(executionId, agentId),
    code: 'FORMAT_ERROR',
    why: 'The stage output does not match its schema; the stage is still running and nothing was recorded.',
    next: [
      'Send errors (path, rule, expected, value), schema_path and the exact receive_command to the same subagent. Ask it to correct its JSON and submit it for this execution; never compose or move output yourself. For a read-only subagent, relay its corrected final JSON to receive_command unchanged.',
      `Then run again: ${nativeCommand('finish', executionId)}`,
      'If the same errors come back after the rewrite, report them to the user and stop.',
    ],
  };
}

// finish found no output file for a bound worker: that is a worker that has not submitted yet, not a schema error, so
// the answer says what to wait for and how its result reaches Harness. `errors` and `receive_command` keep the format_error shape.
export function outputMissingResult({ executionId, agentId, errors, schemaPath, outputPath }) {
  const receive = nativeReceiveCommand(executionId, agentId);
  return {
    status: 'output_missing',
    execution_id: executionId,
    errors,
    schema_path: schemaPath,
    output_path: outputPath,
    receive_command: receive,
    code: 'WORKER_OUTPUT_MISSING',
    why: 'The bound worker has not submitted a result for this execution, so there is nothing to record yet. This is not a schema error: the stage is still running and nothing was recorded.',
    next: [
      'If the worker is still running, wait for its completion notice instead of polling or running finish again.',
      `A worker submits by piping its one JSON object to the receive_command on standard input. If it ended without submitting, run ${receive} from the orchestrator conversation: a completed Codex worker's final JSON is read from its own transcript. In any other case pipe that final JSON unchanged: printf %s '<final JSON>' | ${receive}`,
      `Then run: ${nativeCommand('finish', executionId)}`,
    ],
  };
}

// receive had no JSON on standard input and the bound Codex worker's own transcript gives no usable final output.
const FAIL_THEN_RELAUNCH = (executionId, stageId, reason, prefix = '') => [
  `${prefix}Record the ended worker: ${nativeCommand('fail', executionId, `--reason '${reason}'`)}`,
  `Then relaunch the same stage; it keeps its earlier answers and documents: ${launchCommand(stageId || '<stage-id>', FEEDBACK_ARG)}`,
];
export function receiveRecoveryError(kind, { executionId, stageId, agentId, detail = '' }) {
  const receive = nativeReceiveCommand(executionId, agentId);
  const finish = nativeCommand('finish', executionId);
  const cases = {
    running: {
      code: 'WORKER_NOT_FINISHED',
      why: 'The bound worker has not completed its turn, so there is no final output to record. Nothing was recorded and the stage is still running.',
      next: ['Wait for the worker\'s completion notice (do not poll).', `After it ended, run ${receive} again without piping anything: Harness reads a completed Codex worker\'s final JSON from its own transcript.`],
    },
    empty: {
      code: 'NATIVE_OUTPUT_EMPTY',
      why: `The bound worker completed its turn, but its final message holds no JSON object and it wrote no output (${detail || 'empty final message'}). Nothing was recorded and the stage is still running.`,
      next: [
        `Ask the same worker to submit its result: send it ${receive} and tell it to pipe the one JSON object matching its schema to that command on standard input.`,
        `Then run: ${finish}`,
        ...FAIL_THEN_RELAUNCH(executionId, stageId, 'Native worker completed without a JSON result', 'Only if the worker cannot be reached or ends without a result again: '),
      ],
    },
    failed: {
      code: 'WORKER_FAILED',
      why: `The bound worker's turn failed (${detail || 'no reason recorded'}), so it produced no result. Nothing was recorded and the stage is still running.`,
      next: FAIL_THEN_RELAUNCH(executionId, stageId, detail.replaceAll("'", '').slice(0, 200) || 'Native worker failed'),
    },
    interrupted: {
      code: 'WORKER_INTERRUPTED',
      why: 'The bound worker\'s turn was interrupted by the host, so it produced no result. Nothing was recorded and the stage is still running.',
      next: [`Record the interruption: ${nativeCommand('recover-interrupted', executionId)}`, `Then relaunch the same stage: ${launchCommand(stageId || '<stage-id>', FEEDBACK_ARG)}`],
    },
  };
  const explained = cases[kind];
  return { error: `receive had no JSON on standard input and the bound worker's transcript gives no usable final output (${explained.code})`, ...explained };
}

export function gateErrorResult({ gate, executionId, stage, errors, instruction, outputPath, feedbackPath, retryInput }) {
  return {
    status: 'gate_error',
    gate,
    execution_id: executionId,
    stage,
    errors,
    instruction,
    output_path: outputPath,
    feedback_path: feedbackPath,
    retry_input: retryInput,
    code: 'GATE_ERROR',
    why: 'The finished stage was rejected by its gate; nothing was committed or recorded and the stage is still running.',
    next: [
      'Use retry_input as the next input to the same subagent. It carries the persisted feedback_path and the exact gate rejection, including errors and instruction. Ask the subagent to read the feedback file and correct only the owned findings. If an error names an earlier owner_stage, the subagent must return blocked / DEPENDENCY_INCOMPLETE with result.owner_stage and result.dependency_gap pointing at that stage instead of editing its section. The orchestrator then reopens that stage itself (finish prints the command); it does not ask the user.',
      `Then run again: ${nativeCommand('finish', executionId)}`,
      'If the subagent cannot fix it after a repeat, report the errors to the user and stop; do not edit documents or record completion yourself.',
    ],
  };
}

// ---- state-aware next steps ---------------------------------------------------------------------------------------

function loadState(context) {
  try { return orchestratorState(context.root || cliContext().root); } catch { return null; }
}


// ---- blocked / DEPENDENCY_INCOMPLETE rewind -------------------------------------------------------------------------------
// A design or ticket stage blocked on upstream output is never resolved by the user or by --user-revision/--restart-requirements:
// the runner reopens the owner stage forward (--reopen-for), or, for a result without owner_stage, asks the blocked stage to name it.

const LEGACY_OWNER_FEEDBACK = "--feedback 'Re-check the blocker and return owner_stage and dependency_gap naming the earlier stage that must change.'";

function readBlockedResult(entry, root) {
  if (!entry?.result_ref) return null;
  const bases = [entry.result_session_directory, join(root, '.io')].filter(Boolean);
  for (const base of bases) {
    try { return JSON.parse(readFileSync(isAbsolute(entry.result_ref) ? entry.result_ref : join(base, entry.result_ref), 'utf8')); } catch { /* try the next base */ }
  }
  return null;
}

// The steps that handle a blocked / DEPENDENCY_INCOMPLETE `stage`, or null when it is not such a block. Never a user decision.
export function dependencyRewind(stage, entry, context = {}) {
  if (!stage || entry?.status !== 'blocked' || entry.code !== 'DEPENDENCY_INCOMPLETE' || !OWNER_REQUIRED_STAGES.includes(stage)) return null;
  let root;
  try { root = context.root || cliContext().root; } catch { root = null; }
  const owner = root ? readBlockedResult(entry, root)?.owner_stage : null;
  if (typeof owner === 'string' && owner && entry.execution_id) {
    return { steps: [launchCommand(owner, `--reopen-for ${entry.execution_id}`)], why: `${stage} is blocked on the output of ${owner}. Go back with --reopen-for; do not ask the user and do not use --user-revision or --restart-requirements.` };
  }
  return { steps: [launchCommand(stage, LEGACY_OWNER_FEEDBACK)], why: `${stage} is blocked (DEPENDENCY_INCOMPLETE) but its result names no owner_stage (recorded by an older Harness). Relaunch it so it names the owner; do not ask the user and do not use --user-revision or --restart-requirements.` };
}

// A stage blocked by the environment (renderer, tool, tracker or network precondition) is retried by relaunching it with
// feedback: the stage runs its workspace preflight again. Other stages, --user-revision and --restart cannot unblock it.
export const ENVIRONMENT_BLOCK_CODES = new Set(['ENVIRONMENT_UNAVAILABLE']);
export function environmentRetry(stage, entry) {
  if (!stage || entry?.status !== 'blocked' || !ENVIRONMENT_BLOCK_CODES.has(entry.code) || entry.stale) return null;
  return { steps: [launchCommand(stage, "--feedback '<what changed in the environment, and any user instruction given meanwhile>'")], why: `${stage} is blocked (${entry.code}). Relaunch it with --feedback: it runs its workspace preflight again. Do not start another stage, do not use --user-revision or --restart, and do not tell the user to wait. Report to the user only if the relaunch fails again with the same cause.` };
}

// Refusals the orchestrator hits while trying to go back from such a block; they point to the rewind instead of waiting.
const REWIND_REFUSAL_CODES = new Set(['STAGE_ORDER', 'PREVIOUS_RESULT_MISSING', 'PREVIOUS_UNRESOLVED', 'DEPENDENCY_INCOMPLETE', 'RESTART_REFUSED', 'USER_REVISION_REFUSED', 'REVISION_TARGET', 'REVISION_REPEATED', 'REOPEN_REFUSED', 'DISCARD_REFUSED', 'FEEDBACK_REFUSED']);

// What moves `stage`, as recorded in `entry`, forward.
function resumeStage(stage, entry, state) {
  if (!entry) return { steps: [launchCommand(stage)] };
  const rewind = !entry.stale && (dependencyRewind(stage, entry) || environmentRetry(stage, entry));
  if (rewind) return { steps: rewind.steps };
  const { status, code } = entry;
  if (entry.stale) return { steps: [`${launchCommand(stage)} (re-run in order; it receives the upstream change automatically: ${entry.stale.rerun_order.join(' → ')})`] };
  if (status === 'running') {
    const foreign = foreignRunningStage(state);
    if (foreign?.stage === stage) return { steps: [takeoverStep(foreign), ...(entry.execution_id ? [`If its state is unclear: ${nativeCommand('inspect', entry.execution_id)}`] : [])] };
    return { steps: [
      ...(entry.execution_id ? [`Wait for its native subagent to end (do not start another), then: ${nativeCommand('finish', entry.execution_id)}`, `If its state is unclear: ${nativeCommand('inspect', entry.execution_id)}`] : [`Wait for its native subagent to end, then run finish for its execution (${CONTEXT} shows it).`]),
    ] };
  }
  if (code === 'USER_DECISION_REQUIRED') return { steps: [launchCommand(stage, ANSWER_ARG)], decision: `${stage} waits for the user's answer to its question (${CONTEXT} lists stages.${stage}.questions). Show it verbatim and wait for the real answer.` };
  if (code === 'REVIEW_REQUIRED') return { steps: [`Run the independent review ${stage} asked for, then: ${launchCommand(stage, "--feedback '<review result>'")}`] };
  const revision = { SPEC_REVISION_REQUIRED: 'requirements-fix', PLAN_REVISION_REQUIRED: 'to-ticket', IMPLEMENTATION_REVISION_REQUIRED: 'implement-wrapper' }[code];
  if (revision) return { steps: [launchCommand(revision, revision === 'implement-wrapper' ? '--plan <plan-id>' : '')] };
  if (status === 'blocked') return { steps: [launchCommand(stage, "--feedback '<how the blocker was resolved>'")], decision: `${stage} is blocked (${code}). Tell the user the unblock condition from its summary (${CONTEXT}) and wait until it is resolved.` };
  if (status === 'failed' || status === 'cancelled') return { steps: [`After its native subagent has ended: ${launchCommand(stage, FEEDBACK_ARG)}`] };
  if (status === 'completed' && code === 'OK' && stage === 'tactical-code') return { steps: [`The last ticket is completed; take the next one from ready_tickets in ${CONTEXT}: ${launchCommand(stage, '--plan <ticket-id>')}`] };
  if (status === 'completed' && code === 'OK') return { steps: [`${stage} is already completed; continue with the stage after it.`] };
  return { steps: [CONTEXT] };
}

// ---- error catalogue -------------------------------------------------------------------------------------------------

const entryOf = (state, stage) => state?.stages?.[stage] ?? null;
const describe = (entry) => entry ? `${entry.status}${entry.code ? `/${entry.code}` : ''}${entry.stale ? `, stale after ${entry.stale.owner_stage} was reopened for ${entry.stale.blocked_stage}` : ''}` : 'not started';
const stageAfter = (previous) => {
  if (previous === 'workflow-compose') return PRE_SPEC_STAGES[0];
  const index = PRE_SPEC_STAGES.indexOf(previous);
  if (index >= 0) return PRE_SPEC_STAGES[index + 1] ?? TACTICAL_IMPLEMENTATION_STAGES[0];
  const flow = TACTICAL_IMPLEMENTATION_STAGES.indexOf(previous);
  return flow >= 0 ? TACTICAL_IMPLEMENTATION_STAGES[flow + 1] ?? null : null;
};
// First match wins. Every explanation returns `why` and either `next` (exact commands or steps) or `decision` (what the
// user must decide); the fallback keeps that true for errors this table does not know.
const RULES = [
  { re: /; pass --plan <ticket-id> to resume /, explain: ({ message, stage }) => ({ code: 'EXECUTION_FILE_INVALID', why: `${message.replace(/;.*$/, '')}. The interrupted run's input named the ticket, so the resumed run needs it again.`, next: [launchCommand(stage || '<stage-id>', "--plan <ticket-id> --feedback '<what to continue>'"), CONTEXT] }) },
  { re: /^(\S+) is empty \(0 bytes\)|^(\S+) is not valid JSON/, explain: ({ message, executionId, state, stage }) => {
    const file = /^(\S+) is /.exec(message)?.[1];
    const id = executionId || entryOf(state, stage)?.execution_id;
    return { code: 'EXECUTION_FILE_INVALID', why: `${file} cannot be read as JSON (${message.replace(/^\S+ /, '')}). A host that died mid-write leaves 0-byte execution files; they hold no result.`, next: [...(id ? [`If the stage is recorded as running by a closed conversation: ${takeoverCommand(stage || '<stage-id>')}`, `State: ${nativeCommand('inspect', id)}`] : [CONTEXT]), `Do not edit the file by hand; ${file} shows which file is affected.`] };
  } },
  { re: /^Stage feedback must be a regular unshared file$/, explain: ({ stage }) => ({ code: 'INVALID_ARGUMENT', why: 'Feedback must be stored in a regular file inside the workspace; linked or shared files are refused.', next: [`Write the feedback JSON to a new regular file inside the worktree, then retry ${launchCommand(stage || '<stage-id>')} with --feedback <workspace-relative-path>.`] }) },
  { re: /^Stage feedback must contain a JSON object$/, explain: ({ stage }) => ({ code: 'INVALID_ARGUMENT', why: 'The feedback file is not a JSON object.', next: [`Write a JSON object to a new regular file inside the worktree, then retry ${launchCommand(stage || '<stage-id>')} with --feedback <workspace-relative-path>.`] }) },
  { re: /^Requested stage binding cannot be verified: native attestation (completed_turn_metadata_missing|attestation_not_recorded|transcript_unavailable)$/, explain: ({ message, context }) => ({
    code: 'MODEL_BINDING_UNVERIFIED',
    why: `${message}. The requested model and effort require a completed turn from this execution's bound Codex worker.`,
    next: [`Once the bound worker's completed turn is recorded, repeat: ${nativeCommand('finish', context.executionId)}`, `If the metadata is still missing, inspect: ${nativeCommand('inspect', context.executionId)}`],
  }) },
  { re: /^Requested stage binding cannot be verified: native attestation (.+)$/, explain: ({ message, context }) => ({ code: 'MODEL_BINDING_UNVERIFIED', why: `${message}. The native stage has no valid file attestation for its observed model and effort.`, next: [nativeCommand('inspect', context.executionId)], decision: 'Do not accept or relaunch this result using transcript text. Report that the binding could not be verified and ask the user how to proceed.' }) },
  { re: /^Native subagent already served another execution/, explain: ({ context }) => ({ code: 'FRESH_AGENT_REQUIRED', why: 'Every new execution requires a fresh native worker in this provider session.', next: ['Spawn the assigned profile without forking or resuming a previous agent.', nativeCommand('bind', context.executionId, '--agent-id <new_agent_id>')] }) },
  { re: /^spec-me has been removed/, explain: ({ message }) => ({ code: 'WORKFLOW_RETIRED', why: message, next: [
    'For new-feature implementation, complete the requirements and tactical design flows, then continue with tactical-to-code.',
    `If an older spec-me stage is recorded without a result, and its native run and orchestrator session have ended, recover it with: ${PREPARE} --stage-id spec-me --discard-out-of-order true`,
  ], decision: 'Do not start or resume spec-me. Existing project Spec files are retained.' }) },
  { re: /^Result rejected: /, explain: ({ message, context }) => ({
    code: 'RESULT_REJECTED',
    why: `The output passed the schema, but the runner refused to record it (${message.replace(/^Result rejected: /, '')}). Nothing was committed or recorded and the stage is still running.`,
    next: [
      'Send this error to the same subagent unchanged and ask it to correct its output file (artifact paths, questions, review request); do not edit the output yourself.',
      `Then run again: ${nativeCommand('finish', context.executionId || '<execution_id>')}`,
    ],
    decision: 'If the same error returns after the rewrite, report it to the user and stop.',
  }) },
  { re: /^(\S+) cannot start before (\S+):|^(\S+) requires completed\/OK tactical design stage (\S+)/, explain: ({ m, message, state }) => {
    const stage = m[1] ?? m[3], required = m[2] ?? m[4];
    const resume = resumeStage(required, entryOf(state, required), state);
    return {
      code: 'STAGE_ORDER',
      why: `The requirements and tactical design flow runs in a fixed order, and ${required} is ${describe(entryOf(state, required))} (it must be completed/OK) before ${stage} may start. Your instruction to start ${stage} is stale; the flow decides.`,
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
  { re: /^DESIGN_NOT_FROZEN/, explain: ({ message }) => ({ code: 'DESIGN_NOT_FROZEN', why: `${message} The design-freeze check prevents ticket authoring until the owning design stage closes each reported gap.`, next: [launchCommand('tactical-data'), 'node .harness/scripts/harness-design-freeze-check.mjs --workspace-root <workspace root>'], decision: 'Run tactical-data so the runner can return a documented owner_stage and reopen it through the forward-revalidation path. Do not author tickets until the design-freeze check passes.' }) },
  { re: /^Dependency incomplete: (\S+)/, explain: ({ m, state }) => { const resume = resumeStage(m[1], entryOf(state, m[1]), state); return { code: 'DEPENDENCY_INCOMPLETE', why: `${m[1]} must be completed before this stage; it is ${describe(entryOf(state, m[1]))}.`, next: resume.steps, decision: resume.decision }; } },
  { re: /^User revision requires feedback for/, explain: ({ stage }) => ({ code: 'USER_REVISION_REFUSED', why: `--user-revision needs --feedback with the user's instruction verbatim and a stage that can be revised (${[...REQUIREMENTS_REVISION_STAGES, 'a tactical design stage', 'to-ticket', 'implement-wrapper'].join(', ')})${stage ? `. Requested: ${stage}` : ''}.`, next: [launchCommand(stage || '<stage-id>', `--user-revision true ${USER_FEEDBACK_ARG}`)], decision: 'If the user did not give a correction, run the stage normally.' }) },
  { re: /^Requirements revision cannot start after/, explain: ({ message }) => ({ code: 'USER_REVISION_REFUSED', why: message, decision: 'Report the published or implemented work affected by the correction to the user.' }) },
  { re: /^User revision requires the latest execution|^Stale execution input/, explain: ({ message, stage }) => ({ code: 'STAGE_ORDER', why: message, next: [CONTEXT, launchCommand(stage || '<stage-id>')] }) },
  { re: /^User revision requires a completed stage or one waiting on its question/, explain: ({ stage, state }) => ({ code: 'USER_REVISION_REFUSED', why: `${stage || 'The stage'} is ${describe(entryOf(state, stage))}; only a completed stage, or one waiting on its question, can be reopened by the user.`, next: [`To run it normally (not as a user revision): ${launchCommand(stage || '<stage-id>')}`, `To see its state: ${CONTEXT}`] }) },
  { re: /^User revision cannot start while another stage is running/, explain: ({ state }) => {
    const running = Object.entries(state?.stages || {}).find(([, entry]) => entry?.status === 'running');
    return { code: 'USER_REVISION_REFUSED', why: `${running ? `${running[0]} is still running` : 'Another stage is still running'}; a user revision cannot start until its native subagent has ended.`, next: running?.[1]?.execution_id ? [`Wait for its native subagent, then ${nativeCommand('finish', running[1].execution_id)}`, `Then repeat the same user-revision command.`] : [CONTEXT] };
  } },
  { re: /^(Implementation revision|Repair receipt|Test defect evidence|E2E repair|E2E failure|E2E request|E2E stage requires|Invalid E2E)/, explain: ({ message }) => ({ code: 'USER_REVISION_REFUSED', why: `The E2E repair or request does not satisfy its recorded evidence (${message}). These checks tie a repair to the exact failed E2E receipt and the user's approval.`, next: ['Use the failure receipt, approval answer and plan exactly as the E2E result and the user\'s own words recorded them; see orchestrator references/implementation.md.'], decision: 'If the receipt or approval no longer matches (stale commit, changed profile), report it to the user and ask whether to rerun the E2E.' }) },
  { re: /^Reopen refused: /, explain: ({ message, stage }) => ({
    code: 'REOPEN_REFUSED',
    why: `A forward reopen is allowed only for the stage that the latest blocked / DEPENDENCY_INCOMPLETE result of a later stage names as owner, before tracker-publish started (${message.replace(/^Reopen refused: /, '')}).`,
    next: [CONTEXT, `For a rollback the user asks for: ${PREPARE} --stage-id ${stage || '<stage-id>'} --restart-requirements true`],
    decision: 'If the blocked result names no valid owner, report it to the user and wait for their direction.',
  }) },
  { re: /^Workflow cannot complete: /, explain: ({ message }) => ({ code: 'STALE_STAGES', why: `${message}.`, next: [CONTEXT] }) },
  { re: /^Restart applies only to to-ticket|^A to-ticket restart|^Cannot restart|^Restart requires a (waiting|completed)|^This waiting to-ticket execution|^Archived restart|^Restart archive|^Multiple restart archives/, explain: ({ message }) => ({ code: 'RESTART_REFUSED', why: `A to-ticket restart is only valid for a waiting or failed to-ticket stage, before tracker-publish started (${message}).`, next: [CONTEXT], decision: 'Report this refusal to the user and wait for their direction; do not edit state or retry the restart.' }) },
  { re: /^Restart target must be completed/, explain: ({ stage, state }) => ({ code: 'RESTART_REFUSED', why: `${stage || 'The stage'} is ${describe(entryOf(state, stage))}; only a completed stage can be restarted, because a restart rewinds what it already wrote.`, next: [`To run it for the first time or continue it: ${launchCommand(stage || '<stage-id>')}`, `State: ${CONTEXT}`] }) },
  { re: /^Requirements restart must be requested alone/, explain: ({ stage }) => ({ code: 'RESTART_REFUSED', why: '--restart-requirements must be the only option besides --stage-id.', next: [`${PREPARE} --stage-id ${stage || '<stage-id>'} --restart-requirements true`] }) },
  { re: /^Restart requires a clean project/, explain: () => ({ code: 'RESTART_REFUSED', why: 'A restart rewinds the plan set documents and must not overwrite project changes, so the project worktree and index must be clean.', next: ['git status --short (read only) shows what is changed'], decision: 'Ask the user to commit or stash their project changes (never discard them yourself), then repeat the same restart command.' }) },
  { re: /^Restart target must be a requirements|^Later workflow stages prevent|^Restart checkpoint commit not found|^Unrelated or later commits prevent|^Previous stage is not completed|^Invalid checkpoint path/, explain: ({ message }) => ({
    code: 'RESTART_REFUSED',
    why: /Later workflow stages/.test(message) ? 'A stage after the requirements and tactical design flow has already started, so the flow can no longer be rewound without losing that work.' : /target must be a requirements/.test(message) ? 'A requirements restart applies only to the requirements and tactical design stages.' : `The restart would rewind work it cannot prove is only this flow's (${message}).`,
    next: [CONTEXT],
    decision: 'Report this refusal to the user; a restart is not possible for this workflow state, and they decide how to proceed (for example a user revision of one stage with --user-revision).',
  }) },
  { re: /^Takeover refused: |^Taking over an interrupted stage must be requested alone/, explain: ({ message, stage, context, state }) => {
    const reason = message.replace(/^Takeover refused: /, '');
    const target = stage || '<stage-id>';
    const retry = takeoverCommand(target);
    const base = { code: 'TAKEOVER_REFUSED', why: `A stage that a Codex conversation started is taken over by another conversation (Codex or Claude Code) only when that conversation and its agent provably ended, the stage recorded no result and the project tree is clean (${reason}). Nothing was changed.` };
    if (/must be requested alone/.test(message)) return { ...base, why: `${message}. Pass only --stage-id with --take-over true.`, next: [retry] };
    if (/uncommitted changes/.test(reason)) return { ...base, next: ['git status --short (read only) lists the changes'], decision: `The interrupted stage may have left these changes. Show them to the user and ask them to commit or stash what they want to keep (never discard them yourself); then repeat: ${retry}` };
    if (/wrote its output/.test(reason)) {
      const id = /finish --execution-id (\S+)/.exec(reason)?.[1] || context.executionId || entryOf(state, stage)?.execution_id;
      return { ...base, next: [id ? nativeCommand('finish', id) : `${CONTEXT} shows its execution_id; then run finish for it`] };
    }
    if (/conversation started .+ itself/.test(reason)) return { ...base, next: [CONTEXT] };
    if (/must be the current native stage|is not recorded|another stage is running/.test(reason)) return { ...base, next: [CONTEXT], decision: 'The stage is not an interrupted run this conversation can take over; read its state and continue from it, or report the refusal to the user.' };
    if (/CODEX_THREAD_ID/.test(reason)) return { ...base, decision: 'Run the command from the Codex or Claude Code conversation that orchestrates this workflow, inside this worktree (Codex sets CODEX_THREAD_ID there). If the session id cannot be found, ask the user to continue in the conversation that started the stage.' };
    if (/Claude Code session/.test(reason)) return { ...base, decision: 'Run the command from the Claude Code session that orchestrates this workflow, inside this worktree. If its session id cannot be found, ask the user to continue in the conversation that started the stage.' };
    if (/only a stage that a Codex conversation/.test(reason)) return { ...base, decision: 'Ask the user to continue in the conversation that started this stage; a stage that a Claude Code conversation started cannot be verified as ended.' };
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
      `If the user wants to change a completed stage: ${launchCommand(stage || '<stage-id>', `--user-revision true ${USER_FEEDBACK_ARG}`)} (requirements revision stages, tactical design stages, to-ticket and implement-wrapper)`,
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
        why: `${foreign.stage} is recorded as running by another conversation (${foreign.owner}); this conversation did not spawn its agent, so it cannot wait for or finish it, and the runner will not start a second run of it.`,
        next: [takeoverStep(foreign), ...(foreign.entry.execution_id ? [`If you need its state first: ${nativeCommand('inspect', foreign.entry.execution_id)}`] : [])],
      };
    }
    return {
      code: 'STAGE_RUNNING',
      why: `${stage || 'The stage'} is recorded as running and its native subagent has not reported the end, so the runner will not start a second run of it.`,
      next: id ? [`Wait for the subagent to end, then: ${nativeCommand('finish', id)}`, `Unsure whether it is alive: ${nativeCommand('inspect', id)}`, `Only after the host reports the agent failed or was cancelled: ${nativeCommand('fail', id, "--reason '<the actual failure>'")}`] : [CONTEXT],
    };
  } },
  { re: /^Recovery requires the original Codex parent session/, explain: () => ({ code: 'RECOVERY_SESSION_MISMATCH', why: 'Only the original Codex parent can reconcile its bound agent. Inspect the workflow for the supported next action in this conversation.', next: [CONTEXT] }) },
  { re: /^The active independent review belongs to a different stage execution$/, explain: ({ context }) => ({
    code: 'REVIEW_EXECUTION_MISMATCH',
    why: 'The active review was admitted for another execution and does not cover this stage’s current document batch.',
    next: [
      nativeCommand('inspect', context.executionId || '<execution_id>'),
      'Record the previous review in its owning execution if its reviewer finished. If the review was interrupted, abort that attempt with the owning review command and the actual reason. Then ask the current stage worker to admit a new review.',
    ],
  }) },
  { re: /^Only the bound plan or contract stage worker can request a writer before submitting its result$/, explain: ({ context }) => {
    const id = context.executionId || '<execution_id>';
    return {
      code: 'DRAFT_HANDOFF_REFUSED',
      why: 'Only the assigned to-ticket or sync-contracts worker can prepare a writer for independent review. Its final result must still be pending.',
      next: [
        nativeCommand('inspect', id),
        `If the owning worker already submitted a result, run ${nativeCommand('finish', id)}. Otherwise, only for to-ticket or sync-contracts, have the bound worker run ${nativeCommand('draft-ready', id, '--agent-id <bound_stage_agent_id>')}.`,
      ],
    };
  } },
  { re: /^Native stage must have a bound worker before assigning a writer$/, explain: ({ context }) => {
    const id = context.executionId || '<execution_id>';
    return {
      code: 'NOT_BOUND',
      why: 'The writer must receive a document batch from a bound stage worker. No worker is bound to this execution yet.',
      next: [
        nativeCommand('inspect', id),
        `Start the fresh stage worker using the launch assignment and bind its actual ID: ${nativeCommand('bind', id, '--agent-id <agent_id>')}`,
        'Wait for the bound worker’s handoff before assigning a writer.',
      ],
    };
  } },
  { re: /^Native stage must be bound to the actual subagent ID/, explain: ({ context }) => ({
    code: 'NOT_BOUND',
    why: 'finish and receive only act on the subagent that was bound to this execution, and none is bound yet: its worker was never started (a spawn the fresh-agent hook denied or that failed starts nothing) or its real agent id was not recorded. The stage is still running and nothing was recorded.',
    next: [
      'Spawn the fresh worker for this execution now. The launch output has its agent_profile, binding and guide; on Codex call spawn_agent with that agent_type and fork_turns: "none" (after a fresh-agent hook denial, repeat the same call with fork_turns: "none").',
      nativeCommand('bind', context.executionId || '<execution_id>', '--agent-id <agent_id>'),
      `Then wait for the worker and run: ${nativeCommand('finish', context.executionId || '<execution_id>')}`,
    ],
  }) },
  { re: /^Native subagent output is empty$/, explain: ({ context }) => {
    const id = context.executionId || '<execution_id>';
    return {
      code: 'RECEIVE_INPUT_EMPTY',
      why: 'receive records the subagent\'s final JSON from standard input and none arrived: the command ran without a pipe, and this conversation cannot read the worker\'s final output from its transcript instead. Nothing was recorded and the stage is still running.',
      next: [
        `If the worker already submitted its result itself, run: ${nativeCommand('finish', id)}`,
        `Otherwise relay the worker's final JSON unchanged on standard input: printf %s '<final JSON>' | ${nativeCommand('receive', id, "--agent-id '<agent_id>'")}`,
      ],
    };
  } },
  { re: /^Invalid verified native subagent rebind|^Native binding repair requires|^Existing native binding is valid|^Replacement native binding is not verified/, explain: ({ message, context }) => ({ code: 'BIND_REPAIR_REFUSED', why: `${message}. The runner only repairs an invalid binding when the current owner transcript uniquely proves the replacement worker and its requested completed model/effort.`, next: [`Inspect the unchanged stage: ${nativeCommand('inspect', context.executionId || '<execution_id>')}`, 'Do not edit workflow state or accept output from a different/unverified worker.'] }) },
  { re: /^--repair-binding true is only valid with bind/, explain: ({ message, context }) => ({ code: 'INVALID_ARGUMENT', why: `The command line was rejected (${message}).`, next: [`Use ${nativeCommand('bind', context.executionId || '<execution_id>', '--agent-id <verified-agent-id>', '--repair-binding true')} only for an invalid existing binding.`] }) },
  { re: /^Native subagent binding|^Native stage changed before terminal|^Invalid native subagent ID/, explain: ({ context }) => ({ code: 'BIND_MISMATCH', why: 'The agent id does not match the one bound to this running execution, or the stage changed while this command ran.', next: [`State and bound agent: ${nativeCommand('inspect', context.executionId || '<execution_id>')}`, 'Use the agent id returned by the spawn tool, never a guessed one.'] }) },
  { re: /^Execution input not found|^Invalid execution ID|^Duplicate execution inputs|^Execution input identity mismatch/, explain: ({ context }) => ({ code: 'INPUT_NOT_FOUND', why: `No prepared input exists for execution ${context.executionId || 'this ID'}: it was mistyped, copied wrongly, or never prepared in this worktree.`, next: [`Prepare and start the stage again and use the execution_id it prints: ${launchCommand('<stage-id>')}`, `Current state: ${CONTEXT}`] }) },
  { re: /change directory|does not match the current worktree|cannot select another workspace|^Workflow commands require a registered linked worktree|^Run this command from the target worktree/, explain: ({ message }) => {
    const target = /\(([^)]+)\)/.exec(message)?.[1];
    return { code: 'WRONG_WORKSPACE', why: 'Workflow commands run only inside the worktree that owns the workflow, and they find its root, plan set and worktree.json themselves.', next: [target ? `cd ${target}, then repeat the command without --root, --plan-set or --worktree-ref` : 'Repeat the command from the workflow worktree without --root, --plan-set or --worktree-ref'], decision: target ? undefined : 'If you do not know the worktree path, ask the user which workspace to continue in.' };
  } },
  { re: /^PERMISSION_REQUIRED: the Harness subagent hook/, explain: ({ message }) => ({ code: 'HOOK_NOT_TRUSTED', why: 'Codex stages need the Harness subagent hook to record native subagent identity, and it is missing or not trusted.', next: [], decision: `Ask the user to ${/missing/.test(message) ? 'run Harness setup with the codex provider' : 'open Codex, run /hooks and trust "Recording Harness subagent" for SubagentStart and SubagentStop'}, then repeat the command. Stages do not start without it.` }) },
  { re: /^Worktree preparation is incomplete|^Workflow composition record is missing|^Worktree record is not active|^Worktree reference does not match|^Worktree record must be|requires plan_set_id in worktree\.json/, explain: ({ message }) => ({ code: 'WORKFLOW_NOT_READY', why: `This directory is not an active, composed workflow worktree (${message}).`, next: [CONTEXT], decision: 'If workflow-compose never completed, start the workflow through the orchestrator skill (workflow-compose); otherwise report this error to the user.' }) },
  { re: /^tactical-code \S+ cannot start before its prerequisite|^Ticket \S+ is already completed/, explain: ({ message }) => ({ code: 'TICKET_ORDER', why: `tactical-code builds one published ticket per run, after the tickets it depends on are completed (${message}).`, next: [`${CONTEXT} lists ready_tickets with the tickets still open and their prerequisites`, launchCommand('tactical-code', '--plan <ticket-id>')], decision: 'Pick a ready ticket; do not start a ticket whose prerequisite is open, and do not mark a ticket completed yourself.' }) },
  { re: /^Ticket \S+ is not a frontend ticket|^Frontend implementation requires completed tracker publication|^Frontend ticket requires completed\/OK|^Frontend .+ belongs to a different ticket|^Frontend visual review does not cover the current implementation/, explain: ({ message }) => ({ code: 'FRONTEND_ORDER', why: message, next: [CONTEXT], decision: 'Use the same ready frontend ticket and finish publication, design, implementation and visual review in order.' }) },
  { re: /needs --plan|needs the assigned \S+ from its previous input|needs the assigned ticket or plan|--plan applies only|--plan needs|^Invalid plan ID|is not part of plan set/, explain: ({ message }) => ({ code: 'PLAN_ARGUMENT', why: `implement-wrapper builds exactly one plan and tactical-code exactly one ticket that you assign, and --plan must name a plan file of this plan set (${message}).`, next: [`${CONTEXT} lists plans, ready_tickets, plan_tickets and implementation_reviews; pick the next ready one from there`, launchCommand('tactical-code', '--plan <ticket-id>')] }) },
  { re: /^Completed to-ticket and user publication approval|^Publication approval is only valid|^publication-approved must be|^Publication approval answer was not recorded/, explain: ({ message, error }) => ({ code: 'PRECONDITION', why: approvalRefusalWhy(message, 'tracker-publish needs a completed to-ticket and the user\'s own approval of the reviewed plan set: the reply must match a user message or form answer in the provider transcript after to-ticket finished. The orchestrator\'s words or a bare flag are not approval.', error?.approval_search), next: [], decision: `Show the whole reviewed plan set to the user and ask whether to publish it. ${APPROVAL_REPLY_INSTRUCTION} ${APPROVAL_ACCEPTED_FORMS} ${approvalRefusalAction(error?.approval_search)} Only after the user replies, pass that reply verbatim: ${launchCommand('tracker-publish', PUBLISH_ARGS)}`.replace(/\s{2,}/g, ' '), approval_search: error?.approval_search }) },
  { re: /^Requirements recheck required before approval: bounded-context (\S+)/, explain: ({ m, error }) => ({ code: 'REQUIREMENTS_RECHECK', why: 'The fixed requirements.md no longer passes the current requirements-fix rules, so the approval was not recorded and domain-model did not start. The errors are in `error`.', next: [launchCommand('requirements-fix', `--reopen-for ${m[1]}`)], decision: `Tell the user in Korean, in one sentence: "${error?.requirements_recheck?.notice_ko ?? '요구사항 문서가 현재 검증 기준을 충족하지 못해, 승인을 묻기 전에 요구사항 작성 단계를 먼저 다시 엽니다.'}" Then run the next command; do not ask for the approval again until requirements-fix and bounded-context finish.` }) },
  { re: /^Design approval answer was not recorded|^Design approval is only valid|^design-approved must be/, explain: ({ message, error }) => ({ code: 'PRECONDITION', why: approvalRefusalWhy(message, 'A tactical design stage and tactical-technology start only after the user approved the previous design stage\'s current result: the reply must match a user message or form answer in the provider transcript after that stage finished. The orchestrator\'s words or a bare flag are not approval.', error?.approval_search), next: [], decision: `Show the previous design stage's summary, document path and the decisions it asks the user to check, in Korean, and ask the user whether to approve it. ${APPROVAL_REPLY_INSTRUCTION} ${APPROVAL_ACCEPTED_FORMS} ${approvalRefusalAction(error?.approval_search)} Only after the user replies, pass that reply verbatim: ${launchCommand(error?.design_stage || '<next-stage-id>', DESIGN_APPROVAL_ARGS)}`.replace(/\s{2,}/g, ' '), approval_search: error?.approval_search }) },
  { re: /^Requirements approval answer was not recorded|^Requirements approval is only valid|^requirements-approved must be/, explain: ({ message, error }) => ({ code: 'PRECONDITION', why: approvalRefusalWhy(message, 'Tactical design starts only after the user approved the fixed requirements: the reply must match a user message or form answer in the provider transcript after bounded-context finished. The orchestrator\'s words or a bare flag are not approval.', error?.approval_search), next: [], decision: `Show the fixed requirements.md to the user and ask whether to approve it. ${APPROVAL_REPLY_INSTRUCTION} ${APPROVAL_ACCEPTED_FORMS} ${approvalRefusalAction(error?.approval_search)} Only after the user replies, pass that reply verbatim: ${launchCommand('domain-model', REQUIREMENTS_APPROVAL_ARGS)}`.replace(/\s{2,}/g, ' '), approval_search: error?.approval_search }) },
  { re: /^The reply for --answer-text must not be empty|^Usage: harness-native-stage\.mjs answer --text|^--intent must be |^--choices needs|^--revise-stage goes/, explain: () => ({ code: 'ANSWER_REFUSED', why: 'The answer command takes the user\'s reply verbatim plus the declared choices or intent.', next: ["Pass the reply: node .harness/scripts/harness-native-stage.mjs answer --text '<the user\'s reply verbatim>' (Claude Code: Agent prompt \"harness-stage: answer\" with the JSON choices on the first line below and the reply under it)"] }) },
  { re: /^Fixed requirements with domain IDs require a domain sync plan/, explain: ({ stage, context }) => ({ code: 'DOMAIN_SYNC_MISSING', why: 'bounded-context fixed requirements.md, which holds shared domain IDs, without the shared definition proposal. The stage is still running and nothing was recorded. The stage worker writes the proposal itself; the caller never runs it for the worker.', next: [`Write runtime/executions/${context.executionId || '<execution_id>'}/domain-sync-proposal.json ({"schema_version":1,"links":{},"changes":[]} when no shared definition changes; otherwise the links and changes of GUIDE step 9). Optionally preview the plan with HARNESS_STAGE_EXECUTION_ID=${context.executionId || '<execution_id>'} node .harness/scripts/harness-domain.mjs sync plan <plan-set-id> <workspace-relative proposal path>; finish computes and stores the plan from the proposal.`, 'Then submit the same result JSON again.'], decision: 'If the worker cannot write the proposal after a repeat, report the error to the user and stop; do not write it yourself.' }) },
  { re: /^Completed (\S+) result is required for implementation/, explain: ({ m }) => ({ code: 'PRECONDITION', why: `Implementation builds on the recorded result of ${m[1]}, which is not completed.`, next: [launchCommand(m[1])] }) },
  { re: /^sync-contracts starts only|^Plan PR requires|^Integration PR requires|^Pull request authoring requires/, explain: ({ message }) => ({ code: 'PRECONDITION', why: `${message}. These stages only start after the stages they summarize are done.`, next: [CONTEXT], decision: 'Finish the missing earlier stage first (state shows which); if the tracker mode is not GitHub, skip the PR stages.' }) },
  { re: /^Spec review|^Plan review requires|^Review admission/, explain: ({ message }) => ({ code: 'PRECONDITION', why: `${message}. A review is tied to an admitted snapshot.`, next: [CONTEXT], decision: 'Follow the existing Spec or plan review admission for the admission step; do not invent it.' }) },
  { re: /runs in the main session|must select a (registered )?sub-agent skill|^Invalid argument|^Usage:|^Invalid native stage arguments|^Native agent ID is required|[Ff]ailure reason|^restart must be true|^user-revision must be true|^Absolute root|^Valid execution-id|^Absolute .*required/, explain: ({ message }) => ({ code: 'INVALID_ARGUMENT', why: `The command line was rejected (${message}).`, next: [`Prepare and start a sub-agent stage in one step: ${launchCommand('<stage-id>')}`, `Then: ${nativeCommand('bind', '<execution_id>', '--agent-id <agent_id>')} and ${nativeCommand('finish', '<execution_id>')}; fail/cancel also take --reason '<text>'`] }) },
  { re: /^Command failed: git |^Index already holds files|^Commit request/, explain: () => ({ code: 'COMMIT_BLOCKED', why: 'The runner commits a finished stage\'s documents itself and Git refused (a dirty index, changes outside the stage\'s files, or a hook). The orchestrator must not run git add or commit for the stage.', next: ['git status --short (read only) to see what is staged or modified'], decision: 'Report the Git problem to the user; the stage stays running until the cause is fixed, then repeat the same finish command.' }) },
  { re: /^Requested stage binding mismatch/, explain: ({ message, context }) => ({ code: 'MODEL_BINDING_MISMATCH', why: message, next: [nativeCommand('inspect', context.executionId)], decision: 'Report the model or effort mismatch to the user. Do not accept this stage result or silently substitute another model.' }) },
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
    if (m) { explained = rule.explain({ m, message, state, stage, context, error }); break; }
  }
  explained ??= FALLBACK(message);
  const current = state?.current_stage;
  const currentEntry = state?.stages?.[current];
  const rewind = REWIND_REFUSAL_CODES.has(explained.code) ? dependencyRewind(current, currentEntry, context) || environmentRetry(current, currentEntry) : null;
  if (rewind) explained = { ...explained, why: `${rewind.why} (${explained.why})`, next: rewind.steps, decision: undefined };
  const next = (explained.next || []).filter(Boolean);
  const decision = explained.decision;
  // A refusal always leaves the orchestrator a step: if no command applies it is the user's decision or a report.
  return withDispatchHint({
    error: message,
    code: explained.code,
    why: explained.why,
    ...(next.length ? { next } : {}),
    ...(decision || !next.length ? { user_decision: decision || `Report this to the user and wait for their direction. ${NO_SOURCE}` } : {}),
    ...(explained.approval_search ? { approval_search: explained.approval_search } : {}),
    ...(context.preparedExecutionId ? { prepared_execution_id: context.preparedExecutionId } : {}),
  }, state?.orchestrator_provider || undefined);
}

export function writeError(stream, error, context = {}) {
  // An error that already carries the explanation (re-thrown from a child command) is passed through unchanged.
  const payload = error?.explained ?? explainError(error, context);
  stream.write(`${JSON.stringify(payload)}\n`);
}

export { stageAfter };
