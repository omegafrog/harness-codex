import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sessionOutputPath } from '../workflow/session-output.mjs';
import { inspectPlanSet } from '../workflow/plan-review.mjs';
import { parseWorktreeRecord } from '../workflow/worktrees.mjs';

const execFileAsync = promisify(execFile);
const git = async (root, ...args) => (await execFileAsync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
const REVIEW_STATES = new Set(['passed', 'failed']);

// Builds the exact review_input that `harness-code-review.mjs repair` validates, so the orchestrator never
// hand-assembles it: commit list with both endpoints, diff_range as an object, Spec paths and the planning
// snapshot from the plan-review dispatch check, and the implementer's unplanned_additions.
export async function buildReviewInput({ root, planId, fixedPoint, commit, unplannedAdditions }) {
  // Never default to HEAD: later plans commit on top, and the review must name the commit the implementer reported.
  if (!/^[0-9a-f]{40}$/i.test(commit || '')) throw new Error('The implementation commit SHA (40 hex) is required; it comes from the implementer\'s result');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(planId || '')) throw new Error('Valid plan ID is required');
  const record = parseWorktreeRecord(await readFile(join(root, '.io/worktree.json'), 'utf8'));
  const [fixed, implementation] = await Promise.all([git(root, 'rev-parse', '--verify', `${fixedPoint}^{commit}`), git(root, 'rev-parse', '--verify', `${commit}^{commit}`)]).then((items) => items.map((item) => item.trim()));
  if (fixed === implementation) throw new Error('The fixed point and the implementation commit must differ');
  const diff = await git(root, 'diff', `${fixed}..${implementation}`);
  if (!diff.trim()) throw new Error('There is no diff between the fixed point and the implementation commit');
  if (!Array.isArray(unplannedAdditions)) throw new Error('unplanned_additions must be the implementer\'s array (use [] when there are none)');
  const planSetId = record.plan_set_id;
  const current = await inspectPlanSet({ root, planSetId, planId, phase: 'dispatch' });
  if (current.status !== 'pass') throw new Error(`Plan review dispatch check is not passing: ${current.reason}`);
  const between = (await git(root, 'rev-list', '--reverse', `${fixed}..${implementation}`)).split('\n').filter(Boolean);
  return reviewInputFromParts({ root, fixed, implementation, between, diff, unplannedAdditions, planSetId, details: current.details });
}

export function reviewInputFromParts({ root, fixed, implementation, between, diff, unplannedAdditions, planSetId, details }) {
  return {
    repository: root,
    fixed_point: fixed,
    implementation_commit_sha: implementation,
    commit_list: [fixed, ...between],
    diff_range: { from: fixed, to: implementation },
    diff,
    unplanned_additions: unplannedAdditions,
    product_spec_path: details.product_spec_path,
    architecture_spec_path: details.architecture_spec_path,
    completion_kind: 'plan_implemented',
    plan_set_id: planSetId,
    planning_snapshot_sha256: details.review_snapshot_sha256,
    canonical_plan: details.canonical_plan,
  };
}

export async function readImplementerResult({ root, resultRef }) {
  const result = JSON.parse(await readFile(sessionOutputPath(root, resultRef, { create: false }), 'utf8'));
  if (!Array.isArray(result.unplanned_additions)) throw new Error(`${resultRef} has no unplanned_additions array`);
  if (!/^[0-9a-f]{40}$/i.test(result.commit_sha || '')) throw new Error(`${resultRef} has no commit_sha; the implementation commit must be recorded before review`);
  return { additions: result.unplanned_additions, commitSha: result.commit_sha };
}

// Combines the two reviewers' raw JSON answers ({"state","report":{"findings"}}) with the review input.
// Each context_id is the reviewer's own native agent/thread ID, never a label written by the caller.
export function assembleReviews({ reviewInput, standards, spec }) {
  const entry = (role, { contextId, raw }) => {
    if (!contextId || typeof contextId !== 'string') throw new Error(`${role} reviewer needs its native context ID`);
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error(`${role} reviewer answer is not JSON`); }
    if (!parsed || !REVIEW_STATES.has(parsed.state) || !Array.isArray(parsed.report?.findings)) throw new Error(`${role} reviewer answer must be {"state":"passed"|"failed","report":{"findings":[...]}}`);
    return { role, context_id: contextId, independent: true, fresh_context: true, implementation_commit_sha: reviewInput.implementation_commit_sha, review_input: reviewInput, state: parsed.state, report: parsed.report, raw_result: typeof raw === 'string' ? raw : JSON.stringify(raw) };
  };
  return { review_input: reviewInput, reviews: [entry('standards', standards), entry('spec', spec)] };
}

// Reads a reviewer recorded by the subagent hook in the orchestrator session: its Stop answer is the review,
// its agent ID is the context ID, and a reviewer forked from the caller's conversation is refused.
export async function readHookRecordedReviewer({ root, role, agentId }) {
  const agentType = role === 'standards' ? 'standards_reviewer' : 'spec_reviewer';
  let text;
  try { text = await readFile(sessionOutputPath(root, 'runtime/orchestrator/subagents.jsonl', { create: false }), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`No hook-recorded subagents: the ${role} reviewer was not started as a native subagent in a Harness worktree session`); throw error; }
  const records = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((item) => item.agent_id === agentId && item.agent_type === agentType);
  const start = records.find((item) => item.event === 'SubagentStart'), stop = records.findLast((item) => item.event === 'SubagentStop' && typeof item.result === 'string');
  if (!start || !stop) throw new Error(`The hook did not record a finished ${agentType} with agent ID ${agentId}`);
  if (start.forked) throw new Error(`${agentType} ${agentId} was forked from the caller's conversation; start a fresh reviewer with fork_turns none`);
  return { contextId: agentId, raw: stop.result };
}

export async function writeReviewEvidence({ root, planId, evidence }) {
  const path = sessionOutputPath(root, `runtime/reviews/implementation-${planId}.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  return `runtime/reviews/implementation-${planId}.json`;
}
