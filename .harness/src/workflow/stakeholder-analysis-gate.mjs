// Deterministic check of stakeholder-analysis.md when stakeholder-analysis returns its questions or completes.
// The requester is a stakeholder: every feature the request names is a settled requirement of the requester, never a
// candidate the user is asked to adopt. The check holds only what can be read mechanically:
// - the participant table lists the requester (`REQUESTER`);
// - the requested-feature table (`요청 기능` / `요청 문구` columns) has a row for at least one feature, each quoting the
//   request or an explicitly attached text source and recorded as `확정`; source quotes cite their path and line;
// - an observation moved out of scope quotes its request anchor (`요청 앵커`), and that anchor is NOT in the request.
//   A persona candidate whose anchor is in the request is asked as a candidate; no other reason excludes it.
// - the `미확정 사실` table (`ID | 구분 | 사실 | 바뀌는 동작 | 처리 | 근거`) holds each fact that changes behavior and is not settled:
//   it always has an `이용 조건` row, a `확정` row cites its source, a `해당 없음` row gives its reason, no row is `미정` when the stage
//   completes, and an unknown that changes behavior is not filed as an out-of-scope observation.
// - when the stage completes, the (draft) requirements.md cites the id of each `확정` `이용 조건` row (OPEN_FACT_NOT_REFLECTED), the
//   same citation requirements-fix demands later; a resume of an analysis completed without it is exempt (`legacyReflection`).
// - a candidate (`CAND` table, 내용 column) is a rule or an open choice, never a statement that only defers the decision
//   (CANDIDATE_DEFERS_DECISION); a candidate recorded as 보류(후속) or merged into another is not asked now and is exempt.
// - a candidate or OPEN row recorded as 보류(후속) names the question or option it waits on (DEFERRED_TARGET_MISSING), and none is left
//   when the stage completes (DEFERRED_QUESTION_PENDING). A row that was 보류(후속) in the published document of the previous execution may
//   not vanish or be settled without asking: it is `채택…`/`기각`/`보류` whose 결정 출처 cites an answer recorded for a question about it, or
//   `불필요 — <question id>: <chosen option> 때문에 …` citing the recorded answer that makes it moot (DEFERRED_QUESTION_DROPPED).
// Contextual judgement (which phrases are features, which candidates restate the request, and what to decompose from a
// cited source) belongs to the stage GUIDE.
import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { clean, parseTables, planSetDocument, stakeholderAnalysisSkipped } from './domain-model-gate.mjs';
import { WORKTREE_STAGE } from './worktree-stages.mjs';

export const REQUESTER_ID = 'REQUESTER';
const STAGE = WORKTREE_STAGE.STAKEHOLDER_ANALYSIS;
const unquote = (value) => clean(value).replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
export const OPEN_FACT_KINDS = ['이용 조건', '권한', '데이터', '화면 동작', '외부 연동', '기타'];
export const ACCESS_KIND = '이용 조건';
const MISFILED_UNKNOWN = /알 수 없|unknown|미정/i;
const MISFILED_BEHAVIOR = /권한|로그인|접근|대상 사용자|이용 주체|공개 범위/;
const isOpenFactTable = (table) => ['ID', '구분', '사실', '바뀌는 동작', '처리', '근거'].every((column) => table.header.includes(column));
export const openFactRows = (analysis) => {
  const tables = parseTables(analysis).filter(isOpenFactTable);
  return tables.length ? tables.flatMap((table) => table.rows) : null;
};
export const DEFERRING_STATEMENT = /(?:정한다|정해야 한다|결정한다|결정해야 한다|명확히 한다|명확히 해야 한다|구체화한다|구체화해야 한다|확인한다|확인해야 한다)(?:고|도록)?[\s.!?。…"'”’」』)\]]*$/;
const isCandidateTable = (table) => ['CAND', '내용', '결정'].every((column) => table.header.includes(column));
export const deferringCandidates = (analysis) => parseTables(analysis).filter(isCandidateTable).flatMap((table) => table.rows)
  .filter((row) => DEFERRING_STATEMENT.test(clean(row['내용'])) && !/^보류\(후속\)|병합/.test(clean(row['결정'])));
const settledAccessRow = (row) => clean(row['처리']) === '확정' && clean(row['구분']) === ACCESS_KIND;
const error = (code, message) => ({ code, message, owner_stage: STAGE });

const ATTACHED_TEXT_PATH = /(?:첨부 파일|첨부 자료|참고 파일|참고 자료|참조 파일|기준 파일)\s*[:：]\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s<>]+))/g;
export function requestSourcePaths(request) {
  const paths = new Set();
  for (const match of String(request ?? '').matchAll(ATTACHED_TEXT_PATH)) {
    const path = match.slice(1).find(Boolean)?.trim();
    if (path && isAbsolute(path) && /\.(?:md|markdown|txt|rst)$/i.test(path)) paths.add(resolve(path));
  }
  return [...paths];
}

export async function readRequestSourceMaterials(request) {
  const materials = [], unavailable = [];
  for (const path of requestSourcePaths(request)) {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 10 * 1024 * 1024) throw new Error('not a regular text file under 10 MiB');
      materials.push({ path, text: await readFile(path, 'utf8') });
    } catch (error) { unavailable.push({ path, reason: error.message }); }
  }
  return { materials, unavailable };
}

function sourceMaterialAnchor(phrase, materials) {
  for (const material of materials) {
    const lines = material.text.split(/\r?\n/);
    const index = lines.findIndex((line) => line.includes(phrase));
    if (index >= 0) return { path: material.path, line: index + 1 };
  }
  return null;
}

const broadGoal = (feature) => /(?:개선|고도화|최적화|강화|개편|혁신|구축|개발|업그레이드)$/.test(clean(feature));

// ---- deferred rows -----------------------------------------------------------------------------------------------------------
export const DEFERRED = /^보류\(후속\)/;
const MOOT = /^불필요\s*[—–-]\s*([A-Za-z][A-Za-z0-9_-]*:\d+)\s*:\s*(.+?)\s*때문에/;
const QUESTION_ID = /\b([A-Za-z][A-Za-z0-9_-]*:\d+)\b/g;
const SAFE_EXECUTION = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const waitingTarget = (text) => clean(text).replace(DEFERRED, '').replace(/^[\s:：—–-]+/, '').trim();
// Every candidate and OPEN row of an analysis as { id, kind, state, source, target } (`state` is the 결정 or 처리 cell).
export function decisionRows(analysis) {
  const candidates = parseTables(analysis).filter(isCandidateTable).flatMap((table) => table.rows).map((row) => ({ id: clean(row.CAND), kind: 'CAND', state: clean(row['결정']), source: clean(row['결정 출처'] ?? row['근거']), target: waitingTarget(row['결정']) }));
  const open = (openFactRows(analysis) ?? []).map((row) => ({ id: clean(row.ID), kind: 'OPEN', state: clean(row['처리']), source: clean(row['근거']), target: waitingTarget(row['처리']) || (DEFERRED.test(clean(row['처리'])) ? clean(row['근거']) : '') }));
  return [...candidates, ...open].filter((row) => row.id);
}
export const deferredRows = (analysis) => decisionRows(analysis).filter((row) => DEFERRED.test(row.state));
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const normalizeText = (value) => String(value ?? '').replace(/[\s`'"“”‘’]/g, '').toLowerCase();

// The recorded answer and question behind a question id (`<execution-id>:<n>`); { answer: null } when no answer is recorded.
async function recordedQuestion(session, id) {
  const execution = id.slice(0, id.lastIndexOf(':'));
  if (!SAFE_EXECUTION.test(execution)) return { answer: null };
  const directory = join(session, 'runtime/executions', execution);
  const answers = await readJson(join(directory, 'decision-answers.json'));
  const entry = Array.isArray(answers) ? answers.find((item) => item?.question_id === id && typeof item.answer === 'string' && item.answer.trim()) : null;
  if (!entry) return { answer: null, execution };
  const result = await readJson(join(directory, 'result.json'));
  const question = Array.isArray(result?.questions) ? result.questions.find((item) => item?.question_id === id) ?? null : null;
  return { answer: entry.answer, question, questionsKnown: Array.isArray(result?.questions), execution };
}

// Problem with the 결정 출처 of a row that was 보류(후속) before; null when it holds. `session` null: nothing can be verified.
async function deferredSourceProblem({ row, session, previousExecution }) {
  const moot = MOOT.exec(row.kind === 'OPEN' ? row.source : row.state);
  const text = moot ? moot[1] : row.source;
  const ids = [...new Set([...text.matchAll(QUESTION_ID)].map((match) => match[1]))];
  if (!ids.length) return /answers\.json/.test(text) && !moot ? null : `${row.id} was 보류(후속) and is now settled, but 결정 출처 cites no recorded answer (a question id \`<execution-id>:<n>\` or answers.json).`;
  if (!session) return null;
  const found = [];
  for (const id of ids) {
    const recorded = await recordedQuestion(session, id);
    if (recorded.answer !== null) found.push({ id, ...recorded });
  }
  if (!found.length) return `${row.id} cites ${ids.join(', ')}, which is not in the recorded answers.`;
  if (moot) {
    const [{ answer, question }] = found;
    const labels = [answer, ...(question?.options ?? []).filter((option) => option?.id === answer).map((option) => option.label)].map(normalizeText).filter(Boolean);
    const chosen = normalizeText(moot[2]);
    return labels.some((label) => label.includes(chosen) || chosen.includes(label)) ? null : `${row.id} says ${moot[1]} chose "${moot[2]}", but the recorded answer is "${answer}".`;
  }
  const about = found.filter((item) => item.execution !== previousExecution && (!item.questionsKnown || JSON.stringify(item.question ?? {}).includes(row.id)));
  return about.length ? null : `${row.id} was 보류(후속) and was settled without asking it: none of ${ids.join(', ')} is a recorded answer to a question about ${row.id} asked after the one that deferred it. Ask it (action_required / USER_DECISION_REQUIRED, with ${row.id} in the question title) or, when an answer already made it moot, record \`불필요 — <question id>: <chosen option> 때문에 …\`.`;
}

// A row that was 보류(후속) in the published analysis of the previous execution may not vanish or be settled without asking.
export async function deferredResolutionErrors({ published, analysis, status, session = null, previousExecution = null }) {
  const errors = [];
  const current = new Map(decisionRows(analysis).map((row) => [row.id, row]));
  for (const before of deferredRows(published)) {
    const row = current.get(before.id);
    const drop = (message) => errors.push(error('DEFERRED_QUESTION_DROPPED', message));
    if (!row) { drop(`${before.id} was 보류(후속) (${before.target || 'waiting for an answer'}) and has vanished from the analysis. Keep its row: ask it now, or record the decision with its source.`); continue; }
    const state = row.state;
    const moot = row.kind === 'OPEN' ? state === '해당 없음' && MOOT.test(row.source) : /^불필요/.test(state);
    const settled = row.kind === 'OPEN' ? state === '확정' || moot : /^(?:채택|기각|보류(?!\())/.test(state) || moot;
    if (!settled) {
      if (status === 'completed') drop(`${before.id} was 보류(후속) and is still ${state || 'unrecorded'} but the stage returns completed. Ask it now (action_required / USER_DECISION_REQUIRED) and complete only with the answer.`);
      continue;
    }
    if (row.kind === 'CAND' && moot && !MOOT.test(state)) { drop(`${before.id} is 불필요 without \`불필요 — <question id>: <chosen option> 때문에 …\`.`); continue; }
    const problem = await deferredSourceProblem({ row, session, previousExecution });
    if (problem) drop(problem);
  }
  return errors;
}

// `legacy` exempts a resumed analysis written before the `미확정 사실` table existed; `root` enables the document-path check.
// One batch of two or more questions shows its recommended options as one situation (`- 추천 조합 시나리오: <한두 문장>`), so a contradiction between them is visible.
export const SCENARIO_LINE = /^\s*[-*]\s*추천 조합 시나리오\s*:[ \t]*(\S.*)$/m;
export const hasRecommendedScenario = (analysis) => SCENARIO_LINE.test(String(analysis ?? ''));

// `legacyScenario` exempts a resumed analysis written before the `추천 조합 시나리오` line existed.
export function checkStakeholderAnalysis({ request, analysis, status, questions = 0, legacy = false, legacyCandidates = false, legacyScenario = false, legacyReflection = false, legacyDeferred = false, requirements = null, root = null, sourceMaterials = [] }) {
  if (stakeholderAnalysisSkipped(analysis)) return { ok: true, skipped: true, errors: [] };
  const text = String(request ?? '');
  const tables = parseTables(analysis);
  const errors = [];
  const participants = tables.filter((table) => table.header.includes('ID') && table.header.includes('구분') && !isOpenFactTable(table)).flatMap((table) => table.rows);
  if (!participants.some((row) => clean(row.ID) === REQUESTER_ID)) {
    errors.push(error('REQUESTER_MISSING', `The participant table has no ${REQUESTER_ID} row. The requester is always a participant: the features the request names are the requester's settled requirements.`));
  }
  const features = tables.filter((table) => table.header.includes('요청 기능') && table.header.includes('요청 문구')).flatMap((table) => table.rows);
  if (!features.length) errors.push(error('REQUESTED_FEATURES_MISSING', 'The requested-feature table (요청 기능 | 요청 문구 | 제안자 | 결정 | 출처) is missing or empty. Extract each concrete capability the requester asks for, using exact request or attached-source quotes as anchors.'));
  const materialAnchors = [];
  for (const row of features) {
    const phrase = unquote(row['요청 문구']);
    const material = phrase && !text.includes(phrase) ? sourceMaterialAnchor(phrase, sourceMaterials) : null;
    if (!phrase || (!text.includes(phrase) && !material)) errors.push(error('REQUESTED_FEATURE_NOT_QUOTED', `Requested feature "${clean(row['요청 기능'])}" quotes "${phrase}", which is not an exact substring of the request or an attached text source.`));
    if (material) {
      materialAnchors.push({ row, ...material });
      const citation = clean(row['출처']);
      if (!citation.includes(material.path) || !citation.includes(`:${material.line}`)) errors.push(error('REQUESTED_FEATURE_SOURCE_MISSING', `Requested feature "${clean(row['요청 기능'])}" is anchored in attached material at ${material.path}:${material.line}; cite that exact path and line in 출처.`));
    }
    if (row['결정'] !== undefined && clean(row['결정']) !== '확정') errors.push(error('REQUESTED_FEATURE_ASKED', `Requested feature "${clean(row['요청 기능'])}" is recorded as "${clean(row['결정'])}". A feature the request names is settled by the requester (결정: 확정) and is never asked for adoption or scope.`));
  }
  if (sourceMaterials.length) {
    const structuredSource = sourceMaterials.some(({ text: content }) => [...content.matchAll(/^\s*#{1,6}\s+.+$/gm)].length >= 2 || content.split(/\r?\n/).filter((line) => /^\s*[-*+]\s+\S/.test(line)).length >= 2);
    if (structuredSource && features.length === 1 && broadGoal(features[0]['요청 기능'])) errors.push(error('REQUESTED_FEATURES_UNDECOMPOSED', `"${clean(features[0]['요청 기능'])}" is only a broad goal, while the attached source has multiple sections or items. Keep the goal in the request context, split its concrete capabilities into separate REQUESTER / 확정 rows, and anchor each row to an exact quote with the attached path and line.`));
    if (structuredSource && !materialAnchors.length) errors.push(error('REQUESTED_FEATURES_NOT_EXTRACTED', 'The request names attached source material with multiple sections or items, but no requested feature is anchored in it. Extract concrete capabilities from that source before asking about unresolved content.'));
  }
  if (!legacyCandidates) {
    for (const row of deferringCandidates(analysis)) {
      errors.push(error('CANDIDATE_DEFERS_DECISION', `${clean(row.CAND)} states "${clean(row['내용'])}", which only says that something is to be decided, so adopting it settles nothing. Rewrite it as a complete rule with an observable outcome, or as 2-3 concrete options asked as the choice (record the persona wording as 원문 in 근거); when it depends on another answer record the decision as 보류(후속) and do not ask it now.`));
    }
  }
  if (!legacyScenario && status === 'action_required' && questions >= 2 && !hasRecommendedScenario(analysis)) {
    errors.push(error('RECOMMENDED_SCENARIO_MISSING', 'The result asks two or more questions but stakeholder-analysis.md has no non-empty `- 추천 조합 시나리오:` line (in the open-facts / candidate section). Write one or two Korean sentences that apply ALL recommended options to the same concrete situation; when the sentences contradict each other, change a recommendation or defer the dependent question.'));
  }
  for (const row of deferredRows(analysis)) {
    if (status === 'completed') errors.push(error('DEFERRED_QUESTION_PENDING', `${row.id} is still 보류(후속) but the stage returns completed. Ask it now (action_required / USER_DECISION_REQUIRED, ${row.id} in the question title) and record the answer, or record \`불필요 — <question id>: <chosen option> 때문에 …\` when a recorded answer made it moot.`));
    else if (!legacyDeferred && row.target.length < 4) errors.push(error('DEFERRED_TARGET_MISSING', `${row.id} is 보류(후속) without the question or option it waits on. Write it after the marker, for example \`보류(후속): <question id or option label> 답에 달림\`.`));
  }
  const observationTables = tables.filter((table) => table.header.includes('제안자') && table.header.includes('관찰'));
  for (const table of observationTables) {
    if (!table.header.includes('요청 앵커')) {
      if (table.rows.length) errors.push(error('OBSERVATION_ANCHOR_MISSING', 'The out-of-scope observation table has no 요청 앵커 column. Quote each observation\'s anchor so the runner can check that it is not in the request.'));
      continue;
    }
    for (const row of table.rows) {
      const anchor = unquote(row['요청 앵커']);
      if (anchor && text.includes(anchor)) {
        errors.push(error('ANCHORED_CANDIDATE_EXCLUDED', `The observation of ${clean(row['제안자'])} ("${clean(row['관찰'])}") anchors on "${anchor}", which is in the request. A candidate whose anchor is an exact substring of the request is a CAND-xx asked to the user (it may refine a requested feature); move it to the candidate table and ask it.`));
      }
    }
  }
  const openRows = openFactRows(analysis);
  if (openRows === null) {
    if (!legacy) errors.push(error('OPEN_FACTS_MISSING', 'The `미확정 사실` table (ID | 구분 | 사실 | 바뀌는 동작 | 처리 | 근거) is missing. List every fact that changes permission, data, screen behavior or external integration and is not settled, as OPEN-01…, even when there is only the 이용 조건 row.'));
    return { ok: errors.length === 0, errors };
  }
  if (!openRows.some((row) => clean(row['구분']) === ACCESS_KIND)) errors.push(error('OPEN_FACT_ACCESS_MISSING', 'The `미확정 사실` table has no 구분 `이용 조건` row. Record who may use or see the feature (처리 해당 없음 with a reason only when the feature has no user-facing surface).'));
  if (status === 'completed' && !legacyReflection && requirements !== null) {
    for (const row of openRows.filter(settledAccessRow)) {
      const id = clean(row.ID);
      if (!String(requirements).includes(id)) errors.push(error('OPEN_FACT_NOT_REFLECTED', `${id} (${clean(row['사실'])}) is 확정 but requirements.md never cites ${id}. Add ${id} to the source of the requirements.md draft line that states its outcome, for example \`출처: CAND-02 채택, ${id}, answers.json <question_id>\`, then return again.`));
    }
  }
  for (const row of openRows) {
    const id = clean(row.ID);
    const kind = clean(row['구분']);
    const state = clean(row['처리']);
    const basis = clean(row['근거']);
    const bad = (message) => errors.push(error('OPEN_FACT_INVALID', `${id || '(no ID)'}: ${message}`));
    if (!/^OPEN-\d+$/.test(id)) bad('the ID must be OPEN-01, OPEN-02, …');
    if (!OPEN_FACT_KINDS.includes(kind)) bad(`구분 "${kind}" must be one of ${OPEN_FACT_KINDS.join(', ')}.`);
    if (DEFERRED.test(state)) { /* checked with the deferred rows */ }
    else if (!['미정', '확정', '해당 없음'].includes(state)) bad(`처리 "${state}" must be 미정, 확정 or 해당 없음.`);
    else if (state === '해당 없음' && !basis.replace(/^[-–—]+$/, '')) bad('처리 해당 없음 needs the reason in 근거.');
    else if (state === '확정') {
      const reason = openFactBasisProblem({ basis, request: text, root });
      if (reason) bad(reason);
    }
    if (status === 'completed' && state === '미정') errors.push(error('OPEN_FACT_UNRESOLVED', `${id} is still 미정 but the stage returns completed. Ask it with the candidate questions (action_required / USER_DECISION_REQUIRED, recommended option and reason), then record the answer here.`));
  }
  if (status === 'action_required' && openRows.some((row) => clean(row['처리']) === '미정') && !questions) {
    errors.push(error('OPEN_FACT_UNRESOLVED', 'A `미확정 사실` row is 미정 but the result carries no question. Ask each 미정 row together with the candidate questions.'));
  }
  for (const table of tables.filter((item) => item.header.includes('제안자') && item.header.includes('관찰'))) {
    for (const row of table.rows) {
      const body = `${clean(row['관찰'])} ${clean(row['근거'])}`;
      if (MISFILED_UNKNOWN.test(body) && MISFILED_BEHAVIOR.test(body)) {
        errors.push(error('OPEN_FACT_MISFILED', `The observation of ${clean(row['제안자'])} ("${clean(row['관찰'])}") reports an unknown that changes permission, access or exposure. Move it to the \`미확정 사실\` table as an OPEN row and ask it; an observation holds only what changes no behavior.`));
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function openFactBasisProblem({ basis, request, root }) {
  const value = basis.replace(/^`|`$/g, '');
  const quoted = /^요청 원문\s*["'“”‘’「」『』](.+)["'“”‘’「」『』]$/.exec(value);
  if (quoted) return request.includes(quoted[1].trim()) ? null : `the quoted 요청 원문 "${quoted[1].trim()}" is not an exact substring of the request.`;
  if (/answers\.json/.test(value) || /(?:^|[\s`])[A-Za-z0-9][A-Za-z0-9_-]*:\d+(?:$|[\s`,])/.test(value)) return null;
  const path = value.replace(/[`"']/g, '').split(/[\s,]+/)[0];
  if (/^[\w./-]+\.\w+$/.test(path) && !isAbsolute(path) && !normalize(path).startsWith('..')) {
    return root === null || existsSync(join(root, path)) ? null : `the cited document ${path} does not exist in the workspace.`;
  }
  return '처리 확정 needs 근거 as `요청 원문 "<exact request text>"`, an answers.json or `<execution-id>:<n>` question reference, or an existing workspace-relative document path.';
}

// The runner's verdict when stakeholder-analysis returns its questions or completes; null when the check does not apply.
export async function evaluateStakeholderAnalysisGate({ root, input, envelope, draftExecutionId }) {
  const planSetId = input?.context?.plan_set_id;
  if (input?.skill !== STAGE || !planSetId || !['completed', 'action_required'].includes(envelope?.status)) return null;
  const { materials: sourceMaterials } = await readRequestSourceMaterials(input.scope);
  const analysis = await planSetDocument(root, planSetId, 'stakeholder-analysis.md', draftExecutionId);
  if (analysis.text === null) return { stage: STAGE, ok: false, errors: [error('DOCUMENT_MISSING', `${analysis.path} does not exist; write it at this exact path (resolve it with harness-spec-path.mjs) before the stage returns.`)] };
  // Discriminator: every resume (answer, feedback, reopen, revision) of an earlier execution carries `context.previous_result_ref`.
  // Such a resume is exempt only when the published (non-draft) analysis already exists without the table; a new analysis,
  // or a resume of one that was written with the table, must have it.
  const requirements = await planSetDocument(root, planSetId, 'requirements.md', draftExecutionId);
  let legacy = false, legacyCandidates = false, legacyScenario = false, legacyReflection = false, legacyDeferred = false;
  let resolution = [];
  if (input.context?.previous_result_ref) {
    const published = draftExecutionId ? await planSetDocument(root, planSetId, 'stakeholder-analysis.md') : analysis;
    const earlier = published.text !== null && !stakeholderAnalysisSkipped(published.text);
    legacy = earlier && openFactRows(published.text) === null;
    // An analysis written before the deferring-statement rule keeps the candidates it already has.
    legacyCandidates = earlier && deferringCandidates(published.text).length > 0;
    // So is an analysis written before the recommended-combination scenario line.
    legacyScenario = earlier && !hasRecommendedScenario(published.text);
    // And one completed before requirements.md cited its settled 이용 조건 ids: the published draft settles one it does not cite.
    const publishedRequirements = draftExecutionId ? await planSetDocument(root, planSetId, 'requirements.md') : requirements;
    // A published 보류(후속) row that names no waiting target predates the target rule.
    legacyDeferred = earlier && deferredRows(published.text).some((row) => !row.target);
    // The rows deferred in the published analysis need their question asked: compared only against a distinct draft.
    if (earlier && draftExecutionId) {
      const session = typeof input.session_directory === 'string' && isAbsolute(input.session_directory) ? input.session_directory : null;
      const previousExecution = /executions\/([A-Za-z0-9][A-Za-z0-9_-]*)\//.exec(String(input.context.previous_result_ref))?.[1] ?? null;
      resolution = await deferredResolutionErrors({ published: published.text, analysis: analysis.text, status: envelope.status, session, previousExecution });
    }
    legacyReflection = earlier && publishedRequirements.text !== null && (openFactRows(published.text) ?? []).some((row) => settledAccessRow(row) && !publishedRequirements.text.includes(clean(row.ID)));
  }
  const checked = checkStakeholderAnalysis({ request: input.scope, analysis: analysis.text, status: envelope.status, questions: envelope.result?.questions?.length ?? 0, legacy, legacyCandidates, legacyScenario, legacyReflection, legacyDeferred, requirements: requirements.text, root, sourceMaterials });
  const errors = [...checked.errors, ...resolution];
  return { stage: STAGE, ...checked, ok: errors.length === 0, errors };
}

export const stakeholderAnalysisFailureInstruction = (verdict) => `The runner checked stakeholder-analysis.md for ${verdict.stage} and it failed. Nothing was committed or recorded, and the stage is still running. Return these errors to the same subagent so it repairs stakeholder-analysis.md (and its questions when a candidate moves back into the candidate table), rewrites its output file, then run finish again. Never ask the user whether a feature the request names is in scope. When the request cites attached reference material, extract concrete capabilities from it before drafting the requested-feature table; cite attached anchors as <absolute path>:<line>. A broad goal such as "RAG 개선" is not a substitute for the capabilities described by its source. Ask each 미정 row of "미확정 사실" together with the candidate questions instead of recording it as an observation.`;

export class StakeholderAnalysisError extends Error {
  constructor(verdict) {
    super(`Stakeholder analysis check failed: ${verdict.errors.map((item) => `${item.code} ${item.message}`).join('; ')}`);
    this.name = 'StakeholderAnalysisError';
    this.verdict = verdict;
  }
}

export async function assertStakeholderAnalysisGate(options) {
  const verdict = await evaluateStakeholderAnalysisGate(options);
  if (verdict && !verdict.ok) throw new StakeholderAnalysisError(verdict);
  return verdict;
}
