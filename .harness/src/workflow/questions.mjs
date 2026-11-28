import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

export function identifyQuestions(executionId, questions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId) || !Array.isArray(questions)) throw new Error('Invalid question batch');
  return questions.map((question, index) => {
    if (!question || typeof question !== 'object' || Array.isArray(question) || Object.hasOwn(question, 'question_id')) throw new Error('Invalid question');
    return { ...question, question_id: `${executionId}:${index + 1}` };
  });
}

const filled = (value) => typeof value === 'string' && value.trim().length > 0;
// One line each: the user reads these next to every option, so a paragraph is rejected.
export const QUESTION_LINE_LIMIT = 160;
export const QUESTION_RULES_LIMIT = 3;
const OPEN_ENDED_LABEL = /^(?:직접\s*입력(?:한다|하기|\s*\(.*\))?|기타|other|others)$/i;
// "수정이 필요함" and an effect that makes the user's answer text the outcome are direct input under another name.
const EDIT_REQUEST_LABEL = /^(?:수정|변경|고쳐|고치|다르게|다른\s*(?:안|답|의견)|그\s*외|기타)(?:\s*(?:이\s*필요함|이\s*필요합니다|필요|한다|하기|(?:해?서)?\s*확정(?:\s*한다)?|\(?직접\s*입력\)?))*$/;
const ANSWER_TEXT_OUTCOME = /답변\s*(?:문구|내용|대로)|적어\s*주신\s*대로|입력한?\s*대로|사용자가\s*(?:적은|입력한)/;
const sameText = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();

// What a user needs to decide without having followed the agent's work: the business rules already settled that bear on the
// decision, why it must be decided now, and for every option what changes on screen or in behavior (`effect`) and the same
// concrete situation applied to that option (`example`). An example is an illustration the user may react to; it is not a
// requirement. Returns the problems of one question, [] when it is complete. A visual_direction question still gives an
// `effect` and a text `example`, because the question UI may not display its previews.
export function questionContextProblems(question) {
  const problems = [];
  const context = question?.context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) problems.push('context {settled_rules, why_now} is missing');
  else {
    if (!Array.isArray(context.settled_rules) || !context.settled_rules.length || !context.settled_rules.every(filled)) problems.push('context.settled_rules must list the already-settled business rules that bear on this decision, at least one non-empty entry');
    if (!filled(context.why_now)) problems.push('context.why_now must say why this has to be decided now');
    else if (context.why_now.length > QUESTION_LINE_LIMIT) problems.push(`context.why_now must be one line of at most ${QUESTION_LINE_LIMIT} characters`);
    if (Array.isArray(context.settled_rules) && (context.settled_rules.length > QUESTION_RULES_LIMIT || context.settled_rules.some((rule) => filled(rule) && rule.length > QUESTION_LINE_LIMIT))) {
      problems.push(`context.settled_rules must list at most ${QUESTION_RULES_LIMIT} rules of at most ${QUESTION_LINE_LIMIT} characters each`);
    }
  }
  for (const option of Array.isArray(question?.options) ? question.options : []) {
    if (OPEN_ENDED_LABEL.test(String(option?.label ?? '').trim())) problems.push(`option ${option.id} is "${option.label}": an option names the concrete values it commits to (which things, which fields, which condition); the user may always answer in their own words`);
  }
  for (const option of Array.isArray(question?.options) ? question.options : []) {
    if (EDIT_REQUEST_LABEL.test(String(option?.label ?? '').trim())) problems.push(`option ${option?.id} is "${option.label}", a request to edit the draft; offer the concrete alternatives instead (the user may always answer in their own words)`);
    for (const field of ['effect', 'consequence']) {
      const match = ANSWER_TEXT_OUTCOME.exec(String(option?.[field] ?? ''));
      if (match) problems.push(`option ${option?.id} ${field} says "${match[0]}": the outcome is the user's answer text, which is direct input; name the concrete result of the option`);
    }
  }
  const first = { effect: new Map(), example: new Map() };
  for (const option of Array.isArray(question?.options) ? question.options : []) {
    for (const field of ['effect', 'example']) {
      if (!filled(option?.[field])) { problems.push(`option ${option?.id} needs ${field}`); continue; }
      if (option[field].length > QUESTION_LINE_LIMIT) problems.push(`option ${option.id} ${field} must be one line of at most ${QUESTION_LINE_LIMIT} characters`);
      const key = sameText(option[field]);
      if (first[field].has(key)) problems.push(`option ${option.id} repeats the ${field} of option ${first[field].get(key)}; give each option its own`);
      else first[field].set(key, option.id);
    }
    if (filled(option?.effect) && filled(option?.example) && sameText(option.effect) === sameText(option.example)) problems.push(`option ${option.id} gives the same text as effect and example; the example is a concrete case of the effect`);
  }
  return problems;
}

// The gate for a stage's new question batch (harness-result runs it; stored questions are never checked, so questions written
// before this rule stay readable). `schema` is the output schema the worker was given: an execution started before the rule has
// a schema without `context`, its worker could not have written one, so its batch is accepted as it is.
export function assertQuestionContext(questions, { schema = null, skill = null, root = null, request = null, planSetId = null, previousExclusions = null } = {}) {
  if (schema && !schema.properties?.result?.properties?.questions?.items?.properties?.context) return;
  const list = Array.isArray(questions) ? questions : [];
  const problems = list.flatMap((question, index) => [...questionContextProblems(question), ...(skill === 'stakeholder-analysis' ? stakeholderQuestionProblems(question, { root, request, planSetId }) : [])].map((problem) => `question ${index + 1}: ${problem}`));
  // `excludes` is checked only when the execution's schema could carry it; a schema without it is an execution started before the rule.
  const batch = !schema || schema.properties?.result?.properties?.questions?.items?.properties?.options?.items?.properties?.excludes
    ? [...questionBatchProblems(list), ...droppedExclusionProblems(list, previousExclusions)] : [];
  if (!problems.length && !batch.length) return;
  const exclusion = batch.length ? ' `excludes` of an option lists the options of other questions of this batch (question = 1-based position, option = its id) that cannot hold together with it, so the user is never shown recommended answers that contradict each other. Ask a question that only makes sense under one answer of another question after that answer.' : '';
  throw new Error(`Questions must let the user decide without following your work. ${[...problems, ...batch].join('; ')}. Write context.settled_rules (settled rules that apply, quoted from settled documents or answers; none invented), context.why_now, and for each option its effect (what changes on screen or in behavior) and its example (the same concrete situation applied to this option, for example two pins of one owner on a map). Examples illustrate and are never new requirements. An option names concrete values (never 직접 입력/기타) and the recommended option's reason goes in rationale. Keep each effect, example and why_now to one line and context.settled_rules to at most ${QUESTION_RULES_LIMIT} short rules.${exclusion}`);
}

// Two options of different questions of one batch that cannot both hold are declared with `excludes` ({question: 1-based position in
// the batch, option: option id}); either side may declare the pair. The batch is rejected when it shows the user recommended answers
// that contradict each other, or an option no answer can leave open. A resubmission keeps the pairs it declared before (declaredExclusions, droppedExclusionProblems).
const optionList = (question) => (Array.isArray(question?.options) ? question.options : []);
const refName = (questions, number, option) => `question ${number} option ${option}${optionList(questions[number - 1]).find((item) => item?.id === option)?.label ? ` ("${optionList(questions[number - 1]).find((item) => item.id === option).label}")` : ''}`;

// Map "i:optionId" -> Set of "j:optionId" it cannot hold with (symmetric). `problems` collects invalid references.
export function exclusionMap(questions, problems = []) {
  const map = new Map();
  const link = (a, b) => { if (!map.has(a)) map.set(a, new Set()); map.get(a).add(b); };
  questions.forEach((question, index) => {
    const number = index + 1;
    for (const option of optionList(question)) {
      if (!Array.isArray(option?.excludes)) { problems.push(`question ${number} option ${option?.id} needs excludes (an array, [] when it conflicts with no option of another question)`); continue; }
      for (const ref of option.excludes) {
        const target = Number.isInteger(ref?.question) ? questions[ref.question - 1] : undefined;
        if (!target) problems.push(`question ${number} option ${option.id} excludes question ${ref?.question}, which is not a question position of this batch (1-${questions.length})`);
        else if (ref.question === number) problems.push(`question ${number} option ${option.id} excludes an option of its own question; excludes names options of other questions`);
        else if (!optionList(target).some((item) => item?.id === ref.option)) problems.push(`question ${number} option ${option.id} excludes question ${ref.question} option ${ref.option}, which does not exist`);
        else { link(`${number}:${option.id}`, `${ref.question}:${ref.option}`); link(`${ref.question}:${ref.option}`, `${number}:${option.id}`); }
      }
    }
  });
  return map;
}

const deadBy = (questions, map, number, id) => questions.findIndex((other, otherIndex) => otherIndex !== number - 1 && optionList(other).length && optionList(other).every((item) => map.get(`${otherIndex + 1}:${item.id}`)?.has(`${number}:${id}`)));
const descriptor = (questions, number, id) => { const question = questions[number - 1], option = optionList(question).find((item) => item?.id === id); return { number, id, title: question?.title ?? null, label: option?.label ?? null }; };

// The valid pairs of a batch as plain descriptors (question title + option label, with position and id as the fallback), so a
// rejected submission's declarations can be kept for the resubmission. A pair whose option no answer can leave open (a dead
// option) is not kept: dropping it is the way to correct that rejection.
export function declaredExclusions(questions) {
  const map = exclusionMap(questions);
  const pairs = [];
  for (const [left, rights] of map) for (const right of rights) {
    if (left > right) continue;
    const [a, b] = [left, right].map((key) => descriptor(questions, Number(key.split(':')[0]), key.slice(key.indexOf(':') + 1)));
    if ([a, b].some((side) => deadBy(questions, map, side.number, side.id) >= 0)) continue;
    pairs.push([a, b]);
  }
  return pairs;
}

// A resubmitted batch must still declare every earlier pair whose two options still exist (matched by question title + option
// label, else by position + id): a declaration is restored, never deleted to pass the check.
export function droppedExclusionProblems(questions, previous) {
  if (!Array.isArray(previous) || !previous.length) return [];
  const problems = [];
  const map = exclusionMap(questions);
  const find = (side) => {
    const byText = [];
    questions.forEach((question, index) => optionList(question).forEach((option) => { if (side.title != null && question?.title === side.title && side.label != null && option?.label === side.label) byText.push(`${index + 1}:${option.id}`); }));
    if (byText.length === 1) return byText[0];
    return optionList(questions[side.number - 1]).some((option) => option?.id === side.id) ? `${side.number}:${side.id}` : null;
  };
  for (const [a, b] of previous) {
    const [left, right] = [find(a), find(b)];
    if (!left || !right || left === right || map.get(left)?.has(right)) continue;
    problems.push(`the earlier submission declared that ${refName(questions, Number(left.split(':')[0]), left.slice(left.indexOf(':') + 1))} and ${refName(questions, Number(right.split(':')[0]), right.slice(right.indexOf(':') + 1))} cannot hold together, and this one no longer does; restore that excludes declaration (or remove/rename the option if it really changed) instead of deleting the declaration to pass`);
  }
  return problems;
}

export function questionBatchProblems(questions) {
  const problems = [];
  const map = exclusionMap(questions, problems);
  if (problems.length) return problems;
  const recommended = questions.map((question) => question?.recommended_option_id);
  const name = (key) => { const [number, option] = [Number(key.split(':')[0]), key.slice(key.indexOf(':') + 1)]; return refName(questions, number, option); };
  questions.forEach((_, index) => {
    const key = `${index + 1}:${recommended[index]}`;
    for (const other of map.get(key) ?? []) {
      const number = Number(other.split(':')[0]);
      if (number > index + 1 && other === `${number}:${recommended[number - 1]}`) problems.push(`the recommended ${name(key)} and the recommended ${name(other)} cannot both hold; change one recommendation, or ask the dependent question after the answer of the other (defer it)`);
    }
  });
  questions.forEach((question, index) => {
    const number = index + 1;
    const options = optionList(question);
    for (const option of options) {
      const key = `${number}:${option.id}`;
      const dead = deadBy(questions, map, number, option.id);
      if (dead >= 0) problems.push(`${name(key)} is excluded by every option of question ${dead + 1}, so no answer can leave it open; remove the option or correct the excludes`);
    }
  });
  return problems;
}

// The option a stored answer chose: the answer text starts with "<label> (<id>)" or is the option id; any other text is the user's own words.
export function selectedOption(question, answer) {
  const text = String(answer ?? '').trim();
  return optionList(question).find((option) => { const base = `${option.label} (${option.id})`; return text === base || text.startsWith(`${base}:`) || text.toLowerCase() === String(option.id).toLowerCase(); }) ?? null;
}

// The Korean message when answers (each {question_id, answer}) choose two options that cannot both hold; null when they do not.
export function answerConflictMessage(questions, answers) {
  if (!Array.isArray(questions) || !Array.isArray(answers)) return null;
  const map = exclusionMap(questions);
  if (!map.size) return null;
  const chosen = [];
  questions.forEach((question, index) => {
    const entry = answers.find((item) => item?.question_id === question?.question_id);
    const option = entry && selectedOption(question, entry.answer);
    if (option) chosen.push({ number: index + 1, question, option });
  });
  for (const a of chosen) for (const b of chosen) {
    if (b.number > a.number && map.get(`${a.number}:${a.option.id}`)?.has(`${b.number}:${b.option.id}`)) {
      return `질문 ${a.number}("${a.question.title}")의 "${a.option.label}"과(와) 질문 ${b.number}("${b.question.title}")의 "${b.option.label}"은(는) 함께 성립할 수 없습니다. 둘 중 하나를 바꿔 다시 답해 주세요. 아무것도 기록하지 않았습니다.`;
    }
  }
  return null;
}

// Extra rules for the questions of stakeholder-analysis: a decision settles an outcome, so no option may leave it to the implementer or
// to a later question (a 보류 option may say it is asked again), and a question that settles several candidates cannot be a bare adopt/reject.
const DEFERRING_OPTION = /임의로|나중에 정|후속(?:\s*(?:질문|단계))?에서 (?:다시 )?(?:정|묻)/;
const ADOPT_REJECT = /^(?:채택|기각|보류|채택한다|기각한다|보류한다)$/;
// A recommendation that adds a login needs evidence the project has one: a request quote about login/members, or a project file about it.
const LOGIN_REQUIRED = /로그인(?:한|된|이\s*필요|해야|을\s*해야|을\s*요구)|login(?:ged)?[\s-]*(?:required|in user)|requires?\s+login/i;
const LOGIN_NEGATED = /비로그인|로그인\s*없이|로그인(?:을|이)?\s*(?:하지|요구하지)\s*않|로그인\s*불필요|no login|without (?:a )?login|login not required/gi;
const LOGIN_TOPIC = /로그인|회원|인증|login|auth/i;
const LOGIN_FILE_EVIDENCE = /로그인|인증|회원|login|auth(?:entication|orization)?\b|session|signin|sign-in/i;
const HARNESS_OWNED = /^(?:\.harness|\.claude|\.codex|\.io|\.git|node_modules)(?:\/|$)/;
function loginFileEvidence(rationale, { root, planSetId }) {
  if (!root) return false;
  for (const token of rationale.match(/[^\s"'`()[\],;]+\.[A-Za-z0-9]{1,8}\b/g) ?? []) {
    const path = token.replace(/^\.\//, '').replace(/[.:]+$/, '');
    if (!path || isAbsolute(path) || path.split('/').includes('..') || HARNESS_OWNED.test(path) || (planSetId && path.startsWith(`docs/specs/${planSetId}/`))) continue;
    try {
      const target = resolve(root, path);
      const real = relative(realpathSync(root), realpathSync(target));
      if (real.startsWith('..') || isAbsolute(real) || HARNESS_OWNED.test(real.replaceAll('\\', '/'))) continue;
      const info = lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) continue;
      if (LOGIN_FILE_EVIDENCE.test(readFileSync(target, 'utf8'))) return true;
    } catch { /* not a usable evidence file */ }
  }
  return false;
}
function loginEvidenceProblem(question, { root, request, planSetId }) {
  const options = Array.isArray(question?.options) ? question.options : [];
  const title = String(question?.title ?? '');
  const optionText = options.map((option) => `${option?.label ?? ''} ${option?.effect ?? ''} ${option?.consequence ?? ''}`).join(' ');
  const access = (/OPEN-\d+/.test(title) && /이용\s*조건/.test(title)) || /로그인|비로그인|login/i.test(`${title} ${optionText}`);
  const recommended = options.find((option) => option?.id === question?.recommended_option_id);
  if (!access || !recommended) return null;
  const text = `${recommended.label ?? ''} ${recommended.effect ?? ''} ${recommended.consequence ?? ''}`.replace(LOGIN_NEGATED, ' ');
  if (!LOGIN_REQUIRED.test(text)) return null;
  const rationale = String(question.rationale ?? '');
  for (const [, quote] of rationale.matchAll(/요청 원문\s*"([^"]+)"/g)) {
    if (typeof request === 'string' && request.includes(quote) && LOGIN_TOPIC.test(quote)) return null;
  }
  if (loginFileEvidence(rationale, { root, planSetId })) return null;
  return `the recommended option ${recommended.id} requires a login, but its rationale cites no evidence that the project has one; cite \`요청 원문 "<exact request text about 로그인/회원/인증>"\` or an existing project file about login/auth, otherwise recommend the option that adds no new login (the least new behavior) and say the project has no evidence of an existing login`;
}

export function stakeholderQuestionProblems(question, evidence = {}) {
  const problems = [];
  const login = loginEvidenceProblem(question, evidence);
  if (login) problems.push(login);
  for (const option of Array.isArray(question?.options) ? question.options : []) {
    const hold = /보류/.test(String(option?.label ?? ''));
    for (const field of ['label', 'effect', 'consequence', 'example']) {
      const text = String(option?.[field] ?? '');
      const match = DEFERRING_OPTION.exec(text);
      if (match && !(hold && /^후속/.test(match[0]))) problems.push(`option ${option.id} ${field} says "${match[0]}": every option settles the outcome; only a 보류 option may say it is asked again later`);
    }
  }
  const text = `${question?.title ?? ''} ${question?.context?.settled_rules?.join(' ') ?? ''} ${question?.context?.why_now ?? ''}`;
  const options = Array.isArray(question?.options) ? question.options : [];
  if (new Set(text.match(/CAND-\d+/g) ?? []).size > 1 && options.length && options.every((option) => ADOPT_REJECT.test(String(option?.label ?? '').trim()))) {
    problems.push('the question settles several CAND IDs with only adopt/reject/hold options; offer the concrete options that settle all of them (adopt/reject is for one complete rule)');
  }
  if (question?.recommended_option_id && (!filled(question.rationale) || /[\r\n]/.test(question.rationale.trim()) || question.rationale.length > QUESTION_LINE_LIMIT)) {
    problems.push(`rationale is the reason for the recommended option: one line of at most ${QUESTION_LINE_LIMIT} characters`);
  }
  return problems;
}

export function isQuestionResponse(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 2) return false;
  return Object.hasOwn(entry, 'question_id') && typeof entry.question_id === 'string' && Boolean(entry.question_id.trim())
    && ['answer', 'clarification'].some((key) => Object.hasOwn(entry, key) && typeof entry[key] === 'string' && entry[key].trim());
}

// An open batch keeps one response per question. A clarification leaves that decision pending until an answer
// replaces it. A finalized batch accepts only answers. Unknown, empty and repeated IDs in a batch are rejected.
export function mergeAnswers(questions, previous, incoming, { revisePending = false } = {}) {
  if (!Array.isArray(questions) || !Array.isArray(previous) || !Array.isArray(incoming)) throw new Error('Invalid answers');
  const ids = new Set(questions.map((question) => question.question_id));
  if (ids.size !== questions.length || ids.has(undefined)) throw new Error('Invalid question IDs');
  const responses = new Map();
  const usable = (entry) => isQuestionResponse(entry) && ids.has(entry.question_id) && (revisePending || Object.hasOwn(entry, 'answer'));
  for (const entry of previous) {
    if (!usable(entry) || responses.has(entry.question_id)) throw new Error('Invalid, duplicate, or stale answer');
    responses.set(entry.question_id, entry);
  }
  const batch = new Set();
  for (const entry of incoming) {
    if (!usable(entry) || batch.has(entry.question_id) || (responses.has(entry.question_id) && !revisePending)) throw new Error('Invalid, duplicate, or stale answer');
    batch.add(entry.question_id);
    responses.set(entry.question_id, entry);
  }
  const answers = [...responses.values()].filter((entry) => Object.hasOwn(entry, 'answer')).map(({ question_id, answer }) => ({ question_id, answer }));
  const clarifications = [...responses.values()].filter((entry) => Object.hasOwn(entry, 'clarification')).map(({ question_id, clarification }) => ({ question_id, clarification }));
  return { answers, complete: answers.length === ids.size, ...(clarifications.length ? { clarifications } : {}) };
}

const IMAGE_SIGNATURES = {
  '.png': (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  '.jpeg': (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  '.webp': (bytes) => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
};

// A session file a question shows the user: a regular, unshared file inside the session directory (no symlink on the way).
async function sessionFile(session, path, what) {
  if (typeof path !== 'string' || !path.trim()) throw new Error(`${what} needs a path`);
  const base = await realpath(session);
  const target = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || (!isAbsolute(path) && path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'))) throw new Error(`${what} ${path} is outside the session directory`);
  const info = await lstat(target).catch((error) => { if (error.code === 'ENOENT') throw new Error(`${what} ${path} does not exist`); throw error; });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error(`${what} ${path} must be a regular session file`);
  const real = relative(base, await realpath(target));
  if (!real || real.startsWith('..') || isAbsolute(real)) throw new Error(`${what} ${path} is outside the session directory`);
  return target;
}

async function head(path, length) {
  const handle = await open(path, 'r');
  try { const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, 0); return buffer.subarray(0, bytesRead); }
  finally { await handle.close(); }
}

// Every preview an option carries is a real image in the session. A visual_direction question offers each style with at
// least a desktop screenshot and names, in its title, the comparison page that shows them side by side.
export async function assertQuestionPreviews({ session, question }) {
  if (!question || !Array.isArray(question.options)) throw new Error('Invalid question');
  const visual = question.decision_kind === 'visual_direction';
  for (const option of question.options) {
    const previews = option.previews ?? [];
    if (!Array.isArray(previews)) throw new Error(`Option ${option.id} previews must be an array`);
    if (visual) {
      if (!previews.length) throw new Error(`Visual direction option ${option.id} needs preview screenshots`);
      if (!previews.some((item) => item?.viewport === 'desktop')) throw new Error(`Visual direction option ${option.id} needs a desktop preview`);
    }
    for (const preview of previews) {
      const what = `Preview of option ${option.id}`;
      const target = await sessionFile(session, preview?.path, what);
      const signature = IMAGE_SIGNATURES[extname(target).toLowerCase()];
      if (!signature || !signature(await head(target, 12))) throw new Error(`${what} ${preview.path} is not a PNG, JPEG or WebP image`);
    }
  }
  if (visual) {
    const pages = [...String(question.title).matchAll(/[^\s"'`<>()[\]]+\.html?\b/g)].map((match) => match[0].replace(/^file:\/\//, '').replace(/^(?:.*\/)?\.io\//, ''));
    if (!pages.length) throw new Error('Visual direction question title must name the comparison page');
    for (const page of pages) await sessionFile(session, page, 'Comparison page');
  }
}
