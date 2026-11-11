import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, open, rename, unlink } from 'node:fs/promises';
import { sessionOutputPath } from './session-output.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SPEC_PREPARATION_ABORT = 'pre-dispatch preparation: ';
const MAX_PREPARATION_ABORTS = 3;
// Spec and plan reviews allow an initial review plus two retries. The integrated contract is rewritten as a whole, so
// it follows the implementation repair loop instead: five automatic rounds, and a finding that comes back unchanged
// after a fix stops the loop earlier (see repeatedFindings in wrapper/repair.mjs).
export const CONTRACT_REVIEW_ROUNDS = 5;
const roundLimit = (scope) => scope.startsWith('contracts-') ? CONTRACT_REVIEW_ROUNDS : 3;
const findingSignature = (finding) => String(finding?.description || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
// Two reviews in a row that end on the same blocking finding mean the fix is not what is missing, so a third round
// is not scheduled and the user decides.
function repeatedContractFindings(history) {
  const pending = history.attempts.slice(history.resolution?.after || 0).filter((item) => !item.pre_dispatch_preparation);
  const [previous, latest] = pending.slice(-2);
  if (!previous || !latest || previous.status !== 'revise' || latest.status !== 'revise' || !previous.review || !latest.review) return [];
  const blocking = (item) => item.review.findings.filter((finding) => finding.severity !== 'minor');
  const before = new Set(blocking(previous).map(findingSignature));
  return blocking(latest).filter((finding) => before.has(findingSignature(finding)));
}
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
function validateHistory(history, limit = 3) {
  requireValue(Array.isArray(history.attempts) && (history.repairs === undefined || Array.isArray(history.repairs)), 'Invalid review history');
  requireValue(!history.resolution || Number.isSafeInteger(history.resolution.after) && history.resolution.after > 0 && history.resolution.after <= history.attempts.length && (history.attempts[history.resolution.after - 1].round === limit || history.resolution.repeated === true) && !['active', 'pass'].includes(history.attempts[history.resolution.after - 1].status) && typeof history.resolution.reason === 'string' && history.resolution.reason.trim(), 'Invalid review resolution');
  requireValue(!history.preparation_resolution || Number.isSafeInteger(history.preparation_resolution.after) && history.preparation_resolution.after > 0 && history.preparation_resolution.after <= history.attempts.length && history.attempts.slice(0, history.preparation_resolution.after).at(-1)?.pre_dispatch_preparation && typeof history.preparation_resolution.reason === 'string' && history.preparation_resolution.reason.startsWith('preparation recovery: ') && history.preparation_resolution.reason.trim().length > 'preparation recovery: '.length, 'Invalid preparation recovery');
  requireValue(history.scope_removals === undefined || Array.isArray(history.scope_removals) && history.scope_removals.every((item) => typeof item?.inputs?.implementation_commit_sha === 'string' && Array.isArray(item.findings) && item.findings.length > 0), 'Invalid scope removal history');
  const repairs = history.repairs || [];
  requireValue(repairs.every((item) => item && Number.isSafeInteger(item.round) && item.round >= 1 && typeof item.inputs?.fixed_point === 'string' && item.inputs.fixed_point && typeof item.inputs?.implementation_commit_sha === 'string' && item.inputs.implementation_commit_sha && Array.isArray(item.findings)), 'Invalid repair reservation');
  requireValue(history.attempts.every((item) => item && ['active', 'pass', 'revise', 'stale', 'aborted'].includes(item.status) && Number.isSafeInteger(item.round) && item.round >= 1 && item.round <= limit && (!item.review || Array.isArray(item.review.findings))), 'Invalid recorded review');
  requireValue(history.attempts.every((item) => !item.admission_ref && !item.admission_execution_id || /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(item.admission_execution_id || '') && item.admission_ref === `runtime/executions/${item.admission_execution_id}/plan-review-admission-${item.id}.json`), 'Invalid plan review admission reference');
  requireValue(history.attempts.every((item) => !item.native_review || typeof item.native_review.reviewer_id === 'string' && item.native_review.reviewer_id && typeof item.native_review.dispatch_token === 'string' && item.native_review.dispatch_token && typeof item.native_review.parent_session_id === 'string' && item.native_review.parent_session_id && typeof item.native_review.execution_id === 'string' && item.native_review.execution_id && (!item.native_review.agent_id || typeof item.native_review.agent_id === 'string' && typeof item.native_review.stopped === 'boolean' && (!item.native_review.stopped || typeof item.native_review.result === 'string' && item.native_review.result.trim() && ['pass', 'revise', 'reject', 'blocked'].includes(item.native_review.review?.verdict) && Array.isArray(item.native_review.review.findings)))), 'Invalid native review claim');
  return history;
}
async function readHistory(path, limit = 3) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    // Earlier `assemble` versions wrote review evidence ({review_input, reviews}) over this file. That history is
    // lost; start a new one instead of refusing every later review of the plan.
    if (!Array.isArray(parsed?.attempts) && parsed?.review_input && Array.isArray(parsed?.reviews)) return { attempts: [] };
    return validateHistory(parsed, limit);
  }
  catch (error) { if (error.code === 'ENOENT') return { attempts: [] }; throw error; }
}

async function interruptedPlanReview(root, last) {
  const native = last?.native_review, execution = native?.execution_id;
  if (!native?.agent_id || native.stopped || execution !== last.admission_execution_id || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(execution || '')) return false;
  try {
    const log = JSON.parse(await readFile(sessionOutputPath(root, `runtime/executions/${execution}/exec.stderr.json`, { create: false }), 'utf8'));
    return log.provider === 'codex' && (Number.isInteger(log.exit_code) || /^SIG[A-Z0-9]+$/.test(log.exit_signal || '')) && log.session_id === native.parent_session_id;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

// Serialize admission and result writes; the persisted active attempt owns the review slot.
// 수리 한도가 끝날 때마다 plan을 고쳐 새로 여는 순환을 사용자 결정 없이 계속하지 않는다.
export async function updateReviewAttempt({ root, scope, action, inputs, attemptId, review, reason, resolution, findings = [], reviewerId, nativeAgentId, nativeResult, nativeReview, parentSessionId, executionId, admissionRef, requireNative = false }) {
  const path = historyPath(root, scope);
  const lock = await open(`${path}.lock`, 'wx').catch((error) => {
    if (error.code === 'EEXIST') throw new Error('Review history is being updated; retry after the current command finishes');
    throw error;
  });
  try {
    const limit = roundLimit(scope), history = await readHistory(path, limit), last = history.attempts.at(-1);
    let result;
    if (action === 'repair') {
      // Every review finding that needs a code change is reserved as one more round; there is no round limit, and the
      // fixed point stays the plan's starting commit.
      requireValue(scope.startsWith('implementation-'), 'Implementation repair scope is required');
      history.repairs ||= [];
      requireValue(inputs?.fixed_point && inputs?.implementation_commit_sha, 'Fixed point and implementation commit are required');
      const cycle = history.repairs;
      requireValue(!cycle.length || cycle[0].inputs.fixed_point === inputs.fixed_point, 'Keep the original review fixed point across repair and resume');
      requireValue(!cycle.some((item) => item.inputs.implementation_commit_sha === inputs.implementation_commit_sha), 'This commit already has a reserved repair; resume that correction before requesting another');
      requireValue(!cycle.some((item) => item.inputs.reviewer_ids?.some((id) => inputs.reviewer_ids?.includes(id))), 'Each implementation repair review requires fresh reviewer contexts');
      const reservation = { round: cycle.length + 1, inputs, findings };
      history.repairs.push(reservation);
      result = { status: 'pass', ...reservation };
    } else if (action === 'scope-removal') {
      // 사용자가 제거를 결정한 Spec 밖 동작은 예산과 별도로 기록하되 커밋·reviewer 재사용은 똑같이 막는다.
      requireValue(scope.startsWith('implementation-'), 'Implementation repair scope is required');
      requireValue(inputs?.fixed_point && inputs?.implementation_commit_sha, 'Fixed point and implementation commit are required');
      requireValue(Array.isArray(findings) && findings.length > 0 && findings.every((item) => item?.repair_directive === 'remove_unrequested_behavior' && item.scope_decision?.choice === 'reject'), 'Scope removal requires findings with a recorded user rejection');
      history.scope_removals ||= [];
      const cycle = history.repairs || [];
      const reserved = [...cycle, ...history.scope_removals];
      requireValue(!cycle.length || cycle[0].inputs.fixed_point === inputs.fixed_point, 'Keep the original review fixed point across repair and resume');
      requireValue(!reserved.some((item) => item.inputs.implementation_commit_sha === inputs.implementation_commit_sha), 'This commit already has a reserved repair; resume that correction before requesting another');
      requireValue(!reserved.some((item) => item.inputs.reviewer_ids?.some((id) => inputs.reviewer_ids?.includes(id))), 'Each implementation repair review requires fresh reviewer contexts');
      history.scope_removals.push({ inputs, findings });
      result = { status: 'pass', scope_removal: true, round: cycle.length, findings };
    } else if (action === 'begin') {
      requireValue(inputs && Object.keys(inputs).length > 0, 'Review inputs are required');
      // A reviewer that finished after its stage was interrupted leaves the attempt active with a bound result.
      // Settle it from that result (stale when the inputs changed since) so the next stage can start a review.
      if (last?.status === 'active' && last.native_review?.agent_id && last.native_review.stopped && last.native_review.review) {
        const native = last.native_review;
        last.review = { verdict: native.review.verdict, findings: native.review.findings || [], reviewer_id: native.reviewer_id, author_ids: [native.parent_session_id], fork_turns: 'none', inputs: last.inputs };
        last.status = !same(last.inputs, inputs) ? 'stale' : native.review.verdict === 'pass' && (native.review.findings || []).every((item) => item.severity === 'minor') ? 'pass' : 'revise';
        last.settled_after_interruption = true;
      }
      if (scope.startsWith('plan-') && last?.status === 'active' && await interruptedPlanReview(root, last)) {
        last.status = 'aborted';
        last.reason = `interrupted review: owning execution ${last.native_review.execution_id} ended without a recorded reviewer result`;
      }
      requireValue(last?.status !== 'active', `A review is already active (attempt ${last?.id}, execution ${last?.native_review?.execution_id || last?.admission_execution_id || 'unknown'}); record its result or abort it before dispatch`);
      requireValue(!last || last.status === 'aborted' || (scope.startsWith('plan-') && last.status === 'revise') || !same(last.inputs, inputs), 'Review inputs are unchanged; reuse the current result or resolve the findings before dispatch');
      if (scope.startsWith('contracts-')) {
        const repeated = repeatedContractFindings(history);
        requireValue(!repeated.length, `The same contract review finding came back after a fix (${repeated.map((finding) => finding.description).join('; ').slice(0, 300)}); ask the user how to handle it and record the answer with resolve before another review`);
      }
      const trailingPreparationAborts = trailingPreparationAbortCount(history);
      if (scope.startsWith('spec-')) requireValue(trailingPreparationAborts < MAX_PREPARATION_ABORTS, 'Spec review preparation retry limit exhausted; record preparation recovery before retrying');
      const substantive = lastSubstantiveAttempt(history);
      const round = !substantive || substantive.status === 'pass' || resolutionApplied(history, substantive) ? 1 : substantive.round + 1;
      requireValue(round <= limit, limit === 3 ? 'Review retry budget exhausted (initial review plus two retries); present unresolved findings for a scope or decision resolution' : `Review retry budget exhausted (${limit} rounds); present unresolved findings for a scope or decision resolution`);
      const attempt = { id: randomUUID(), round, status: 'active', inputs };
      history.attempts.push(attempt);
      const previousReview = lastRecordedReview(history);
      result = { status: 'pass', attempt_id: attempt.id, round, inputs, previous_inputs: previousReview?.inputs || null, previous_findings: previousReview?.review.findings || [] };
    } else if (action === 'claim') {
      requireValue(last?.status === 'active' && last.id === attemptId, `No active review matches this attempt ID (requested ${attemptId || 'missing'}, active ${last?.status === 'active' ? last.id : 'none'})`);
      requireValue(!last.native_review, 'A native reviewer is already claimed for this attempt');
      requireValue(typeof reviewerId === 'string' && reviewerId.trim() && typeof nativeAgentId === 'string' && nativeAgentId.trim() && typeof parentSessionId === 'string' && parentSessionId.trim() && typeof executionId === 'string' && executionId.trim(), 'Reviewer identity, native dispatch token, parent session, and execution are required');
      last.native_review = { reviewer_id: reviewerId, dispatch_token: nativeAgentId, parent_session_id: parentSessionId, execution_id: executionId };
      result = { status: 'pass', attempt_id: last.id, reviewer_id: reviewerId, dispatch_token: nativeAgentId };
    } else if (action === 'bind-admission') {
      requireValue(last?.status === 'active' && last.id === attemptId && !last.admission_ref && typeof executionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId) && admissionRef === `runtime/executions/${executionId}/plan-review-admission-${attemptId}.json`, 'Plan review admission reference does not match its active attempt');
      last.admission_ref = admissionRef;
      last.admission_execution_id = executionId;
      result = { status: 'pass', attempt_id: last.id, admission_ref: admissionRef };
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
        const repeated = scope.startsWith('contracts-') && repeatedContractFindings(history).length > 0;
        requireValue(last && last.status !== 'active' && last.status !== 'pass' && (last.round === limit || repeated), 'Resolve requires an exhausted review cycle');
        history.resolution = { after: history.attempts.length, reason, ...(repeated && last.round !== limit ? { repeated: true } : {}) };
        result = { status: 'pass', reason: 'user_resolution_recorded' };
      }
    } else {
      requireValue(last?.status === 'active' && last.id === attemptId, `No active review matches this attempt ID (requested ${attemptId || 'missing'}, active ${last?.status === 'active' ? last.id : 'none'})`);
      if (action === 'abort') {
        requireValue(typeof reason === 'string' && reason.trim(), 'Abort reason is required');
        last.status = 'aborted'; last.reason = reason;
        if (scope.startsWith('spec-') && !last.native_review && reason.startsWith(SPEC_PREPARATION_ABORT)) last.pre_dispatch_preparation = true;
      } else {
        requireValue(action === 'record', 'Unknown review attempt action');
        // Reviewer identity comes from the hook-bound native reviewer, never from the stage's own record.
        const native = last.native_review?.agent_id && last.native_review.stopped ? last.native_review : null;
        if (requireNative) requireValue(native, 'No hook-bound native reviewer finished this attempt; start the reviewer as a fresh native subagent after begin');
        if (native) {
          for (const key of ['reviewer_id', 'author_ids', 'fork_turns']) requireValue(!review || review[key] === undefined || isDeepStrictEqual(review[key], { reviewer_id: native.reviewer_id, author_ids: [native.parent_session_id], fork_turns: 'none' }[key]), `Review ${key} is recorded from the native reviewer hook; do not supply a different value`);
          review = { ...(review || {}), verdict: review?.verdict ?? native.review?.verdict, findings: review?.findings ?? native.review?.findings, reviewer_id: native.reviewer_id, author_ids: [native.parent_session_id], fork_turns: 'none' };
        }
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
  const history = await readHistory(historyPath(root, scope), roundLimit(scope));
  const last = history.attempts.at(-1);
  requireValue(last?.status === 'pass' && last.review && isDeepStrictEqual(last.review, review), 'Record and supply the authoritative passing result for the current review attempt before advancing');
  return last.review;
}

export async function assertActiveReviewAdmission({ root, scope, attemptId, inputs, requireActive = true }) {
  const history = await readHistory(historyPath(root, scope, { create: false }), roundLimit(scope));
  const last = history.attempts.at(-1);
  requireValue((requireActive ? last?.status === 'active' : ['active', 'pass', 'revise'].includes(last?.status)) && last.id === attemptId && inputs && same(last.inputs, inputs), 'Review admission does not match the active attempt');
}

export async function reviewAdmissionPreviousInputs({ root, scope, attemptId }) {
  const history = await readHistory(historyPath(root, scope, { create: false }), roundLimit(scope));
  const index = history.attempts.findIndex((item) => item.id === attemptId);
  requireValue(index >= 0, 'Review admission attempt is missing');
  return history.attempts.slice(0, index).findLast((item) => item.review && ['pass', 'revise'].includes(item.status))?.inputs || null;
}

export async function inspectActiveReviewAttempt({ root, scope }) {
  const history = await readHistory(historyPath(root, scope, { create: false }), roundLimit(scope));
  const last = history.attempts.at(-1);
  requireValue(last?.status === 'active', 'No active review attempt');
  return { attempt_id: last.id, inputs: last.inputs, native_review: last.native_review || null, admission_ref: last.admission_ref || null, admission_execution_id: last.admission_execution_id || null };
}

export async function assertNoUnrecordedNativeReview({ root, scope }) {
  const history = await readHistory(historyPath(root, scope, { create: false }), roundLimit(scope));
  const last = history.attempts.at(-1);
  requireValue(!(last?.status === 'active' && last.native_review), 'Active native review must be recorded or aborted before the reviewer can complete');
}


export async function inspectReviewHistory({ root, scope }) {
  const path = historyPath(root, scope, { create: false });
  const history = await readHistory(path, roundLimit(scope));
  const last = history.attempts.at(-1), substantive = lastSubstantiveAttempt(history);
  const repair = scope.startsWith('implementation-');
  const cycle = repair ? history.repairs || [] : null;
  const reset = resolutionApplied(history, substantive);
  const lastReview = lastRecordedReview(history);
  const used = repair ? cycle.length : !substantive || substantive.status === 'pass' || reset ? 0 : substantive.round;
  const limit = repair ? null : roundLimit(scope);
  const repeated = scope.startsWith('contracts-') && !reset ? repeatedContractFindings(history) : [];
  requireValue(Number.isSafeInteger(used) && used >= 0 && (limit === null || Number.isSafeInteger(limit) && limit >= 0), 'Invalid review budget');
  return { root, scope, evidence_path: path, recorded_state: repair ? cycle.length ? 'repair-reserved' : 'no-current-reservation' : last?.pre_dispatch_preparation ? substantive?.status || 'aborted' : last?.status || 'not-started',
    ...(last?.pre_dispatch_preparation ? { last_attempt_status: last.status } : {}),
    ...(lastReview ? { last_review: lastReview.review, last_attempt_id: lastReview.id, last_round: lastReview.round, ...(lastReview.native_review ? { last_native_review: lastReview.native_review } : {}) } : {}),
    ...(repeated.length ? { repeated_findings: repeated } : {}),
    budget: { used, limit, remaining: limit === null ? null : Math.max(0, limit - used) },
    next_admission_requires_resolution: repair ? false : Boolean(scope.startsWith('spec-') && trailingPreparationAbortCount(history) >= MAX_PREPARATION_ABORTS || last && last.status !== 'active' && last.status !== 'pass' && !reset && (used >= limit || repeated.length > 0)),
    findings: repair ? cycle.at(-1)?.findings || [] : lastReview?.review.findings || [],
    ...(repair && cycle.length ? { plan_set_id: cycle[0].inputs.plan_set_id || null, planning_snapshot_sha256: cycle[0].inputs.planning_snapshot_sha256 || null } : {}),
    findings_source: repair ? 'last-repair-reservation' : 'last-recorded-review',
    reason: last?.reason || null, resolution: repair ? null : history.preparation_resolution?.after === history.attempts.length ? history.preparation_resolution : history.resolution || null };
}
