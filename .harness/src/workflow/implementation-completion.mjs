import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { e2eLearningComplete } from '../eval/contracts.mjs';
import { checkRetirement } from '../gates/lifecycle.mjs';
import { readPlanSetTicketStatuses } from '../tracker/lifecycle.mjs';
import { readEvidence } from '../wrapper/review-input.mjs';
import { readExecutionManifest } from './execution.mjs';
import { snapshotPlanSet } from './plan-review.mjs';
import { sessionOutputPath } from './session-output.mjs';

const execFileAsync = promisify(execFile);

// The final implement-wrapper gate reads these facts only from canonical Harness records. A completion state file may
// still carry them (older orchestrator guidance told it to), but the gate ignores every one of these keys.
export const DERIVED_STATE_KEYS = Object.freeze(['required_outcome', 'tests', 'reviews', 'retirement', 'evidence', 'plan_review', 'plan_set_id', 'plan_id']);

// Changes after a passing E2E receipt that cannot change what the E2E exercised. Everything else (application source,
// tests, build files, migrations) invalidates the receipt. Files the receipt itself fingerprints (config_hashes) are
// compared by content whatever their path, so docs/agents/execution.json stays covered even though it lives in docs/.
const DOCUMENTATION_FILES = new Set(['CONTEXT.md', 'CONTEXT-MAP.md', '.harness/contracts.mjs']);
export const isDocumentationPath = (path) => path.startsWith('docs/') || DOCUMENTATION_FILES.has(path);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const MAX_LISTED = 30;
const ROLE_AGENT = { standards: 'standards_reviewer', spec: 'spec_reviewer' };
const pass = (reason, details) => ({ status: 'pass', reason, violations: [], ...(details === undefined ? {} : { details }) });
const blocked = (reason, details) => ({ status: 'blocked', reason, violations: [], ...(details === undefined ? {} : { details }) });
const fail = (rule, reason, violations, details) => ({ status: 'fail', reason, violations: violations.length ? violations : [rule], ...(details === undefined ? {} : { details }) });
const git = async (root, ...args) => (await execFileAsync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
const isAncestor = (root, ancestor, descendant) => git(root, 'merge-base', '--is-ancestor', ancestor, descendant).then(() => true, () => false);
const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const exists = (path) => stat(path).then((info) => info, () => null);

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// ---- reviews ---------------------------------------------------------------------------------------------------

async function hookRecordedSubagents(root) {
  let text;
  try { text = await readFile(sessionOutputPath(root, 'runtime/orchestrator/subagents.jsonl', { create: false }), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

// `assemble` accepts only reviewers the subagent hook recorded; the gate asks the same record again, so an evidence
// file that was written by hand (or names an agent the hook never saw) does not count as a fresh independent review.
function unrecordedReviewer(records, role, contextId) {
  const mine = records.filter((item) => item.agent_id === contextId);
  if (!mine.some((item) => item.agent_type === ROLE_AGENT[role])) return 'the subagent hook never recorded this reviewer';
  if (mine.some((item) => item.forked)) return 'the reviewer was forked from the caller conversation';
  if (!mine.some((item) => item.event === 'SubagentStop' && typeof item.result === 'string')) return 'the reviewer never finished';
  return null;
}

async function deriveReviews({ root, planSetId, plans, head }) {
  const hookRecords = await hookRecordedSubagents(root);
  const problems = [];
  const records = new Map();
  for (const plan of plans) {
    const problem = (reason, extra = {}, negative = false) => problems.push({ plan_id: plan.id, reason, negative, ...extra });
    let evidence;
    try { evidence = await readEvidence(root, plan.id); }
    catch (error) {
      if (error.code === 'ENOENT') problem('review_evidence_missing');
      else problem('review_evidence_invalid', { error: error.message });
      continue;
    }
    records.set(plan.id, evidence);
    const input = evidence.review_input;
    if (input.plan_set_id !== planSetId || input.canonical_plan?.reference !== plan.path) { problem('review_evidence_for_other_plan', {}, true); continue; }
    const byRole = new Map(evidence.reviews.map((review) => [review?.role, review]));
    const missingRoles = ['standards', 'spec'].filter((role) => !byRole.has(role));
    if (missingRoles.length || evidence.reviews.length !== 2) { problem('review_roles_missing', { roles: missingRoles }); continue; }
    const recorded = evidence.passed;
    // `repair` writes `passed` only when the two reviews classified clean (or every finding was settled by a recorded
    // user decision); a reviewer's own `passed` state alone is not the recorded pass.
    const userSettled = Array.isArray(evidence.scope_decisions) && evidence.scope_decisions.length > 0;
    const unresolved = ['standards', 'spec'].filter((role) => byRole.get(role).state !== 'passed' && !(recorded && userSettled && byRole.get(role).state === 'failed'));
    if (unresolved.length) { problem('review_not_complete', { roles: unresolved }, true); continue; }
    const commit = recorded?.implementation_commit_sha;
    if (!SHA.test(commit || '')) { problem('review_pass_not_recorded'); continue; }
    const mismatched = ['standards', 'spec'].filter((role) => byRole.get(role).implementation_commit_sha !== commit || input.implementation_commit_sha !== commit);
    if (mismatched.length) { problem('review_commit_mismatch', { roles: mismatched, passed_commit: commit }, true); continue; }
    const contextIds = ['standards', 'spec'].map((role) => byRole.get(role).context_id);
    const notIndependent = ['standards', 'spec'].filter((role) => byRole.get(role).independent !== true || byRole.get(role).fresh_context !== true || typeof byRole.get(role).context_id !== 'string' || !byRole.get(role).context_id || contextIds.filter((id) => id === byRole.get(role).context_id).length > 1);
    if (notIndependent.length) { problem('review_not_independent', { roles: notIndependent }, true); continue; }
    const unrecorded = ['standards', 'spec'].map((role) => [role, unrecordedReviewer(hookRecords, role, byRole.get(role).context_id)]).filter(([, why]) => why);
    if (unrecorded.length) { for (const [role, why] of unrecorded) problem('review_reviewer_unrecorded', { role, context_id: byRole.get(role).context_id, why }); continue; }
    if (!(await isAncestor(root, commit, head))) { problem('review_commit_not_in_history', { commit }); continue; }
    // The plan's own canonical text must be the one the reviewers judged. (Other plans may change without
    // invalidating this review, so the whole-set planning snapshot is not compared.)
    if (input.canonical_plan?.sha256 !== plan.sha256) problem('review_plan_changed', { reviewed_plan_sha256: input.canonical_plan?.sha256 ?? null, current_plan_sha256: plan.sha256 });
  }
  if (!problems.length) return { verdict: pass('reviews_passed', { plans: plans.map((plan) => ({ plan_id: plan.id, commit: records.get(plan.id).passed.implementation_commit_sha })) }), records };
  const negative = problems.filter((item) => item.negative);
  const listed = problems.slice(0, MAX_LISTED).map(({ negative: _negative, ...item }) => item);
  const details = { problems: listed, problem_count: problems.length };
  const label = (item) => `review:${item.plan_id}${item.role ? `:${item.role}` : ''}${item.roles?.length ? `:${item.roles.join('+')}` : ''}`;
  return { verdict: negative.length ? fail('review', negative[0].reason, negative.map(label), details) : blocked(problems[0].reason, details), records };
}

// ---- tests -----------------------------------------------------------------------------------------------------

async function e2eProfileIds(root, plans) {
  const { manifest } = await readExecutionManifest(root);
  const declared = Object.entries(manifest.profiles).filter(([, profile]) => profile.purpose === 'e2e').map(([id]) => id);
  // The `e2e` plan names the profile it created; without such a plan any plan of the set may name one.
  const source = plans.some((plan) => plan.id === 'e2e') ? plans.filter((plan) => plan.id === 'e2e') : plans;
  const text = source.map((plan) => plan.body).join('\n');
  return declared.filter((id) => new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text));
}

async function profileReceipts(root, profileId) {
  const directory = sessionOutputPath(root, 'runtime/execution', { create: false });
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const found = [];
  for (const name of names) {
    // A profile id may be the prefix of another (`x` and `x-resume`); the suffix must be exactly one run UUID.
    if (!name.startsWith(`${profileId}-`) || !UUID.test(name.slice(profileId.length + 1))) continue;
    const path = join(directory, name, 'receipt.json');
    const receipt = await readJson(path).catch(() => null);
    const info = await exists(path);
    if (!receipt || receipt.profile_id !== profileId || !info) continue;
    const finished = Date.parse(receipt.finished_at);
    found.push({ receipt, directory: join(directory, name), ref: `runtime/execution/${name}/receipt.json`, at: Number.isFinite(finished) ? finished : info.mtimeMs });
  }
  return found.sort((left, right) => left.at - right.at);
}

async function changedSince(root, commit) {
  const split = (text) => text.split('\0').filter(Boolean);
  const tracked = split(await git(root, 'diff', '--name-only', '--no-renames', '-z', commit));
  const untracked = split(await git(root, 'ls-files', '--others', '--exclude-standard', '-z'));
  return [...new Set([...tracked, ...untracked])].sort();
}

async function changedConfiguration(root, receipt) {
  const changed = [];
  for (const [file, digest] of Object.entries(receipt.config_hashes || {})) {
    if (typeof file !== 'string' || !file || isAbsolute(file) || file.split(/[\\/]/).includes('..')) { changed.push(file); continue; }
    try { if (sha256(await readFile(join(root, file))) !== digest) changed.push(file); } catch { changed.push(file); }
  }
  return changed;
}

// The final E2E passes only when the latest E2E run of each profile the `e2e` plan names (a run that reached a verdict,
// `passed` or `failed`) passed AND is a receipt of the code that is now in the branch: written by harness-exec.mjs with
// the commit it ran, that commit is HEAD or an ancestor of it, no application/test file differs between that commit and
// the workspace (documentation paths excepted), nothing application-side was uncommitted when it ran, and the files the
// receipt fingerprinted still hash the same.
async function deriveTests({ root, plans, head }) {
  let profiles;
  try { profiles = await e2eProfileIds(root, plans); }
  catch (error) { return { verdict: blocked('test_evidence_missing', { why: `execution contract unreadable: ${error.message}` }), selected: [] }; }
  if (!profiles.length) return { verdict: blocked('e2e_profile_unresolved', { why: 'no purpose:e2e profile of docs/agents/execution.json is named by the e2e plan' }), selected: [] };
  const problems = [];
  const selected = [];
  const failures = [];
  for (const profileId of profiles) {
    const all = await profileReceipts(root, profileId);
    for (const item of all.filter((entry) => entry.receipt.status === 'failed')) {
      failures.push({ id: item.directory.split('/').at(-1), scenario: 'unknown', profile_id: profileId, category: 'unknown', status: 'failed', learning_route: 'unknown', evidence_path: item.ref });
    }
    const latest = all.filter((entry) => ['passed', 'failed'].includes(entry.receipt.status)).at(-1);
    if (!latest) { problems.push({ profile_id: profileId, reason: 'test_evidence_missing', why: 'no E2E run of this profile reached a verdict' }); continue; }
    selected.push({ profile_id: profileId, ...latest });
    const { receipt } = latest;
    if (receipt.status === 'failed') { problems.push({ profile_id: profileId, reason: 'tests_not_passed', negative: true, receipt: latest.ref, exit_code: receipt.exit_code ?? null }); continue; }
    if (receipt.exit_code !== 0 || !receipt.config_hashes || typeof receipt.config_hashes !== 'object') { problems.push({ profile_id: profileId, reason: 'e2e_receipt_incomplete', receipt: latest.ref }); continue; }
    if (!SHA.test(receipt.head || '')) { problems.push({ profile_id: profileId, reason: 'e2e_receipt_commit_missing', receipt: latest.ref, why: 'the receipt does not record the commit it ran; run the profile again' }); continue; }
    if (!(await isAncestor(root, receipt.head, head))) { problems.push({ profile_id: profileId, reason: 'e2e_receipt_not_in_history', receipt: latest.ref, receipt_commit: receipt.head }); continue; }
    const uncommitted = (receipt.uncommitted_paths || []).filter((path) => !isDocumentationPath(path));
    if (uncommitted.length || receipt.uncommitted_truncated) { problems.push({ profile_id: profileId, reason: 'e2e_receipt_ran_on_uncommitted_changes', receipt: latest.ref, paths: uncommitted.slice(0, MAX_LISTED) }); continue; }
    const configuration = await changedConfiguration(root, receipt);
    if (configuration.length) { problems.push({ profile_id: profileId, reason: 'e2e_receipt_config_changed', receipt: latest.ref, files: configuration.slice(0, MAX_LISTED) }); continue; }
    const changed = (await changedSince(root, receipt.head)).filter((path) => !isDocumentationPath(path));
    if (changed.length) problems.push({ profile_id: profileId, reason: 'e2e_receipt_stale', receipt: latest.ref, receipt_commit: receipt.head, head, paths: changed.slice(0, MAX_LISTED), path_count: changed.length });
  }
  const learning = e2eLearningComplete({ e2e_failures: failures }) ? 'complete' : 'pending';
  if (!problems.length) return { verdict: pass('tests_passed', { e2e_learning: learning, profiles: selected.map((item) => ({ profile_id: item.profile_id, receipt: item.ref, head: item.receipt.head })) }), selected };
  const negative = problems.filter((item) => item.negative);
  const listed = problems.map(({ negative: _negative, ...item }) => item);
  const details = { problems: listed, e2e_learning: learning };
  return { verdict: negative.length ? fail('tests', negative[0].reason, negative.map((item) => `tests:${item.profile_id}`), details) : blocked(problems[0].reason, details), selected };
}

// ---- retirement ------------------------------------------------------------------------------------------------

// A canonical plan declares the paths whose removal the plan set approved in a section headed `## 제거 대상` (or
// `## 승인된 제거 목록`), one backticked workspace-relative path per bullet. The plan-review completion check keeps the
// text equal to what the independent reviewer approved.
function declaredRemovals(plan) {
  const paths = [];
  let level = null;
  for (const line of plan.body.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      if (level !== null && heading[1].length <= level) level = null;
      if (level === null && /^(?:승인된\s+)?제거\s*(?:대상|목록)/.test(heading[2].trim())) level = heading[1].length;
      continue;
    }
    const item = level === null ? null : /^\s*[-*]\s+`([^`]+)`/.exec(line);
    if (item) paths.push({ plan_id: plan.id, path: item[1].trim() });
  }
  return paths;
}

async function deriveRetirement({ root, planSetId, plans }) {
  const declared = plans.flatMap(declaredRemovals);
  const invalid = declared.filter(({ path }) => !path || isAbsolute(path) || path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'));
  if (invalid.length) return blocked('retirement_list_invalid', { invalid });
  const removedPaths = [...new Set(declared.map((item) => item.path))];
  const reason = removedPaths.length
    ? `The plans of ${planSetId} approve removing ${removedPaths.length} path(s): ${declared.map((item) => `${item.plan_id}:${item.path}`).join(', ')}`
    : `No plan of ${planSetId} declares an approved removal list (a "## 제거 대상" section), so no path must be absent`;
  const verdict = await checkRetirement({ retirement: { workspace_root: root, removed_paths: removedPaths, reason } });
  return { ...verdict, details: { ...(verdict.details || {}), removed_paths: removedPaths, reason } };
}

// ---- required outcome and evidence -----------------------------------------------------------------------------

async function deriveRequiredOutcome({ root, planSetId, plans, tests, run }) {
  let tickets;
  try { tickets = await readPlanSetTicketStatuses({ workspace_root: root, plan_set_id: planSetId, plan_ids: plans.map((plan) => plan.id), run }); }
  catch (error) { return blocked('required_outcome_tracker_unresolved', { error: error.message }); }
  const unmapped = tickets.filter((ticket) => !ticket.ticket_ref);
  if (unmapped.length) return blocked('required_outcome_plan_ticket_missing', { plans: unmapped.map((ticket) => ticket.plan_id) });
  const incomplete = tickets.filter((ticket) => ticket.status !== 'completed');
  if (incomplete.length) return blocked('required_outcome_plan_incomplete', { incomplete });
  if (tests.verdict.status !== 'pass') return blocked('required_outcome_e2e_not_passed', { tests_reason: tests.verdict.reason });
  return pass('required_outcome_achieved', { plans: tickets, e2e_profiles: tests.selected.map((item) => item.profile_id) });
}

// "Complete" evidence means every record the other derived checks rest on is still on disk: a progress checkpoint for
// every plan of the set, the review evidence of every plan, and for each E2E profile the receipt the tests check judged
// together with the logs of its steps. A file written but later deleted or emptied makes the session evidence incomplete.
async function deriveEvidence({ root, planSetId, plans, tests, reviews }) {
  const missing = [];
  for (const plan of plans) {
    const candidates = [`runtime/plans/${planSetId}/${plan.id}/checkpoint.md`, `runtime/plans/${plan.id}/checkpoint.md`];
    const found = await Promise.all(candidates.map(async (ref) => { try { return await exists(sessionOutputPath(root, ref, { create: false })); } catch { return null; } }));
    if (!found.some((info) => info?.isFile() && info.size > 0)) missing.push({ kind: 'checkpoint', plan_id: plan.id, looked_for: candidates });
    if (!reviews.records.has(plan.id)) missing.push({ kind: 'review_evidence', plan_id: plan.id });
  }
  if (!tests.selected.length) missing.push({ kind: 'e2e_receipt' });
  for (const item of tests.selected) {
    for (const [index, step] of (Array.isArray(item.receipt.steps) ? item.receipt.steps : []).entries()) {
      // The log path was absolute when written; its file name inside the receipt's own directory is what is read.
      const name = typeof step?.log === 'string' ? step.log.split(/[\\/]/).at(-1) : '';
      const log = name ? await exists(join(item.directory, name)) : null;
      if (!log?.isFile()) missing.push({ kind: 'e2e_step_log', profile_id: item.profile_id, receipt: item.ref, step: index });
    }
  }
  return missing.length
    ? blocked('evidence_incomplete', { missing: missing.slice(0, MAX_LISTED), missing_count: missing.length })
    : pass('evidence_complete', { plans: plans.map((plan) => plan.id), receipts: tests.selected.map((item) => item.ref) });
}

// Derives every implement-wrapper completion input that a model used to assert (required_outcome, tests, reviews,
// retirement, evidence) from the canonical records of the plan set in `root`. Nothing here reads a completion state.
export async function deriveImplementationCompletion({ root, planSetId, run } = {}) {
  const unresolved = (why) => ({ checks: Object.fromEntries(['required_outcome', 'tests', 'review', 'retirement', 'evidence'].map((rule) => [rule, blocked('plan_set_unresolved', { why })])), plan_ids: [] });
  if (!planSetId) return unresolved('the worktree record has no plan_set_id');
  let snapshot;
  try { snapshot = await snapshotPlanSet({ root, planSetId }); }
  catch (error) { return unresolved(error.message); }
  const { plans } = snapshot;
  const head = (await git(root, 'rev-parse', 'HEAD')).trim();
  const tests = await deriveTests({ root, plans, head });
  const reviews = await deriveReviews({ root, planSetId, plans, head });
  const retirement = await deriveRetirement({ root, planSetId, plans });
  const required = await deriveRequiredOutcome({ root, planSetId, plans, tests, run });
  const evidence = await deriveEvidence({ root, planSetId, plans, tests, reviews });
  return { checks: { required_outcome: required, tests: tests.verdict, review: reviews.verdict, retirement, evidence }, plan_ids: plans.map((plan) => plan.id) };
}
