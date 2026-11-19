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

export function checkStakeholderAnalysis({ request, analysis, strict = false, complete = false, userRevision = false }) {
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
    if (strict && clean(row['제안자']) !== REQUESTER_ID) errors.push(error('REQUESTED_FEATURE_REQUESTER_INVALID', `Requested feature "${clean(row['요청 기능'])}" must be declared by REQUESTER.`));
    const phrase = unquote(row['요청 문구']);
    if (!phrase || !text.includes(phrase)) errors.push(error('REQUESTED_FEATURE_NOT_QUOTED', `Requested feature "${clean(row['요청 기능'])}" quotes "${phrase}", which is not an exact substring of the request.`));
    if (strict && row['결정'] === undefined) errors.push(error('REQUESTED_FEATURE_NOT_CONFIRMED', `Requested feature "${clean(row['요청 기능'])}" needs 결정: 확정.`));
    if (row['결정'] !== undefined && clean(row['결정']) !== '확정') errors.push(error('REQUESTED_FEATURE_ASKED', `Requested feature "${clean(row['요청 기능'])}" is recorded as "${clean(row['결정'])}". A feature the request names is settled by the requester (결정: 확정) and is never asked for adoption or scope.`));
    if (strict && !/요청\s*원문/.test(clean(row['출처']))) errors.push(error('REQUESTED_FEATURE_SOURCE_MISSING', `Requested feature "${clean(row['요청 기능'])}" needs source REQUESTER / 요청 원문.`));
  }
  const actionTables = tables.filter((table) => table.header.includes('ACT') && table.header.includes('행동') && table.header.includes('결정'));
  if (!actionTables.length && strict) errors.push(error('REQUESTED_ACTIONS_MISSING', 'The requested-action table (ACT | 요청 기능 | 행위자 | 행동 | 결정 | evidence) is required. Settle action-level scope without asking whether a requested top-level feature is included.'));
  if (actionTables.length) {
    const seen = new Set();
    const actionRows = actionTables.flatMap((table) => table.rows);
    const featureNames = new Set(features.map((row) => clean(row['요청 기능']).toLowerCase()));
    for (const row of actionRows) {
      const id = clean(row.ACT), decision = clean(row['결정']), action = clean(row['행동']);
      if (!/^ACT-\d+$/.test(id) || seen.has(id)) errors.push(error('ACTION_ID_INVALID', 'Requested action has missing, invalid or duplicate stable ID: ' + (id || '(blank)')));
      seen.add(id);
      if (!action || /^(?:-|TBD|TODO|미정|없음)$/i.test(action)) errors.push(error('ACTION_INCOMPLETE', (id || 'ACT') + ' needs a concrete independently reviewable action.'));
      if (strict && (!clean(row['행위자']) || /^(?:-|TBD|TODO|미정|없음)$/i.test(clean(row['행위자'])))) errors.push(error('ACTION_ACTOR_MISSING', (id || 'ACT') + ' needs a named business actor.'));
      if (strict && !clean(row['근거/answer ID'] || row['결정 출처'])) errors.push(error('ACTION_EVIDENCE_MISSING', (id || 'ACT') + ' needs request or user-answer evidence.'));
      if (!['포함', '제외', '후속', '대기', '관찰'].some((value) => decision.startsWith(value))) errors.push(error('ACTION_DECISION_INVALID', id + ' must be included, excluded, workflow follow-up, pending, or an optional observation.'));
      if (strict && complete && decision.startsWith('대기')) errors.push(error('ACTION_SCOPE_PENDING', id + ' has an unresolved required scope decision.'));
      if (strict && featureNames.size && clean(row['요청 기능']) && !featureNames.has(clean(row['요청 기능']).toLowerCase())) errors.push(error('ACTION_FEATURE_UNKNOWN', id + ' refers to a feature absent from the REQUESTER feature table.'));
      if (decision.startsWith('포함') && !clean(row['요청 기능'])) errors.push(error('ACTION_FEATURE_MISSING', id + ' has no requested feature link.'));
      if ((decision.startsWith('제외') || decision.startsWith('후속')) && !clean(row['근거/answer ID'] || row['결정 출처'])) errors.push(error('ACTION_EVIDENCE_MISSING', id + ' ' + decision + ' needs a user answer ID or request evidence.'));
      if (strict && /선택|optional|관찰/i.test(clean(row['종류'])) && decision.startsWith('포함') && !/(?:answers\.json|question_id|q:\s*\d+)/i.test(clean(row['근거/answer ID'] || row['결정 출처']))) errors.push(error('OPTIONAL_ACTION_NEEDS_USER_DECISION', id + ' is an optional action and needs a recorded direct user scope answer before inclusion.'));
      if (strict && /명시/.test(clean(row['종류'])) && (decision.startsWith('제외') || decision.startsWith('후속')) && (!userRevision || !/(?:answers\.json|question_id|q:\s*\d+)/i.test(clean(row['근거/answer ID'] || row['결정 출처'])))) errors.push(error('EXPLICIT_ACTION_REVISION_EVIDENCE_MISSING', id + ' changes an explicit requested action and needs a new direct user revision answer receipt.'));
    }
    if (complete) for (const feature of features) if (!actionRows.some((row) => clean(row['요청 기능']).toLowerCase() === clean(feature['요청 기능']).toLowerCase() && clean(row['결정']).startsWith('포함'))) errors.push(error('REQUESTED_FEATURE_ACTION_MISSING', `Requested feature "${clean(feature['요청 기능'])}" has no included concrete action.`));
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
export async function evaluateStakeholderAnalysisGate({ root, input, envelope }) {
  const planSetId = input?.context?.plan_set_id;
  if (input?.skill !== STAGE || !planSetId || !['completed', 'action_required'].includes(envelope?.status)) return null;
  const analysis = await planSetDocument(root, planSetId, 'stakeholder-analysis.md');
  if (analysis.text === null) return { stage: STAGE, ok: false, errors: [error('DOCUMENT_MISSING', `${analysis.path} does not exist; write it at this exact path (resolve it with harness-spec-path.mjs) before the stage returns.`)] };
  return { stage: STAGE, ...checkStakeholderAnalysis({ request: input.scope, analysis: analysis.text, strict: input?.context?.requirements_contract_version === 1, complete: envelope.status === 'completed' && envelope.code === 'OK', userRevision: input?.context?.user_revision === true }) };
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
