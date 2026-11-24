// Maps the user's raw reply onto the questions a stage is waiting for, so the orchestrator never reads the question
// file or builds an --answer JSON. `answer --text` and `launch --answer-text` call this; an ambiguous reply returns a
// short clarification request instead of a guess.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

export function readWorkflowState(root) {
  const base = join(root, '.io/runtime/orchestrator');
  const workflow = readJson(join(base, 'workflow.json'));
  return workflow?.state || workflow || readJson(join(base, 'state.json'));
}

const squash = (text) => text.toLowerCase().replace(/[\s.!~,]+/g, '');
const RECOMMENDED = /^(?:(?:모두|전부|다|전체|all)(?:를)?)?(?:추천(?:안|옵션|답|하는것|하는걸)?(?:으로|대로|그대로)?(?:모두|전부|다)?(?:진행|해줘|해주세요|해요|하세요|할게요)?|recommended(?:options?|answers?|ones?)?|usetherecommended(?:options?|answers?|ones?)?|gowithrecommended(?:options?|answers?|ones?)?|gowiththerecommended(?:options?|answers?|ones?)?)$/;
export const isRecommendedReply = (text) => RECOMMENDED.test(squash(text));

const optionAnswer = (option, rest = '') => `${option.label} (${option.id})${rest ? `: ${rest}` : ''}`;
const recommendedOption = (question) => (question.options || []).find((option) => option.id === question.recommended_option_id);

// One segment of the reply is the pick for one question: an option number, letter, id or label, or the user's own words.
function pickOption(question, segment) {
  const options = question.options || [];
  const text = segment.trim();
  if (!text) return null;
  if (isRecommendedReply(text)) { const option = recommendedOption(question); return option ? { answer: optionAnswer(option) } : null; }
  const lead = /^(?:옵션|option)?\s*(\d{1,2}|[A-Za-z])\s*(?:번|\)|\.|:)?(?=\s|,|$)\s*[,:]?\s*(.*)$/s.exec(text);
  if (lead) {
    const token = lead[1];
    const index = /^\d+$/.test(token) ? Number(token) - 1 : token.toUpperCase().charCodeAt(0) - 65;
    const byId = options.find((option) => option.id.toLowerCase() === token.toLowerCase());
    const option = byId || options[index];
    if (option && index >= 0) return { answer: optionAnswer(option, lead[2].trim()) };
  }
  const byId = options.find((option) => option.id.toLowerCase() === text.toLowerCase());
  if (byId) return { answer: optionAnswer(byId) };
  const byLabel = options.filter((option) => text.toLowerCase().includes(option.label.toLowerCase()));
  if (byLabel.length === 1) return { answer: byLabel[0].label.length >= text.length ? optionAnswer(byLabel[0]) : optionAnswer(byLabel[0], text) };
  return { answer: text, free: true };
}

// "1번 A, 2번 B", "1: B 2: A", "Q1) ... Q2) ..." markers split the reply per question.
function markedSegments(text, count) {
  const marker = /(?:^|[\s,;])(?:Q|q|질문)?\s*(\d{1,2})\s*(?:번|\)|\.|:|=|->|→)(?!\d)/g;
  const found = [...text.matchAll(marker)].map((match) => ({ number: Number(match[1]), start: match.index, end: match.index + match[0].length }));
  if (!found.length) return null;
  const numbers = found.map(({ number }) => number);
  if (numbers.some((number, index) => number < 1 || number > count || numbers.indexOf(number) !== index)) return null;
  return found.map((item, index) => ({ number: item.number, text: text.slice(item.end, found[index + 1]?.start ?? text.length).replace(/^[\s,;:]+|[\s,;]+$/g, '') }));
}

const brief = (questions) => questions.map((question, index) => `${index + 1}. ${question.title}`).join(' | ');

// questions: the stage's questions in the order they were shown; answered: question ids that already have an answer.
export function mapReplyToAnswers(questions, text, { answered = [] } = {}) {
  const reply = String(text ?? '').trim();
  if (!reply) return { clarification: 'The reply is empty. Ask the user for their answer.' };
  const open = questions.filter((question) => !answered.includes(question.question_id));
  if (!open.length) return { clarification: 'Every question already has an answer.' };
  if (isRecommendedReply(reply)) {
    const missing = open.filter((question) => !recommendedOption(question));
    if (missing.length) return { clarification: `No recommended option is marked for: ${brief(missing)}. Ask the user to choose.` };
    return { answers: open.map((question) => ({ question_id: question.question_id, answer: optionAnswer(recommendedOption(question)) })) };
  }
  const marked = questions.length > 1 ? markedSegments(reply, questions.length) : null;
  if (marked) {
    const answers = [];
    for (const { number, text: segment } of marked) {
      const question = questions[number - 1];
      if (answered.includes(question.question_id)) continue;
      const picked = pickOption(question, segment);
      if (!picked) return { clarification: `Question ${number} has no choice in the reply. Ask the user to choose for: ${question.title}` };
      answers.push({ question_id: question.question_id, answer: picked.answer });
    }
    return answers.length ? { answers } : { clarification: 'The reply only repeats answered questions.' };
  }
  if (open.length === 1) return { answers: [{ question_id: open[0].question_id, answer: pickOption(open[0], reply).answer }] };
  const parts = reply.split(/\n+|;/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === open.length) {
    const picks = open.map((question, index) => pickOption(question, parts[index]));
    if (picks.every(Boolean)) return { answers: open.map((question, index) => ({ question_id: question.question_id, answer: picks[index].answer })) };
  }
  return { clarification: `The reply does not say which question each choice answers. Ask the user to answer by number ("1번 A, 2번 B") or to say "추천대로": ${brief(open)}` };
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
  const answered = (Array.isArray(stored) ? stored : []).filter((item) => typeof item?.answer === 'string').map((item) => item.question_id);
  return { stageId: id, entry, questions, answered };
}

// What a raw reply is for: a waiting question batch, the requirements approval after bounded-context, or the plan
// publication approval after to-ticket. Returns the launch arguments the existing commands already accept.
export function resolveReplyTarget(root, text) {
  const state = readWorkflowState(root);
  if (!state?.stages) return { error: 'No workflow state was found in this worktree.' };
  const waiting = waitingQuestions(root, state) || Object.keys(state.stages).map((id) => waitingQuestions(root, state, id)).find(Boolean);
  if (waiting) {
    const mapped = mapReplyToAnswers(waiting.questions, text, { answered: waiting.answered });
    if (mapped.clarification) return { stageId: waiting.stageId, clarification: mapped.clarification };
    return { stageId: waiting.stageId, args: ['--stage-id', waiting.stageId, '--answer', JSON.stringify(mapped.answers)] };
  }
  const stages = state.stages;
  const done = (id) => stages[id]?.status === 'completed' && stages[id].code === 'OK' && !stages[id].stale;
  const started = (id) => Boolean(stages[id]?.execution_id) && !(stages[id].status === 'failed' || stages[id].status === 'cancelled');
  if (done('bounded-context') && !started('domain-model')) return { stageId: 'domain-model', args: ['--stage-id', 'domain-model', '--requirements-approved', 'true', '--approval-answer', String(text).trim()], approval: 'requirements' };
  if (done('to-ticket') && !started('tracker-publish')) return { stageId: 'tracker-publish', args: ['--stage-id', 'tracker-publish', '--publication-approved', 'true', '--approval-answer', String(text).trim()], approval: 'publication' };
  return { error: 'No stage is waiting for a user answer or approval. Run harness-context.mjs for the current state.' };
}
