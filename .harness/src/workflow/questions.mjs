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
export function assertQuestionContext(questions, { schema = null, skill = null } = {}) {
  if (schema && !schema.properties?.result?.properties?.questions?.items?.properties?.context) return;
  const problems = (Array.isArray(questions) ? questions : []).flatMap((question, index) => [...questionContextProblems(question), ...(skill === 'stakeholder-analysis' ? stakeholderQuestionProblems(question) : [])].map((problem) => `question ${index + 1}: ${problem}`));
  if (!problems.length) return;
  throw new Error(`Questions must let the user decide without following your work. ${problems.join('; ')}. Write context.settled_rules (settled rules that apply, quoted from settled documents or answers; none invented), context.why_now, and for each option its effect (what changes on screen or in behavior) and its example (the same concrete situation applied to this option, for example two pins of one owner on a map). Examples illustrate and are never new requirements. An option names concrete values (never 직접 입력/기타) and the recommended option's reason goes in rationale. Keep each effect, example and why_now to one line and context.settled_rules to at most ${QUESTION_RULES_LIMIT} short rules.`);
}

// Extra rules for the questions of stakeholder-analysis: a decision settles an outcome, so no option may leave it to the implementer or
// to a later question (a 보류 option may say it is asked again), and a question that settles several candidates cannot be a bare adopt/reject.
const DEFERRING_OPTION = /임의로|나중에 정|후속(?:\s*(?:질문|단계))?에서 (?:다시 )?(?:정|묻)/;
const ADOPT_REJECT = /^(?:채택|기각|보류|채택한다|기각한다|보류한다)$/;
export function stakeholderQuestionProblems(question) {
  const problems = [];
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
// least a desktop and a mobile screenshot and names, in its title, the comparison page that shows them side by side.
export async function assertQuestionPreviews({ session, question }) {
  if (!question || !Array.isArray(question.options)) throw new Error('Invalid question');
  const visual = question.decision_kind === 'visual_direction';
  for (const option of question.options) {
    const previews = option.previews ?? [];
    if (!Array.isArray(previews)) throw new Error(`Option ${option.id} previews must be an array`);
    if (visual) {
      if (!previews.length) throw new Error(`Visual direction option ${option.id} needs preview screenshots`);
      for (const viewport of ['desktop', 'mobile']) if (!previews.some((item) => item?.viewport === viewport)) throw new Error(`Visual direction option ${option.id} needs a ${viewport} preview`);
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
