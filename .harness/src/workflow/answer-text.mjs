// Turns what the orchestrator declares a user reply to mean (per-question choices, approve, recommended, or the stage to
// revise) into launch arguments. `answer --text` and `launch --answer-text` call this. The runner never interprets the
// words: it checks only that a matching gate or open question exists and the declared ids are valid; approval quotes are
// checked downstream against the user's real messages.
import { pendingDesignApproval, REQUIREMENTS_REVISION_STAGES, TACTICAL_DESIGN_STAGES } from './worktree-stages.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { answerConflictMessage } from './questions.mjs';
import { recheckRequirementsBeforeApproval } from './requirements-document-gate.mjs';

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

export function readWorkflowState(root) {
  const base = join(root, '.io/runtime/orchestrator');
  const workflow = readJson(join(base, 'workflow.json'));
  return workflow?.state || workflow || readJson(join(base, 'state.json'));
}

export const REPLY_INTENTS = ['approve', 'recommended'];
const optionAnswer = (option, rest = '') => `${option.label} (${option.id})${rest ? `: ${rest}` : ''}`;
const optionsOf = (question) => question.options || [];
const listOpen = (questions) => questions.map((question) => `${question.question_id} "${question.title}" (options: ${optionsOf(question).map((option) => option.id).join(', ') || 'none, free text'})`).join(' | ');
const filled = (value) => typeof value === 'string' && value.trim() !== '';

// `choices` is the orchestrator's declaration: [{question_id, option_id?, text?}], with an option id, free text, or both.
// `recommended` declares the recommended option for every open question. -> { answers } | { clarification }
export function declaredAnswers(questions, { choices = null, recommended = false, answered = [], stored = [] } = {}) {
  const open = questions.filter((question) => !answered.includes(question.question_id));
  if (!open.length) return { clarification: 'Every question already has an answer.' };
  const refused = (why) => ({ clarification: `${why} Open questions: ${listOpen(open)}.` });
  let answers;
  if (recommended) {
    const picks = open.map((question) => [question, optionsOf(question).find((option) => option.id === question.recommended_option_id)]);
    if (picks.some(([, option]) => !option)) return refused('Not every open question has a recommended option; declare a choice for each.');
    answers = picks.map(([question, option]) => ({ question_id: question.question_id, answer: optionAnswer(option) }));
  } else {
    if (choices === null) return refused("Declare which question each choice answers: JSON [{\"question_id\":\"…\",\"option_id\":\"…\"}] (or \"text\" for the user's own words).");
    let list = choices;
    if (typeof choices === 'string') { try { list = JSON.parse(choices); } catch { return refused('The choices are not valid JSON.'); } }
    if (!Array.isArray(list) || !list.length) return refused('The choices must be a non-empty JSON array.');
    answers = [];
    for (const choice of list) {
      const question = open.find((item) => item.question_id === choice?.question_id);
      if (!question || answers.some((item) => item.question_id === choice.question_id)) return refused(`${JSON.stringify(choice?.question_id ?? null)} is not an open question or is declared twice.`);
      const hasOption = choice.option_id !== undefined, hasText = filled(choice.text);
      const option = hasOption ? optionsOf(question).find((item) => item.id === choice.option_id) : null;
      if (hasOption && !option) return refused(`${JSON.stringify(choice.option_id)} is not an option of ${question.question_id}.`);
      if (!option && !hasText) return refused(`${question.question_id} needs an option_id or a text.`);
      answers.push({ question_id: question.question_id, answer: option ? optionAnswer(option, hasText ? choice.text.trim() : '') : choice.text.trim() });
    }
  }
  const conflict = answerConflictMessage(questions, [...stored.filter((item) => !answers.some((next) => next.question_id === item.question_id)), ...answers]);
  return conflict ? { clarification: conflict } : { answers };
}

// The questions the workflow is waiting on (current stage unless the caller names one), with the answers already stored.
export function waitingQuestions(root, state, stageId = null) {
  const id = stageId || state?.current_stage;
  const entry = state?.stages?.[id];
  if (!entry || entry.status !== 'waiting' || entry.code !== 'USER_DECISION_REQUIRED' || !entry.result_ref) return null;
  const path = isAbsolute(entry.result_ref) ? entry.result_ref : join(entry.result_session_directory || join(root, '.io'), entry.result_ref);
  const result = readJson(path);
  const questions = Array.isArray(result?.questions) ? result.questions : result?.result?.questions;
  if (!Array.isArray(questions) || !questions.length) return null;
  const pending = join(entry.result_session_directory || join(root, '.io'), `runtime/executions/${entry.execution_id}/pending-answers.json`);
  const stored = existsSync(pending) ? readJson(pending) : [];
  const storedAnswers = (Array.isArray(stored) ? stored : []).filter((item) => typeof item?.answer === 'string');
  return { stageId: id, entry, questions, answered: storedAnswers.map((item) => item.question_id), storedAnswers };
}

// What the orchestrator declared the reply to be: choices for a waiting question batch, `recommended`, or `approve` for
// the requirements, publication or design gate. Returns the launch arguments the existing commands already accept.
export function resolveReplyTarget(root, text, { intent = null, choices = null } = {}) {
  const state = readWorkflowState(root);
  if (!state?.stages) return { error: 'No workflow state was found in this worktree.' };
  const waiting = waitingQuestions(root, state) || Object.keys(state.stages).map((id) => waitingQuestions(root, state, id)).find(Boolean);
  if (!waiting && (intent === 'recommended' || choices !== null)) return { error: 'No stage is waiting for an answer to a question. Run harness-context.mjs for the current state.' };
  if (intent === 'approve' && waiting) return { error: `${waiting.stageId} is waiting for answers to its questions, not for an approval. Declare choices or recommended, or ask the user.` };
  if (waiting) {
    const mapped = declaredAnswers(waiting.questions, { choices, recommended: intent === 'recommended', answered: waiting.answered, stored: waiting.storedAnswers });
    if (mapped.clarification) return { stageId: waiting.stageId, clarification: mapped.clarification };
    return { stageId: waiting.stageId, args: ['--stage-id', waiting.stageId, '--answer', JSON.stringify(mapped.answers)] };
  }
  if (intent === 'approve') return resolveApproval(state, text, { root });
  return { clarification: `No question is waiting and no intent was declared. Declare approve for an approval, or revise <stage-id> for a change request. Stages that can be revised: ${revisableStages(state).join(', ') || 'none yet'}.` };
}

export function resolveApproval(state, text, { root = null } = {}) {
  const stages = state.stages;
  const done = (id) => stages[id]?.status === 'completed' && stages[id].code === 'OK' && !stages[id].stale;
  // A result an upstream rewind marked stale is waiting to run again, so its earlier start does not use up the approval.
  const started = (id) => Boolean(stages[id]?.execution_id) && !stages[id].stale && !(stages[id].status === 'failed' || stages[id].status === 'cancelled');
  const quoted = String(text).trim();
  if (done('bounded-context') && !started('domain-model')) {
    // An approval of requirements that today's rules would refuse is never recorded: it reopens requirements-fix instead.
    const recheck = root ? recheckRequirementsBeforeApproval({ root, state }) : null;
    if (recheck?.applies && !recheck.ok) return { stageId: recheck.owner_stage, args: recheck.reopen_args, reopen: 'requirements', notice: recheck.notice_ko, errors: recheck.errors };
    return { stageId: 'domain-model', args: ['--stage-id', 'domain-model', '--requirements-approved', 'true', '--approval-answer', quoted], approval: 'requirements' };
  }
  if (done('to-ticket') && !started('tracker-publish')) return { stageId: 'tracker-publish', args: ['--stage-id', 'tracker-publish', '--publication-approved', 'true', '--approval-answer', quoted], approval: 'publication' };
  const design = pendingDesignApproval(stages);
  if (design) return { stageId: design, args: ['--stage-id', design, '--design-approved', 'true', '--approval-answer', quoted], approval: 'design' };
  return { error: 'No stage is waiting for a user answer or approval. Run harness-context.mjs for the current state.' };
}

// Finished work the user may ask to change. implement-wrapper revisions need a plan and receipt, so they use launch.
const revisableStages = (state) => [...REQUIREMENTS_REVISION_STAGES, ...TACTICAL_DESIGN_STAGES, 'to-ticket'].filter((id) => state?.stages?.[id]?.execution_id);

// `revise <stage-id>`: the orchestrator names the owning stage; a revision never approves anything.
export function resolveRevision(root, text, stageId = null) {
  const state = readWorkflowState(root);
  if (!state?.stages) return { error: 'No workflow state was found in this worktree.' };
  const stages = revisableStages(state);
  if (!stages.includes(stageId)) return { clarification: `${stageId ? `${stageId} cannot be revised now.` : 'No owning stage was declared.'} Choose the stage that owns the change and declare revise <stage-id>. Stages that can be revised: ${stages.join(', ') || 'none yet'}.`, revisable_stages: stages, revision: true };
  return { stageId, args: ['--stage-id', stageId, '--user-revision', 'true', '--feedback', String(text).trim()], revision: true };
}
