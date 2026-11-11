import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectContracts } from '../contracts/contracts.mjs';
import { inspectActiveReviewAttempt, inspectReviewHistory, updateReviewAttempt } from './review-attempts.mjs';
import { sessionOutputPath } from './session-output.mjs';

// The semantic review of the integrated contract. `harness-contracts.mjs check` proves the contract is well formed;
// this review is where an independent reviewer compares what it says (rules owned by the right objects, call paths,
// no stale paths) with the source, the tests and the E2E evidence. It reuses the review history that plan and spec
// reviews use: the reviewer's identity and answer come from the subagent hook, never from the stage.

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const REVIEWER = 'contract_reviewer';
const hash = (value) => createHash('sha256').update(value).digest('hex');
function requireValue(value, message) { if (!value) throw new Error(message); }
const blocked = (reason, details) => ({ status: 'blocked', reason, violations: ['contract_review'], ...(details === undefined ? {} : { details }) });

export function contractReviewScope(planSetId) {
  requireValue(ID.test(planSetId || ''), 'Valid plan-set ID is required');
  return `contracts-${planSetId}`;
}

// What the review is about: the sealed contract revision and the snapshot the seal recorded (contract files, CONTEXT,
// Specs, plans and every source root). Any later change to one of them changes these values, so a review never
// carries over to a different contract or different source.
export async function snapshotContractReview({ root }) {
  const check = await inspectContracts({ workspace_root: root });
  requireValue(check.status === 'pass', `Contracts must pass harness-contracts.mjs check and be sealed before the semantic review (${check.reason}${check.violations?.length ? `: ${check.violations[0]}` : ''})`);
  const manifest = JSON.parse(await readFile(join(root, 'docs/contracts/manifest.json'), 'utf8'));
  const hashes = manifest.hashes || {};
  const inputs = {
    revision: String(manifest.revision),
    snapshot_sha256: hash(JSON.stringify(Object.keys(hashes).sort().map((key) => [key, hashes[key]]))),
    product_sha256: hashes['docs/contracts/product.md'],
    architecture_sha256: hashes['docs/contracts/architecture.md'],
  };
  requireValue(Object.values(inputs).every((value) => typeof value === 'string' && value), 'The sealed manifest has no complete snapshot');
  return { revision: manifest.revision, inputs, manifest };
}

async function e2eReceipts(root) {
  try {
    const directory = sessionOutputPath(root, 'runtime/execution', { create: false });
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => `${entry.name}/receipt.json`).sort().map((name) => `runtime/execution/${name}`);
  } catch { return []; }
}

// Pointers for the reviewer, not evidence: it reads the files itself, and the gate trusts only the hook's record.
async function reviewBrief({ root, planSetId, snapshot }) {
  return {
    contract_revision: snapshot.revision,
    contract_files: ['docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/contracts/manifest.json', ...(snapshot.manifest.diagrams || []).map((diagram) => diagram.source).filter(Boolean)],
    source_roots: snapshot.manifest.source_roots || [],
    spec_directory: `docs/specs/${planSetId}`,
    plan_directory: `docs/plans/${planSetId}`,
    e2e_receipts: (await e2eReceipts(root)).map((ref) => `.io/${ref}`),
  };
}

export async function updateContractReview({ root, planSetId, action, attemptId, reason }) {
  const scope = contractReviewScope(planSetId);
  if (action === 'begin') {
    const snapshot = await snapshotContractReview({ root });
    const result = await updateReviewAttempt({ root, scope, action: 'begin', inputs: snapshot.inputs });
    return { ...result, contract_revision: snapshot.revision, brief: await reviewBrief({ root, planSetId, snapshot }) };
  }
  if (action === 'record') {
    // Inside a stage the reviewer must have been bound to this attempt by the subagent hook, in this execution.
    const executionId = process.env.HARNESS_SKILL_EXECUTION_ID;
    if (executionId) {
      requireValue(process.env.HARNESS_WORKSPACE_ROOT === root && EXECUTION_ID.test(executionId), 'Contract review requires its runtime workspace and execution identity');
      const active = await inspectActiveReviewAttempt({ root, scope });
      requireValue(active.attempt_id === attemptId && active.native_review?.execution_id === executionId && active.native_review.agent_id && active.native_review.stopped, 'Contract review record requires a stopped native reviewer bound to this attempt by the subagent hook');
    }
    const snapshot = await snapshotContractReview({ root });
    return updateReviewAttempt({ root, scope, action: 'record', inputs: snapshot.inputs, attemptId, requireNative: true });
  }
  if (action === 'abort' || action === 'resolve') return updateReviewAttempt({ root, scope, action, attemptId, reason });
  throw new Error('Unknown contract review action');
}

// The records the subagent hook wrote for the reviewer the review history names. A history entry written without
// the hook, a reviewer started outside the attempt, or one forked from the author's conversation has no such records.
async function hookRecordProblem({ root, scope, attemptId, native }) {
  if (!EXECUTION_ID.test(native?.execution_id || '') || typeof native.agent_id !== 'string' || !native.agent_id) return 'the review names no hook-bound reviewer';
  let text;
  try { text = await readFile(sessionOutputPath(root, `runtime/executions/${native.execution_id}/subagents.jsonl`, { create: false }), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return 'the subagent hook log of the reviewing execution is missing'; throw error; }
  const records = text.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).filter((item) => item.agent_id === native.agent_id);
  const start = records.find((item) => item.event === 'SubagentStart'), stop = records.find((item) => item.event === 'SubagentStop' && typeof item.result === 'string');
  if (!start) return 'the subagent hook never recorded this reviewer starting';
  if (!stop) return 'the subagent hook never recorded this reviewer finishing';
  if (records.some((item) => item.agent_type !== REVIEWER)) return `the recorded agent is not a ${REVIEWER}`;
  if (records.some((item) => item.forked)) return 'the reviewer was forked from the author conversation';
  if (records.some((item) => item.admitted === false || item.review_scope !== scope || item.review_attempt_id !== attemptId)) return 'the reviewer ran outside this admitted review attempt';
  if (stop.result !== native.result) return 'the reviewer answer in the hook log differs from the recorded review';
  return null;
}

// The completion gate: a passing independent review of exactly the contract revision that is sealed now, read from the
// canonical review history and the hook log. Nothing a caller passes in can satisfy it.
export async function inspectContractReview({ root, planSetId } = {}) {
  try {
    const scope = contractReviewScope(planSetId);
    const contracts = await inspectContracts({ workspace_root: root });
    if (contracts.status !== 'pass') return blocked('contract_review_contracts_not_sealed', { contracts_reason: contracts.reason, next: 'Run the sync-contracts stage: fix the contract, seal it and have it independently reviewed' });
    const current = (await snapshotContractReview({ root })).inputs;
    const history = await inspectReviewHistory({ root, scope });
    const review = history.last_review;
    if (history.recorded_state !== 'pass' || review?.verdict !== 'pass') return blocked('contract_review_missing', { current_revision: Number(current.revision), recorded_state: history.recorded_state, next: 'The sync-contracts stage must run the independent contract review (harness-contract-review.mjs begin/record) and pass it' });
    const reviewed = review.inputs || {};
    if (Object.keys(current).length !== Object.keys(reviewed).length || Object.entries(current).some(([key, value]) => reviewed[key] !== value)) {
      return blocked('contract_review_stale', { reviewed_revision: Number(reviewed.revision) || null, current_revision: Number(current.revision), next: 'The contract or its source changed after the review; the sync-contracts stage must have the sealed revision reviewed again' });
    }
    const problem = await hookRecordProblem({ root, scope, attemptId: history.last_attempt_id, native: history.last_native_review });
    if (problem) return blocked('contract_review_reviewer_unrecorded', { problem, review_attempt_id: history.last_attempt_id });
    return { status: 'pass', reason: 'contract_review_current', violations: [], details: { contract_revision: Number(current.revision), review_attempt_id: history.last_attempt_id, reviewer_id: review.reviewer_id, native_agent_id: history.last_native_review.agent_id, execution_id: history.last_native_review.execution_id, round: history.last_round } };
  } catch (error) { return blocked(error.message); }
}
