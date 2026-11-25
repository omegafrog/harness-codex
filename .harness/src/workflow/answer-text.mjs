// Maps the user's raw reply onto the questions a stage is waiting for, so the orchestrator never reads the question
// file or builds an --answer JSON. `answer --text` and `launch --answer-text` call this; an ambiguous reply returns a
// short clarification request instead of a guess.
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

// questions: the stage's questions in the order they were shown; answered: question ids that already have an answer;
// stored: those answers ({question_id, answer}). A reply that, with the stored answers, picks two options that cannot both hold
// (`excludes`) records nothing and asks the user to change one.
export function mapReplyToAnswers(questions, text, { answered = [], stored = [] } = {}) {
  const mapped = mapReply(questions, text, { answered });
  if (!mapped.answers) return mapped;
  const incoming = new Set(mapped.answers.map((item) => item.question_id));
  const conflict = answerConflictMessage(questions, [...stored.filter((item) => !incoming.has(item.question_id)), ...mapped.answers]);
  return conflict ? { clarification: conflict } : mapped;
}

function mapReply(questions, text, { answered = [] } = {}) {
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
  const storedAnswers = (Array.isArray(stored) ? stored : []).filter((item) => typeof item?.answer === 'string');
  return { stageId: id, entry, questions, answered: storedAnswers.map((item) => item.question_id), storedAnswers };
}

// A short yes: "승인합니다", "네 진행해 주세요", "approved, go ahead". Anything that also asks for a change is not one.
const APPROVAL = /^(?:요구사항|전체계획|계획|발행)?(?:네|넵|예|응|그래|좋아요?|좋습니다|ok(?:ay)?|yes|yeah|yep|lgtm|approved?|승인|동의|확인|진행|맞(?:아요|습니다)|go(?:ahead)?|proceed|looksgood)(?:합니다|했습니다|해요|해줘|해주세요|해주시면됩니다|할게요|하세요|하겠습니다|하고|해도(?:돼요|됩니다|좋아요)?|됩니다|돼요|진행|승인|동의|네|예|좋아요?|그대로|이대로|다음|단계|계속|넘어가(?:요|자|주세요)?|가자|요|ok|okay|go(?:ahead)?|proceed|확인|완료|입니다|요구사항|계획|발행|으로|로|도|를|을|이|가|은|는|해서|dosubmit)*$/;
const CHANGE_WORDS = /바꿔|바꾸|수정|변경|고쳐|추가|삭제|빼|제외|대신|말고|하지만|그런데|다만|단,|change|edit|fix|add|remove|instead|but\b|however/i;
export const isApprovalReply = (text) => { const reply = String(text ?? '').trim(); return reply.length <= 60 && !CHANGE_WORDS.test(reply) && APPROVAL.test(squash(reply).replace(/[()"'`]/g, '')); };

const REVISION_STAGE_ORDER = ['subdomain-candidates', 'subdomain-classification', 'requirements-fix', 'bounded-context'];
// The earliest stage that owns a user's change request, from the words alone (the user's text is never interpreted by an agent):
// an explicit stage id, then Context ownership, business-scope additions, rule/wording edits, then a bare addition.
const REVISION_OWNERS = [
  [/서브\s*도메인\s*(?:분류|등급)|subdomain\s*classification|\b(?:core|supporting|generic)\b|코어\s*도메인|지원\s*도메인|일반\s*도메인/i, 'subdomain-classification'],
  [/바운디드|bounded|컨텍스트|\bcontext\b/i, 'bounded-context'],
  [/범위|누락|빠졌|빠진|새\s*(?:기능|업무)|업무\s*(?:추가|발굴)|\bscope\b|missing|new\s+(?:feature|capability)/i, 'subdomain-candidates'],
  [/규칙|예외|완료\s*조건|조건|문구|표현|문장|용어|오타|수정|바꿔|바꾸|고쳐|변경|\brules?\b|wording|exception|acceptance|rename|reword|typo|change|fix/i, 'requirements-fix'],
  [/추가|기능|지원|포함|\badd\b|feature|support|include/i, 'subdomain-candidates'],
];

// -> { stage } | { clarification }. `ownable` stages are those the workflow has already run.
export function pickRevisionOwner(state, text) {
  const stages = state?.stages || {};
  const started = (id) => Boolean(stages[id]?.execution_id);
  const reply = String(text ?? '');
  const named = [...REVISION_STAGE_ORDER, 'event-storming', 'domain-model', 'aggregate-design', 'domain-service', 'application-service', 'context-boundary', 'to-ticket'].find((id) => new RegExp(`(?:^|[^a-z-])${id}(?:[^a-z-]|$)`).test(reply));
  const owner = named || REVISION_OWNERS.find(([pattern]) => pattern.test(reply))?.[1];
  if (!owner) return { clarification: 'The change request does not say which part to change. Ask the user in Korean which requirement, rule, wording or scope item they want changed (one sentence each), then pass their answer verbatim as a new revise request. Nothing was started.' };
  if (!started(owner)) return { clarification: `The change belongs to ${owner}, which has not run yet, so there is nothing to revise there. Ask the user in Korean what exactly they want changed, or continue the workflow normally. Nothing was started.` };
  return { stage: owner };
}

// What a raw reply is for: a waiting question batch, the requirements approval after bounded-context, the plan
// publication approval after to-ticket, or (any other text) a change request for the revise route.
// Returns the launch arguments the existing commands already accept.
export function resolveReplyTarget(root, text) {
  const state = readWorkflowState(root);
  if (!state?.stages) return { error: 'No workflow state was found in this worktree.' };
  const waiting = waitingQuestions(root, state) || Object.keys(state.stages).map((id) => waitingQuestions(root, state, id)).find(Boolean);
  if (waiting) {
    const mapped = mapReplyToAnswers(waiting.questions, text, { answered: waiting.answered, stored: waiting.storedAnswers });
    if (mapped.clarification) return { stageId: waiting.stageId, clarification: mapped.clarification };
    return { stageId: waiting.stageId, args: ['--stage-id', waiting.stageId, '--answer', JSON.stringify(mapped.answers)] };
  }
  return resolveApprovalOrRevision(state, text, { root });
}

export function resolveApprovalOrRevision(state, text, { root = null } = {}) {
  const stages = state.stages;
  const done = (id) => stages[id]?.status === 'completed' && stages[id].code === 'OK' && !stages[id].stale;
  const started = (id) => Boolean(stages[id]?.execution_id) && !(stages[id].status === 'failed' || stages[id].status === 'cancelled');
  const approval = isApprovalReply(text);
  // An approval of requirements that today's rules would refuse is never recorded: it reopens requirements-fix instead.
  const recheck = approval && root && done('bounded-context') && !started('domain-model') ? recheckRequirementsBeforeApproval({ root, state }) : null;
  if (recheck?.applies && !recheck.ok) return { stageId: recheck.owner_stage, args: recheck.reopen_args, reopen: 'requirements', notice: recheck.notice_ko, errors: recheck.errors };
  if (approval && done('bounded-context') && !started('domain-model')) return { stageId: 'domain-model', args: ['--stage-id', 'domain-model', '--requirements-approved', 'true', '--approval-answer', String(text).trim()], approval: 'requirements' };
  if (approval && done('to-ticket') && !started('tracker-publish')) return { stageId: 'tracker-publish', args: ['--stage-id', 'tracker-publish', '--publication-approved', 'true', '--approval-answer', String(text).trim()], approval: 'publication' };
  if (isRecommendedReply(text)) return { error: 'No stage is waiting for a user answer or approval. Run harness-context.mjs for the current state.' };
  if (!approval) {
    const picked = pickRevisionOwner(state, text);
    if (picked.stage) return { stageId: picked.stage, args: ['--stage-id', picked.stage, '--user-revision', 'true', '--feedback', String(text).trim()], revision: true };
    return { clarification: picked.clarification, revision: true };
  }
  return { error: 'No stage is waiting for a user answer or approval. Run harness-context.mjs for the current state.' };
}

// `harness-stage: revise`: the text is a change request whatever it looks like, so it never approves anything.
export function resolveRevision(root, text) {
  const state = readWorkflowState(root);
  if (!state?.stages) return { error: 'No workflow state was found in this worktree.' };
  const picked = pickRevisionOwner(state, text);
  if (!picked.stage) return { clarification: picked.clarification, revision: true };
  return { stageId: picked.stage, args: ['--stage-id', picked.stage, '--user-revision', 'true', '--feedback', String(text).trim()], revision: true };
}
