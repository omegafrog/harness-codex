// Deterministic check of stakeholder-analysis.md when stakeholder-analysis returns its questions or completes.
// The requester is a stakeholder: every feature the request names is a settled requirement of the requester, never a
// candidate the user is asked to adopt. The check holds only what can be read mechanically:
// - the participant table lists the requester (`REQUESTER`);
// - the requested-feature table (`요청 기능` / `요청 문구` columns) has a row for at least one feature, each quoting the
//   request verbatim and recorded as `확정`;
// - an observation moved out of scope quotes its request anchor (`요청 앵커`), and that anchor is NOT in the request.
//   A persona candidate whose anchor is in the request is asked as a candidate; no other reason excludes it.
// Contextual judgement (which phrases are features, which candidates restate the request) belongs to the stage GUIDE.
import { clean, parseTables, planSetDocument, stakeholderAnalysisSkipped } from './domain-model-gate.mjs';
import { WORKTREE_STAGE } from './worktree-stages.mjs';

export const REQUESTER_ID = 'REQUESTER';
const STAGE = WORKTREE_STAGE.STAKEHOLDER_ANALYSIS;
const unquote = (value) => clean(value).replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
const error = (code, message) => ({ code, message, owner_stage: STAGE });

export function checkStakeholderAnalysis({ request, analysis }) {
  if (stakeholderAnalysisSkipped(analysis)) return { ok: true, skipped: true, errors: [] };
  const text = String(request ?? '');
  const tables = parseTables(analysis);
  const errors = [];
  const participants = tables.filter((table) => table.header.includes('ID') && table.header.includes('구분')).flatMap((table) => table.rows);
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
  return { ok: errors.length === 0, errors };
}

// The runner's verdict when stakeholder-analysis returns its questions or completes; null when the check does not apply.
export async function evaluateStakeholderAnalysisGate({ root, input, envelope, draftExecutionId }) {
  const planSetId = input?.context?.plan_set_id;
  if (input?.skill !== STAGE || !planSetId || !['completed', 'action_required'].includes(envelope?.status)) return null;
  const analysis = await planSetDocument(root, planSetId, 'stakeholder-analysis.md', draftExecutionId);
  if (analysis.text === null) return { stage: STAGE, ok: false, errors: [error('DOCUMENT_MISSING', `${analysis.path} does not exist; write it at this exact path (resolve it with harness-spec-path.mjs) before the stage returns.`)] };
  return { stage: STAGE, ...checkStakeholderAnalysis({ request: input.scope, analysis: analysis.text }) };
}

export const stakeholderAnalysisFailureInstruction = (verdict) => `The runner checked stakeholder-analysis.md for ${verdict.stage} and it failed. Nothing was committed or recorded, and the stage is still running. Return these errors to the same subagent so it repairs stakeholder-analysis.md (and its questions when a candidate moves back into the candidate table), rewrites its output file, then run finish again. Never ask the user whether a feature the request names is in scope.`;

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
