import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, open, rename, unlink } from 'node:fs/promises';
import { sessionOutputPath } from './session-output.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SPEC_PREPARATION_ABORT = 'pre-dispatch preparation: ';
const MAX_PREPARATION_ABORTS = 3;
const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
function requireValue(value, message) { if (!value) throw new Error(message); }
function trailingPreparationAbortCount(history) {
  const start = history.preparation_resolution?.after || 0;
  const pending = history.attempts.slice(start);
  const previousSubstantive = pending.findLastIndex((item) => !item.pre_dispatch_preparation);
  return pending.slice(previousSubstantive + 1).filter((item) => item.pre_dispatch_preparation).length;
}
function lastSubstantiveAttempt(history) { return history.attempts.findLast((item) => !item.pre_dispatch_preparation); }
function lastRecordedReview(history) { return history.attempts.findLast((item) => item.review && ['pass', 'revise'].includes(item.status)); }
function resolutionApplied(history, substantive) {
  return Boolean(history.resolution && (!substantive || history.attempts.indexOf(substantive) < history.resolution.after));
}
function historyPath(root, scope, options = {}) {
  requireValue(ID.test(scope || ''), 'Valid review scope is required');
  return sessionOutputPath(root, `runtime/reviews/${scope}.json`, options);
}
function validateHistory(history) {
  requireValue(Array.isArray(history.attempts) && (history.repairs === undefined || Array.isArray(history.repairs)), 'Invalid review history');
  requireValue(!history.resolution || Number.isSafeInteger(history.resolution.after) && history.resolution.after > 0 && history.resolution.after <= history.attempts.length && history.attempts[history.resolution.after - 1].round === 3 && !['active', 'pass'].includes(history.attempts[history.resolution.after - 1].status) && typeof history.resolution.reason === 'string' && history.resolution.reason.trim(), 'Invalid review resolution');
  requireValue(!history.preparation_resolution || Number.isSafeInteger(history.preparation_resolution.after) && history.preparation_resolution.after > 0 && history.preparation_resolution.after <= history.attempts.length && history.attempts.slice(0, history.preparation_resolution.after).at(-1)?.pre_dispatch_preparation && typeof history.preparation_resolution.reason === 'string' && history.preparation_resolution.reason.startsWith('preparation recovery: ') && history.preparation_resolution.reason.trim().length > 'preparation recovery: '.length, 'Invalid preparation recovery');
  const repairs = history.repairs || [];
  requireValue(repairs.every((item) => item && Number.isSafeInteger(item.round) && item.round >= 1 && Number.isSafeInteger(item.limit) && item.limit >= item.round && item.limit <= 2 && typeof item.inputs?.fixed_point === 'string' && item.inputs.fixed_point && typeof item.inputs?.implementation_commit_sha === 'string' && item.inputs.implementation_commit_sha && Array.isArray(item.findings)), 'Invalid repair reservation');
  requireValue(!history.repair_resolution || Number.isSafeInteger(history.repair_resolution.after) && history.repair_resolution.after > 0 && history.repair_resolution.after <= repairs.length && repairs[history.repair_resolution.after - 1].round === repairs[history.repair_resolution.after - 1].limit && typeof history.repair_resolution.reason === 'string' && history.repair_resolution.reason.trim() && ((!history.repair_resolution.previous_snapshot_sha256 && !history.repair_resolution.current_snapshot_sha256) || (/^[a-f0-9]{64}$/.test(history.repair_resolution.previous_snapshot_sha256 || '') && /^[a-f0-9]{64}$/.test(history.repair_resolution.current_snapshot_sha256 || '') && history.repair_resolution.previous_snapshot_sha256 !== history.repair_resolution.current_snapshot_sha256)), 'Invalid repair resolution');
  requireValue(history.attempts.every((item) => item && ['active', 'pass', 'revise', 'stale', 'aborted'].includes(item.status) && Number.isSafeInteger(item.round) && item.round >= 1 && item.round <= 3 && (!item.review || Array.isArray(item.review.findings))), 'Invalid recorded review');
  requireValue(history.attempts.every((item) => !item.native_review || typeof item.native_review.reviewer_id === 'string' && item.native_review.reviewer_id && typeof item.native_review.dispatch_token === 'string' && item.native_review.dispatch_token && typeof item.native_review.parent_session_id === 'string' && item.native_review.parent_session_id && typeof item.native_review.execution_id === 'string' && item.native_review.execution_id && (!item.native_review.agent_id || typeof item.native_review.agent_id === 'string' && typeof item.native_review.stopped === 'boolean' && (!item.native_review.stopped || typeof item.native_review.result === 'string' && item.native_review.result.trim() && ['pass', 'revise', 'reject', 'blocked'].includes(item.native_review.review?.verdict) && Array.isArray(item.native_review.review.findings)))), 'Invalid native review claim');
  requireValue(repairs.every((item, index) => !index ? item.round === 1 : item.round === 1 ? repairs[index - 1].round === repairs[index - 1].limit : item.round === repairs[index - 1].round + 1 && item.limit === repairs[index - 1].limit), 'Invalid historical repair cycle');
  const cycle = repairs.slice(history.repair_resolution?.after || 0);
  requireValue(cycle.every((item, index) => item.round === index + 1 && item.limit === cycle[0].limit), 'Invalid current repair cycle');
  return history;
}
async function readHistory(path) {
  try { return validateHistory(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { attempts: [] }; throw error; }
}

// Serialize admission and result writes; the persisted active attempt owns the review slot.
export async function updateReviewAttempt({ root, scope, action, inputs, attemptId, review, reason, resolution, maxRounds = 1, findings = [], reviewerId, nativeAgentId, nativeResult, nativeReview, parentSessionId, executionId }) {
  const path = historyPath(root, scope);
  const lock = await open(`${path}.lock`, 'wx').catch((error) => {
    if (error.code === 'EEXIST') throw new Error('Review history is being updated; retry after the current command finishes');
    throw error;
  });
  try {
    const history = await readHistory(path), last = history.attempts.at(-1);
    let result;
    if (action === 'repair' || action === 'resolve-repair') {
      requireValue(scope.startsWith('implementation-'), 'Implementation repair scope is required');
      history.repairs ||= [];
      if (action === 'resolve-repair') {
        requireValue(history.repairs.length > 0 && typeof resolution?.reason === 'string' && resolution.reason.trim(), 'Explicit user scope/decision resolution is required');
        const cycle = history.repairs.slice(history.repair_resolution?.after || 0);
        requireValue(cycle.length && cycle.length >= cycle[0].limit, 'Resolve requires an exhausted implementation repair cycle');
        requireValue(typeof cycle[0].inputs.plan_set_id === 'string' && /^[a-f0-9]{64}$/.test(cycle[0].inputs.planning_snapshot_sha256 || ''), 'Repair budget reset requires a reviewed planning snapshot');
        requireValue(resolution.previous_snapshot_sha256 === cycle[0].inputs.planning_snapshot_sha256 && /^[a-f0-9]{64}$/.test(resolution.current_snapshot_sha256 || '') && resolution.current_snapshot_sha256 !== resolution.previous_snapshot_sha256, 'Repair budget reset requires a different passing planning snapshot');
        history.repair_resolution = { after: history.repairs.length, reason: resolution.reason, previous_snapshot_sha256: resolution.previous_snapshot_sha256, current_snapshot_sha256: resolution.current_snapshot_sha256 };
        result = { status: 'pass', reason: 'user_resolution_recorded' };
      } else {
        requireValue(Number.isSafeInteger(maxRounds) && maxRounds >= 0 && maxRounds <= 2, 'Repair limit must be an integer from zero to two');
        requireValue(inputs?.fixed_point && inputs?.implementation_commit_sha, 'Fixed point and implementation commit are required');
        const start = history.repair_resolution?.after || 0;
        const cycle = history.repairs.slice(start);
        requireValue(!cycle.length || cycle[0].inputs.fixed_point === inputs.fixed_point, 'Keep the original review fixed point across repair and resume');
        requireValue(!cycle.some((item) => item.inputs.implementation_commit_sha === inputs.implementation_commit_sha), 'This commit already has a reserved repair; resume that correction before requesting another');
        requireValue(!cycle.some((item) => item.inputs.reviewer_ids?.some((id) => inputs.reviewer_ids?.includes(id))), 'Each implementation repair review requires fresh reviewer contexts');
        const limit = cycle.length ? Math.min(cycle[0].limit, maxRounds) : maxRounds;
        if (cycle.length >= limit) throw Object.assign(new Error('Implementation repair budget exhausted; present unresolved findings for a user scope/decision resolution'), { code: 'max_repair_rounds_exceeded', rounds: cycle.length });
        const reservation = { round: cycle.length + 1, limit, inputs, findings };
        history.repairs.push(reservation);
        result = { status: 'pass', ...reservation };
      }
    } else if (action === 'begin') {
      requireValue(inputs && Object.keys(inputs).length > 0, 'Review inputs are required');
      requireValue(last?.status !== 'active', 'A review is already active; record its result or abort it before dispatch');
      requireValue(!last || last.status === 'aborted' || !same(last.inputs, inputs), 'Review inputs are unchanged; reuse the current result or resolve the findings before dispatch');
      const trailingPreparationAborts = trailingPreparationAbortCount(history);
      if (scope.startsWith('spec-')) requireValue(trailingPreparationAborts < MAX_PREPARATION_ABORTS, 'Spec review preparation retry limit exhausted; record preparation recovery before retrying');
      const substantive = lastSubstantiveAttempt(history);
      const round = !substantive || substantive.status === 'pass' || resolutionApplied(history, substantive) ? 1 : substantive.round + 1;
      requireValue(round <= 3, 'Review retry budget exhausted (initial review plus two retries); present unresolved findings for a scope or decision resolution');
      const attempt = { id: randomUUID(), round, status: 'active', inputs };
      history.attempts.push(attempt);
      const previousReview = lastRecordedReview(history);
      result = { status: 'pass', attempt_id: attempt.id, round, inputs, previous_inputs: previousReview?.inputs || null, previous_findings: previousReview?.review.findings || [] };
    } else if (action === 'claim') {
      requireValue(last?.status === 'active' && last.id === attemptId, 'No active review matches this attempt ID');
      requireValue(!last.native_review, 'A native reviewer is already claimed for this attempt');
      requireValue(typeof reviewerId === 'string' && reviewerId.trim() && typeof nativeAgentId === 'string' && nativeAgentId.trim() && typeof parentSessionId === 'string' && parentSessionId.trim() && typeof executionId === 'string' && executionId.trim(), 'Reviewer identity, native dispatch token, parent session, and execution are required');
      last.native_review = { reviewer_id: reviewerId, dispatch_token: nativeAgentId, parent_session_id: parentSessionId, execution_id: executionId };
      result = { status: 'pass', attempt_id: last.id, reviewer_id: reviewerId, dispatch_token: nativeAgentId };
    } else if (action === 'bind-native') {
      requireValue(last?.status === 'active' && last.id === attemptId, 'No active review matches this attempt ID');
      requireValue(last.native_review && last.native_review.parent_session_id === parentSessionId && !last.native_review.agent_id && typeof nativeAgentId === 'string' && nativeAgentId.trim(), 'Native reviewer start does not match its claim');
      requireValue(!history.attempts.some((item) => item.native_review?.agent_id === nativeAgentId), 'Native reviewer identity is already bound to another attempt');
      last.native_review.agent_id = nativeAgentId;
      last.native_review.stopped = false;
      result = { status: 'pass', attempt_id: last.id, native_agent_id: nativeAgentId };
    } else if (action === 'stop-native') {
      let parsed;
      try { parsed = JSON.parse(nativeResult); } catch { parsed = null; }
      requireValue(last?.status === 'active' && last.id === attemptId && last.native_review?.agent_id === nativeAgentId && last.native_review.parent_session_id === parentSessionId && !last.native_review.stopped && typeof nativeResult === 'string' && nativeResult.trim() && parsed && isDeepStrictEqual(Object.keys(parsed).sort(), ['findings', 'verdict']) && nativeReview && isDeepStrictEqual(parsed, nativeReview), 'Native reviewer stop does not match its active claim or has no valid structured result');
      last.native_review.stopped = true;
      last.native_review.result = nativeResult;
      last.native_review.review = nativeReview;
      result = { status: 'pass', attempt_id: last.id, native_agent_id: nativeAgentId };
    } else if (action === 'resolve') {
      requireValue(typeof reason === 'string' && reason.trim(), 'Explicit user scope/decision resolution is required');
      if (scope.startsWith('spec-') && trailingPreparationAbortCount(history) >= MAX_PREPARATION_ABORTS) {
        requireValue(last?.status === 'aborted' && last.pre_dispatch_preparation && reason.startsWith('preparation recovery: ') && reason.trim().length > 'preparation recovery: '.length, 'Preparation recovery must state the repaired pre-dispatch cause');
        history.preparation_resolution = { after: history.attempts.length, reason };
        result = { status: 'pass', reason: 'preparation_recovery_recorded' };
      } else {
        requireValue(last && last.status !== 'active' && last.status !== 'pass' && last.round === 3, 'Resolve requires an exhausted review cycle');
        history.resolution = { after: history.attempts.length, reason };
        result = { status: 'pass', reason: 'user_resolution_recorded' };
      }
    } else {
      requireValue(last?.status === 'active' && last.id === attemptId, 'No active review matches this attempt ID');
      if (action === 'abort') {
        requireValue(typeof reason === 'string' && reason.trim(), 'Abort reason is required');
        last.status = 'aborted'; last.reason = reason;
        if (scope.startsWith('spec-') && !last.native_review && reason.startsWith(SPEC_PREPARATION_ABORT)) last.pre_dispatch_preparation = true;
      } else {
        requireValue(action === 'record', 'Unknown review attempt action');
        if (review) review = { ...review, inputs: last.inputs };
        requireValue(review && ['pass', 'revise', 'reject', 'blocked'].includes(review.verdict), 'Review verdict is required');
        requireValue(typeof review.reviewer_id === 'string' && review.reviewer_id.trim() && Array.isArray(review.author_ids) && review.author_ids.length && review.author_ids.every((id) => typeof id === 'string' && id.trim()) && !review.author_ids.includes(review.reviewer_id) && review.fork_turns === 'none', 'A fresh independent reviewer is required');
        if (last.native_review) requireValue(last.native_review.agent_id && last.native_review.stopped && review.reviewer_id === last.native_review.reviewer_id && isDeepStrictEqual({ verdict: review.verdict, findings: review.findings }, last.native_review.review), 'Recorded review must match the claimed, stopped native reviewer result');
        requireValue(!history.attempts.some((item) => item.review?.reviewer_id === review.reviewer_id), 'Each retry requires a new reviewer');
        requireValue(Array.isArray(review.findings) && review.findings.every((item) => ['blocker', 'major', 'minor'].includes(item.severity) && typeof item.description === 'string' && item.description.trim() && typeof item.evidence === 'string' && item.evidence.trim()), 'Findings need severity, description and evidence');
        requireValue(review.inputs && Object.entries(last.inputs).every(([key, digest]) => review.inputs[key] === digest), 'Review did not use the admitted snapshot');
        last.review = review;
        const current = same(review.inputs, inputs);
        last.status = !current ? 'stale' : review.verdict === 'pass' && review.findings.every((item) => item.severity === 'minor') ? 'pass' : 'revise';
      }
      result = { status: last.status === 'pass' || action === 'abort' ? 'pass' : 'blocked', reason: last.status, attempt_id: last.id, round: last.round, findings: last.review?.findings || [] };
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    return result;
  } finally { await lock.close(); await unlink(`${path}.lock`); }
}

export async function assertReviewAttempt({ root, scope, review }) {
  const history = await readHistory(historyPath(root, scope));
  const last = history.attempts.at(-1);
  requireValue(last?.status === 'pass' && last.review && isDeepStrictEqual(last.review, review), 'Record and supply the authoritative passing result for the current review attempt before advancing');
  return last.review;
}

export async function assertActiveReviewAdmission({ root, scope, attemptId, inputs, requireActive = true }) {
  const history = await readHistory(historyPath(root, scope, { create: false }));
  const last = history.attempts.at(-1);
  requireValue((requireActive ? last?.status === 'active' : ['active', 'pass', 'revise'].includes(last?.status)) && last.id === attemptId && inputs && same(last.inputs, inputs), 'Review admission does not match the active attempt');
}

export async function reviewAdmissionPreviousInputs({ root, scope, attemptId }) {
  const history = await readHistory(historyPath(root, scope, { create: false }));
  const index = history.attempts.findIndex((item) => item.id === attemptId);
  requireValue(index >= 0, 'Review admission attempt is missing');
  return history.attempts.slice(0, index).findLast((item) => item.review && ['pass', 'revise'].includes(item.status))?.inputs || null;
}

export async function inspectActiveReviewAttempt({ root, scope }) {
  const history = await readHistory(historyPath(root, scope, { create: false }));
  const last = history.attempts.at(-1);
  requireValue(last?.status === 'active', 'No active review attempt');
  return { attempt_id: last.id, inputs: last.inputs, native_review: last.native_review || null };
}

export async function assertNoUnrecordedNativeReview({ root, scope }) {
  const history = await readHistory(historyPath(root, scope, { create: false }));
  const last = history.attempts.at(-1);
  requireValue(!(last?.status === 'active' && last.native_review), 'Active native review must be recorded or aborted before the reviewer can complete');
}


export async function inspectReviewHistory({ root, scope }) {
  const path = historyPath(root, scope, { create: false });
  const history = await readHistory(path);
  const last = history.attempts.at(-1), substantive = lastSubstantiveAttempt(history);
  const repair = scope.startsWith('implementation-');
  const cycle = repair ? (history.repairs || []).slice(history.repair_resolution?.after || 0) : null;
  const reset = resolutionApplied(history, substantive);
  const lastReview = lastRecordedReview(history);
  const used = repair ? cycle.length : !substantive || substantive.status === 'pass' || reset ? 0 : substantive.round;
  const limit = repair ? cycle[0]?.limit ?? null : 3;
  requireValue(Number.isSafeInteger(used) && used >= 0 && (limit === null || Number.isSafeInteger(limit) && limit >= 0), 'Invalid review budget');
  return { root, scope, evidence_path: path, recorded_state: repair ? cycle.length ? 'repair-reserved' : 'no-current-reservation' : last?.pre_dispatch_preparation ? substantive?.status || 'aborted' : last?.status || 'not-started',
    ...(last?.pre_dispatch_preparation ? { last_attempt_status: last.status } : {}),
    ...(lastReview ? { last_review: lastReview.review, last_attempt_id: lastReview.id, last_round: lastReview.round } : {}),
    budget: { used, limit, remaining: limit === null ? null : Math.max(0, limit - used) },
    next_admission_requires_resolution: repair ? cycle.length > 0 && used >= limit : Boolean(scope.startsWith('spec-') && trailingPreparationAbortCount(history) >= MAX_PREPARATION_ABORTS || last && last.status !== 'active' && last.status !== 'pass' && !reset && used >= limit),
    findings: repair ? cycle.at(-1)?.findings || [] : lastReview?.review.findings || [],
    ...(repair && cycle.length ? { plan_set_id: cycle[0].inputs.plan_set_id || null, planning_snapshot_sha256: cycle[0].inputs.planning_snapshot_sha256 || null } : {}),
    findings_source: repair ? 'last-repair-reservation' : 'last-recorded-review',
    reason: last?.reason || null, resolution: repair ? history.repair_resolution || null : history.preparation_resolution?.after === history.attempts.length ? history.preparation_resolution : history.resolution || null };
}
