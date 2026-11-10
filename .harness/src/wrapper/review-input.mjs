import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { userSaidAfter } from '../workflow/user-inputs.mjs';
import { dirname, join } from 'node:path';
import { sessionOutputPath } from '../workflow/session-output.mjs';
import { inspectPlanSet } from '../workflow/plan-review.mjs';
import { parseWorktreeRecord } from '../workflow/worktrees.mjs';
import { assertSpecCoverage } from './spec-items.mjs';

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

export async function readImplementerResult({ root, resultRef, commit = null }) {
  const path = sessionOutputPath(root, resultRef, { create: false });
  const result = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(result.unplanned_additions)) throw new Error(`${resultRef} has no unplanned_additions array`);
  const recordedAt = (await stat(path)).mtimeMs;
  if (/^[0-9a-f]{40}$/i.test(result.commit_sha || '')) return { additions: result.unplanned_additions, commitSha: result.commit_sha, recordedAt };
  // A resumed run that only re-checked an earlier implementation reports no new commit. The commit is then one an
  // earlier implementation result of this session recorded: the one named by --commit (a unique prefix is enough),
  // or, without --commit, the most recent recorded one when it is still HEAD (no later plan committed on top).
  const executions = sessionOutputPath(root, 'runtime/executions', { create: false });
  const recorded = [];
  for (const name of await readdir(executions).catch(() => [])) {
    if (!name.startsWith('implement-wrapper-')) continue;
    const file = join(executions, name, 'result.json');
    const earlier = await readFile(file, 'utf8').then(JSON.parse, () => null);
    if (/^[0-9a-f]{40}$/i.test(earlier?.commit_sha || '')) recorded.push({ sha: earlier.commit_sha.toLowerCase(), at: (await stat(file)).mtimeMs });
  }
  const shas = [...new Set(recorded.map((item) => item.sha))];
  let chosen;
  if (commit) {
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error(`--commit ${commit} is not a commit SHA (7-40 hex characters)`);
    const matches = shas.filter((sha) => sha.startsWith(commit.toLowerCase()));
    if (matches.length !== 1) throw new Error(matches.length ? `--commit ${commit} matches several recorded commits: ${matches.join(', ')}` : `No implement-wrapper result in this session recorded a commit starting with ${commit}; recorded: ${shas.join(', ') || 'none'}`);
    [chosen] = matches;
  } else {
    const latest = recorded.sort((a, b) => b.at - a.at)[0]?.sha;
    const head = (await git(root, 'rev-parse', 'HEAD').catch(() => '')).trim().toLowerCase();
    if (!latest || latest !== head) throw new Error(`${resultRef} has no commit_sha and the latest recorded implementation commit (${latest || 'none'}) is not HEAD; pass --commit <SHA> (recorded: ${shas.join(', ') || 'none'})`);
    chosen = latest;
  }
  return { additions: result.unplanned_additions, commitSha: chosen, recordedAt };
}

// Combines the two reviewers' raw JSON answers ({"state","report":{"findings"}}) with the review input.
// Each context_id is the reviewer's own native agent/thread ID, never a label written by the caller.
export function assembleReviews({ reviewInput, standards, spec, specItems = [] }) {
  const entry = (role, { contextId, raw, carried }) => {
    if (carried) return carried;
    if (!contextId || typeof contextId !== 'string') throw new Error(`${role} reviewer needs its native context ID`);
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error(`${role} reviewer answer is not JSON`); }
    if (!parsed || !REVIEW_STATES.has(parsed.state) || !Array.isArray(parsed.report?.findings)) throw new Error(`${role} reviewer answer must be {"state":"passed"|"failed","report":{"findings":[...]}}`);
    // The Spec reviewer must answer every contract item of the Architecture Spec, not only report the first mismatch.
    if (role === 'spec') assertSpecCoverage(specItems, parsed.report);
    return { role, context_id: contextId, independent: true, fresh_context: true, implementation_commit_sha: reviewInput.implementation_commit_sha, review_input: reviewInput, state: parsed.state, report: parsed.report, raw_result: typeof raw === 'string' ? raw : JSON.stringify(raw) };
  };
  return { review_input: reviewInput, reviews: [entry('standards', standards), entry('spec', spec)] };
}

// A repair round normally re-runs both reviewers. When one axis already passed and the repair only touched files the
// OTHER axis cited in its findings, that passed verdict is carried forward instead of asking a new reviewer to
// repeat it. The carried entry keeps its original reviewer ID and says so in `carried_forward`; every other check
// (both roles, one commit, the same review_input) still applies. Anything that does not meet these conditions is
// refused, and the caller must run both reviewers.
const cited = (finding) => [finding.file, ...String(finding.evidence ?? '').split(/[\s,;()]+/)]
  .map((token) => String(token ?? '').replace(/^[ab]\//, '').replace(/:\d+(-\d+)?$/, ''))
  .filter((token) => /^[\w@.-]+(\/[\w@.-]+)*\.\w+$/.test(token));

export async function carryForwardReview({ root, planId, role, reviewInput }) {
  if (!['standards', 'spec'].includes(role)) throw new Error('--reuse-axis must be standards or spec');
  let previous;
  try { previous = await readEvidence(root, planId); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('There is no earlier review of this plan to carry forward; run both reviewers'); throw error; }
  const entry = previous.reviews?.find((item) => item.role === role);
  const other = previous.reviews?.find((item) => item.role !== role);
  const refuse = (why) => { throw new Error(`The ${role} verdict cannot be carried forward (${why}); run both reviewers`); };
  if (!entry || !other) refuse('the earlier review is incomplete');
  if (previous.review_input?.fixed_point !== reviewInput.fixed_point) refuse('the fixed point changed');
  if (entry.state !== 'passed' || entry.report.findings.some((finding) => finding.kind !== 'advisory')) refuse(`it did not pass cleanly in the earlier round`);
  if (other.state === 'passed') refuse('the other axis had no findings, so there was no repair to scope');
  const from = entry.implementation_commit_sha, to = reviewInput.implementation_commit_sha;
  if (from === to) refuse('the implementation commit did not change');
  await git(root, 'merge-base', '--is-ancestor', from, to).catch(() => refuse('the new commit does not descend from the reviewed commit'));
  const delta = (await git(root, 'diff', '--name-only', `${from}..${to}`)).split('\n').filter(Boolean);
  const allowed = new Set(other.report.findings.filter((finding) => finding.kind !== 'advisory').flatMap(cited));
  const outside = delta.filter((file) => !allowed.has(file));
  if (!delta.length || outside.length) refuse(delta.length ? `the repair also changed files the other axis did not cite: ${outside.slice(0, 5).join(', ')}` : 'the repair changed no files');
  return { ...entry, implementation_commit_sha: to, review_input: reviewInput, carried_forward: { from_commit: from, delta_files: delta, reason: 'repair stayed within files the other axis cited' } };
}

// Reads a reviewer recorded by the subagent hook in the orchestrator session: its Stop answer is the review,
// its agent ID is the context ID, and a reviewer forked from the caller's conversation is refused.
// Without an agent ID, the one reviewer of that type that finished after the implementation result is used, so the
// caller never has to retype a long ID (a mistyped character made the recorded reviewer unrecognizable).
export async function readHookRecordedReviewer({ root, role, agentId = null, after = null }) {
  const agentType = role === 'standards' ? 'standards_reviewer' : 'spec_reviewer';
  let text;
  try { text = await readFile(sessionOutputPath(root, 'runtime/orchestrator/subagents.jsonl', { create: false }), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`No hook-recorded subagents: the ${role} reviewer was not started as a native subagent in a Harness worktree session`); throw error; }
  const all = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((item) => item.agent_type === agentType);
  const forked = new Set(all.filter((item) => item.forked).map((item) => item.agent_id));
  const finished = [...new Set(all.filter((item) => item.event === 'SubagentStop' && typeof item.result === 'string' && !forked.has(item.agent_id) && (after === null || Date.parse(item.recorded_at) >= after)).map((item) => item.agent_id))];
  if (!agentId) {
    if (finished.length !== 1) throw new Error(finished.length ? `Several ${agentType}s finished after the implementation result (${finished.join(', ')}); pass --${role}-agent` : `The hook recorded no ${agentType} that finished after the implementation result; run a fresh reviewer`);
    agentId = finished[0];
  } else if (!all.some((item) => item.agent_id === agentId)) throw new Error(`The hook did not record a finished ${agentType} with agent ID ${agentId}${finished.length ? `; recorded: ${finished.join(', ')}` : ''}`);
  const records = all.filter((item) => item.agent_id === agentId);
  const start = records.find((item) => item.event === 'SubagentStart'), stop = records.findLast((item) => item.event === 'SubagentStop' && typeof item.result === 'string');
  if (!start || !stop) throw new Error(`The hook did not record a finished ${agentType} with agent ID ${agentId}`);
  if (forked.has(agentId)) throw new Error(`${agentType} ${agentId} was forked from the caller's conversation; start a fresh reviewer with fork_turns none`);
  return { contextId: agentId, raw: stop.result };
}

const pendingPath = (planId) => `runtime/reviews/implementation-${planId}-questions.json`;

// Evidence written before it moved to -evidence.json sits at the review-history path; read it from there while the
// new file does not exist yet, so a plan reviewed by an older version continues.
async function readEvidence(root, planId) {
  for (const path of [`runtime/reviews/implementation-${planId}-evidence.json`, `runtime/reviews/implementation-${planId}.json`]) {
    try {
      const parsed = JSON.parse(await readFile(sessionOutputPath(root, path, { create: false }), 'utf8'));
      if (parsed?.review_input && Array.isArray(parsed?.reviews)) return parsed;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const error = new Error(`No review evidence for ${planId}`); error.code = 'ENOENT'; throw error;
}

// `repair` asks; this keeps what it asked, with the fingerprints of the findings and when it was first asked, so a
// decision can only answer a question of the current review. The question ID carries the fingerprints, so an
// earlier answer to a finding that reused the same ID is never found under the new question.
export async function recordPendingQuestions({ root, planId, questions, now = new Date() }) {
  let previous = [];
  try { previous = JSON.parse(await readFile(sessionOutputPath(root, pendingPath(planId), { create: false }), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pending = [];
  const annotated = questions.map((item) => {
    if (!item?.finding_id || !Array.isArray(item.fingerprints)) return item;
    const questionId = `scope-${planId}:${item.finding_id}@${createHash('sha256').update(item.fingerprints.join(',')).digest('hex').slice(0, 12)}`;
    const askedAt = previous.find((entry) => entry.question_id === questionId)?.asked_at || now.toISOString();
    pending.push({ question_id: questionId, finding_id: item.finding_id, finding_ids: item.finding_ids, fingerprints: item.fingerprints, asked_at: askedAt });
    return { ...item, question_id: questionId };
  });
  const path = sessionOutputPath(root, pendingPath(planId));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(pending, null, 2) + '\n', { mode: 0o600 });
  return annotated;
}

// The main orchestrator is not a stage, so the repair questions it relays have no stage-assigned question IDs.
// This records the user's own words for a question the latest `repair` asked, after checking that the user really
// said them after that question (hook-recorded user input), and links them to the finding's fingerprints.
export async function recordScopeDecision({ root, planId, findingId, choice, answer, labels }) {
  if (!findingId || !['reject', 'accept', 'adopt'].includes(choice)) throw new Error('A finding ID and a choice of reject, accept or adopt are required');
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('The user\'s answer text is required');
  const accepted = [choice, ...Object.values(labels).map((item) => item[choice])].filter(Boolean);
  if (!accepted.some((label) => answer.includes(label))) throw new Error(`The answer must contain the chosen option label (${[...new Set(accepted)].join(' / ')}); record the user's actual words`);
  let pending = [];
  try { pending = JSON.parse(await readFile(sessionOutputPath(root, pendingPath(planId), { create: false }), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const asked = pending.find((entry) => entry.finding_id === findingId);
  if (!asked) throw new Error(`${findingId} is not a question the latest repair asked; run repair and relay its question to the user`);
  if (!await userSaidAfter({ root, text: answer, since: asked.asked_at })) throw new Error(`No user message after the question (${asked.asked_at}) contains this answer; ask the user and record their reply, not an earlier answer`);
  const evidencePath = `runtime/reviews/implementation-${planId}-evidence.json`;
  const answersRef = `runtime/reviews/implementation-${planId}-answers.json`;
  const evidence = await readEvidence(root, planId);
  const questionId = asked.question_id;
  let answers = [];
  try { answers = JSON.parse(await readFile(sessionOutputPath(root, answersRef, { create: false }), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  answers = [...answers.filter((item) => item.question_id !== questionId), { question_id: questionId, answer }];
  evidence.scope_decisions = [...(evidence.scope_decisions || []).filter((item) => item.finding_id !== findingId), { finding_id: findingId, choice, question_id: questionId, answers_ref: answersRef, fingerprints: asked.fingerprints }];
  await writeFile(sessionOutputPath(root, answersRef), JSON.stringify(answers, null, 2) + '\n', { mode: 0o600 });
  await writeFile(sessionOutputPath(root, evidencePath), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  return { question_id: questionId, answers_ref: answersRef, reviews: evidencePath };
}

// A plan re-selected after an upstream change (Spec or plan revision) often has nothing new to implement. When its
// HEAD is a commit whose review already passed for the same fixed point and planning snapshot, no second review is
// needed; `reviewed` says so, and the implementer completes the plan instead of returning REVIEW_REQUIRED again.
export async function recordPassedReview({ root, planId, evidence }) {
  const path = sessionOutputPath(root, `runtime/reviews/implementation-${planId}-evidence.json`);
  const current = await readEvidence(root, planId);
  const input = evidence.review_input;
  current.passed = { implementation_commit_sha: input.implementation_commit_sha, fixed_point: input.fixed_point, planning_snapshot_sha256: input.planning_snapshot_sha256, recorded_at: new Date().toISOString() };
  await writeFile(path, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
}

export async function reviewedCommit({ root, planId, commit }) {
  const head = (await git(root, 'rev-parse', commit || 'HEAD')).trim();
  let evidence;
  try { evidence = await readEvidence(root, planId); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'review_required', reason: 'no_passed_review', commit: head }; throw error; }
  const passed = evidence.passed;
  if (!passed || passed.implementation_commit_sha !== head) return { status: 'review_required', reason: passed ? 'commit_changed' : 'no_passed_review', commit: head, ...(passed ? { passed_commit: passed.implementation_commit_sha } : {}) };
  const record = parseWorktreeRecord(await readFile(join(root, '.io/worktree.json'), 'utf8'));
  const current = await inspectPlanSet({ root, planSetId: record.plan_set_id, planId, phase: 'dispatch' });
  if (current.status !== 'pass') return { status: 'review_required', reason: `plan_review_${current.reason}`, commit: head };
  if (current.details.review_snapshot_sha256 !== passed.planning_snapshot_sha256) return { status: 'review_required', reason: 'plan_changed_since_review', commit: head };
  return { status: 'reviewed', commit: head, fixed_point: passed.fixed_point, recorded_at: passed.recorded_at };
}

export async function writeReviewEvidence({ root, planId, evidence }) {
  const path = sessionOutputPath(root, `runtime/reviews/implementation-${planId}-evidence.json`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  return `runtime/reviews/implementation-${planId}-evidence.json`;
}
