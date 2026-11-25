// Deterministic check of stakeholder-analysis.md when stakeholder-analysis returns its questions or completes.
// The requester is a stakeholder: every feature the request names is a settled requirement of the requester, never a
// candidate the user is asked to adopt. The check holds only what can be read mechanically:
// - the participant table lists the requester (`REQUESTER`);
// - the requested-feature table (`요청 기능` / `요청 문구` columns) has a row for at least one feature, each quoting the
//   request verbatim and recorded as `확정`;
// - an observation moved out of scope quotes its request anchor (`요청 앵커`), and that anchor is NOT in the request.
//   A persona candidate whose anchor is in the request is asked as a candidate; no other reason excludes it.
// - the `미확정 사실` table (`ID | 구분 | 사실 | 바뀌는 동작 | 처리 | 근거`) holds each fact that changes behavior and is not settled:
//   it always has an `이용 조건` row, a `확정` row cites its source, a `해당 없음` row gives its reason, no row is `미정` when the stage
//   completes, and an unknown that changes behavior is not filed as an out-of-scope observation.
// Contextual judgement (which phrases are features, which candidates restate the request) belongs to the stage GUIDE.
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
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
const error = (code, message) => ({ code, message, owner_stage: STAGE });

// `legacy` exempts a resumed analysis written before the `미확정 사실` table existed; `root` enables the document-path check.
export function checkStakeholderAnalysis({ request, analysis, status, questions = 0, legacy = false, root = null }) {
  if (stakeholderAnalysisSkipped(analysis)) return { ok: true, skipped: true, errors: [] };
  const text = String(request ?? '');
  const tables = parseTables(analysis);
  const errors = [];
  const participants = tables.filter((table) => table.header.includes('ID') && table.header.includes('구분') && !isOpenFactTable(table)).flatMap((table) => table.rows);
  if (!participants.some((row) => clean(row.ID) === REQUESTER_ID)) {
    errors.push(error('REQUESTER_MISSING', `The participant table has no ${REQUESTER_ID} row. The requester is always a participant: the features the request names are the requester's settled requirements.`));
  }
  const features = tables.filter((table) => table.header.includes('요청 기능') && table.header.includes('요청 문구')).flatMap((table) => table.rows);
  if (!features.length) errors.push(error('REQUESTED_FEATURES_MISSING', 'The requested-feature table (요청 기능 | 요청 문구 | 제안자 | 결정 | 출처) is missing or empty. List every feature the request names, quoted verbatim, as a settled requirement of REQUESTER.'));
  for (const row of features) {
    const phrase = unquote(row['요청 문구']);
    if (!phrase || !text.includes(phrase)) errors.push(error('REQUESTED_FEATURE_NOT_QUOTED', `Requested feature "${clean(row['요청 기능'])}" quotes "${phrase}", which is not an exact substring of the request.`));
    if (row['결정'] !== undefined && clean(row['결정']) !== '확정') errors.push(error('REQUESTED_FEATURE_ASKED', `Requested feature "${clean(row['요청 기능'])}" is recorded as "${clean(row['결정'])}". A feature the request names is settled by the requester (결정: 확정) and is never asked for adoption or scope.`));
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
  if (!openRows.some((row) => clean(row['구분']) === ACCESS_KIND)) errors.push(error('OPEN_FACT_ACCESS_MISSING', 'The `미확정 사실` table has no 구분 `이용 조건` row. Always record who may use the feature and whether login is needed (처리 해당 없음 with a reason only when the feature has no user-facing surface).'));
  for (const row of openRows) {
    const id = clean(row.ID);
    const kind = clean(row['구분']);
    const state = clean(row['처리']);
    const basis = clean(row['근거']);
    const bad = (message) => errors.push(error('OPEN_FACT_INVALID', `${id || '(no ID)'}: ${message}`));
    if (!/^OPEN-\d+$/.test(id)) bad('the ID must be OPEN-01, OPEN-02, …');
    if (!OPEN_FACT_KINDS.includes(kind)) bad(`구분 "${kind}" must be one of ${OPEN_FACT_KINDS.join(', ')}.`);
    if (!['미정', '확정', '해당 없음'].includes(state)) bad(`처리 "${state}" must be 미정, 확정 or 해당 없음.`);
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
  const analysis = await planSetDocument(root, planSetId, 'stakeholder-analysis.md', draftExecutionId);
  if (analysis.text === null) return { stage: STAGE, ok: false, errors: [error('DOCUMENT_MISSING', `${analysis.path} does not exist; write it at this exact path (resolve it with harness-spec-path.mjs) before the stage returns.`)] };
  // Discriminator: every resume (answer, feedback, reopen, revision) of an earlier execution carries `context.previous_result_ref`.
  // Such a resume is exempt only when the published (non-draft) analysis already exists without the table; a new analysis,
  // or a resume of one that was written with the table, must have it.
  let legacy = false;
  if (input.context?.previous_result_ref) {
    const published = draftExecutionId ? await planSetDocument(root, planSetId, 'stakeholder-analysis.md') : analysis;
    legacy = published.text !== null && !stakeholderAnalysisSkipped(published.text) && openFactRows(published.text) === null;
  }
  return { stage: STAGE, ...checkStakeholderAnalysis({ request: input.scope, analysis: analysis.text, status: envelope.status, questions: envelope.result?.questions?.length ?? 0, legacy, root }) };
}

export const stakeholderAnalysisFailureInstruction = (verdict) => `The runner checked stakeholder-analysis.md for ${verdict.stage} and it failed. Nothing was committed or recorded, and the stage is still running. Return these errors to the same subagent so it repairs stakeholder-analysis.md (and its questions when a candidate moves back into the candidate table), rewrites its output file, then run finish again. Never ask the user whether a feature the request names is in scope. Ask each 미정 row of "미확정 사실" together with the candidate questions instead of recording it as an observation.`;

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
