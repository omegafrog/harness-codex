import './support/trusted-codex-home.mjs';
import { bindNativeReviewer } from './support/native-reviewer.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { discoverManagedAssetPaths, updateProject } from '../.harness/src/installer/update.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { updatePlanReview } from '../.harness/src/workflow/plan-review.mjs';
import { createWorkflowWorktree, finishWorkflowWorktree } from '../.harness/src/workflow/worktrees.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const PLAN_SET = 'calc';
const PROFILE = 'calc-e2e';
const NEW_FILE = '.harness/src/workflow/implementation-completion.mjs';
const profileManifest = {
  schema_version: 1,
  profiles: {
    [PROFILE]: {
      purpose: 'e2e', command: ['node', '-e', 'process.exit(0)'], required_env: [], config_inputs: ['docs/agents/execution.json'],
      prepare: [], verify_config: [['node', '--version']], dependencies: [], timeout_ms: null, readiness_timeout_ms: 5000, poll_interval_ms: 100,
    },
  },
};
const planBody = (title, extra = '') => `---\nstatus: planned\n---\n# ${title}\n\n## 구현 목적과 범위\n${title} 구현.\n${extra}`;
const passingAnswer = JSON.stringify({ state: 'passed', report: { findings: [] } });

// A consumer with Harness installed through the real installer, a plan set whose plan review passed, two implemented
// plans with passed code reviews, one passing E2E receipt written by harness-exec.mjs, completed tickets and a sealed
// contract bundle: every canonical record the final implement-wrapper gate reads, produced by the code that owns it.
async function buildConsumer() {
  const root = await mkdtemp(join(tmpdir(), 'implement-wrapper-completion-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Contract');
  git(root, 'config', 'user.email', 'contract@example.test');
  const baseline = {
    'CONTEXT.md': '# Context\n', 'CONTEXT-MAP.md': '# Context map\n', 'docs/agents/EXEC.md': '',
    'docs/agents/execution.json': `${JSON.stringify(profileManifest, null, 2)}\n`,
  };
  for (const [path, content] of Object.entries(baseline)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  await updateProject({ sourceRoot, targetRoot: root });
  git(root, 'add', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs', '.harness/contracts.mjs');
  git(root, 'commit', '-q', '-m', 'Consumer setup baseline');
  const tree = await createWorkflowWorktree({ workspace_root: root, plan_set_id: PLAN_SET });
  const ws = tree.workspace;
  const session = tree.session_directory;
  const wgit = (...args) => git(ws, ...args);
  const write = async (path, content) => { await mkdir(join(ws, path, '..'), { recursive: true }); await writeFile(join(ws, path), content); };
  const here = (path) => import(pathToFileURL(join(ws, path)).href);

  await write('.codex/harness.yaml', 'tracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\nbeads:\n  enabled: false\n');
  for (const name of ['request', 'product-spec', 'architecture-spec']) await write(`docs/specs/${PLAN_SET}/${name}.md`, `# ${name}\n`);
  await write(`docs/plans/${PLAN_SET}/plans.md`, `# Plan set\nProduct Spec: \`docs/specs/${PLAN_SET}/product-spec.md\`\nArchitecture Spec: \`docs/specs/${PLAN_SET}/architecture-spec.md\`\n`);
  await write(`docs/plans/${PLAN_SET}/calculator.md`, planBody('calculator'));
  await write(`docs/plans/${PLAN_SET}/e2e.md`, planBody('e2e', `\n## E2E 실행 계약\n\`${PROFILE}\` profile(\`purpose: "e2e"\`)을 그대로 따른다.\n`));
  wgit('add', 'docs');
  wgit('commit', '-q', '-m', 'to-ticket plans');
  const documented = wgit('rev-parse', 'HEAD').trim();

  // The plan set's review, recorded the way a stage records it (a native reviewer bound by the subagent hook).
  const { recordExecutionState } = await here('.harness/src/workflow/execution-state.mjs');
  const input = { skill: 'to-ticket', execution_id: 'to-ticket', session_directory: session, context: { worktree_ref: join(session, 'worktree.json') } };
  const binding = { model: 'example', reasoning_effort: 'low' };
  await recordExecutionState({ root: ws, input, binding, status: 'running' });
  await recordExecutionState({ root: ws, input, binding, status: 'action_required', code: 'REVIEW_REQUIRED' });
  const saved = Object.fromEntries(['HARNESS_WORKSPACE_ROOT', 'HARNESS_SKILL_EXECUTION_ID'].map((key) => [key, process.env[key]]));
  try {
    process.env.HARNESS_WORKSPACE_ROOT = ws;
    process.env.HARNESS_SKILL_EXECUTION_ID = input.execution_id;
    const admission = await updatePlanReview({ root: ws, planSetId: PLAN_SET, action: 'begin' });
    await bindNativeReviewer({ root: ws, scope: `plan-${PLAN_SET}`, attemptId: admission.attempt_id, executionId: input.execution_id, reviewerId: 'plan-reviewer', parentSessionId: 'plan-author' });
    await updatePlanReview({ root: ws, planSetId: PLAN_SET, action: 'record', attemptId: admission.attempt_id, review: { reviewer_id: 'plan-reviewer', author_ids: ['plan-author'], fork_turns: 'none', verdict: 'pass', inputs: admission.inputs, findings: [] } });
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }

  // Each plan is implemented in its own commit and reviewed through the real review CLI building blocks.
  const reviews = await here('.harness/src/wrapper/review-input.mjs');
  const subagents = [];
  const commits = {};
  let fixedPoint = documented;
  for (const [planId, file] of [['calculator', 'src/calc.js'], ['e2e', 'e2e/calc.spec.js']]) {
    await write(file, `export const ${planId.replace(/\W/g, '_')} = true;\n`);
    wgit('add', file);
    wgit('commit', '-q', '-m', `Implement ${planId}`);
    commits[planId] = wgit('rev-parse', 'HEAD').trim();
    const reviewInput = await reviews.buildReviewInput({ root: ws, planId, fixedPoint, commit: commits[planId], unplannedAdditions: [] });
    const evidence = reviews.assembleReviews({ reviewInput, standards: { contextId: `standards-${planId}`, raw: passingAnswer }, spec: { contextId: `spec-${planId}`, raw: passingAnswer }, specItems: [] });
    await reviews.writeReviewEvidence({ root: ws, planId, evidence });
    await reviews.recordPassedReview({ root: ws, planId, evidence });
    for (const [role, agent] of [['standards', 'standards_reviewer'], ['spec', 'spec_reviewer']]) {
      const base = { session_id: 'orchestrator', agent_id: `${role}-${planId}`, agent_type: agent, recorded_at: new Date().toISOString() };
      subagents.push({ event: 'SubagentStart', ...base }, { event: 'SubagentStop', ...base, result: passingAnswer });
    }
    await mkdir(join(session, `runtime/plans/${PLAN_SET}/${planId}`), { recursive: true });
    await writeFile(join(session, `runtime/plans/${PLAN_SET}/${planId}/checkpoint.md`), `# ${planId} checkpoint\n`);
    fixedPoint = commits[planId];
  }
  await mkdir(join(session, 'runtime/orchestrator'), { recursive: true });
  await writeFile(join(session, 'runtime/orchestrator/subagents.jsonl'), `${subagents.map((item) => JSON.stringify(item)).join('\n')}\n`);

  // The final E2E, run through the real runner against the committed code.
  const exec = spawnSync(process.execPath, [join(ws, '.codex/scripts/harness-exec.mjs'), '--root', ws, '--profile', PROFILE], { cwd: ws, encoding: 'utf8' });
  assert.equal(exec.status, 0, exec.stdout + exec.stderr);

  // Tickets complete, documentation commit after the E2E, contract bundle sealed against the final plan documents.
  for (const planId of ['calculator', 'e2e']) {
    const path = `docs/plans/${PLAN_SET}/${planId}.md`;
    await write(path, (await readFile(join(ws, path), 'utf8')).replace('status: planned', 'status: completed'));
  }
  await write('docs/contracts/product.md', '# Product\n');
  await write('docs/contracts/architecture.md', '# Architecture\n');
  await write('docs/contracts/manifest.json', JSON.stringify({ schema_version: 1, features: [], components: [], diagrams: [{ kind: 'ddd', reason: 'fixture has no domain model' }, { kind: 'class', reason: 'fixture has no domain model' }], source_roots: [], empty_project_reason: 'fixture has no domain model' }));
  await (await here('.harness/src/contracts/contracts.mjs')).sealContracts({ workspace_root: ws, change_summary: 'fixture' });
  wgit('add', 'docs');
  wgit('commit', '-q', '-m', 'Complete tickets and seal contracts');

  const cli = (extra = [], { workflow = 'implement-wrapper' } = {}) => spawnSync(process.execPath, [join(ws, '.codex/scripts/harness-workflow-complete.mjs'), '--root', ws, '--workflow', workflow, '--worktree-id', tree.worktree_id, '--base-ref', tree.head, ...extra], { cwd: ws, encoding: 'utf8' });
  const gate = (extra, options) => { const run = cli(extra, options); return { status: run.status, result: run.stdout ? JSON.parse(run.stdout) : null, stderr: run.stderr }; };
  return {
    root, tree, ws, session, git, wgit, write, here, commits, documented, gate,
    derive: async () => (await here(NEW_FILE)).deriveImplementationCompletion({ root: ws, planSetId: PLAN_SET }),
    cleanup: async () => { await finishWorkflowWorktree({ workspace_root: ws, repository_root: root, worktree_id: tree.worktree_id, outcome: 'aborted' }).catch(() => {}); await rm(root, { recursive: true, force: true }); },
  };
}

const sessionFile = (fixture, path) => join(fixture.session, path);
// Runs `body` with `path` temporarily replaced by `transform(original)` (or absent when transform returns null).
async function withEdit(path, transform, body) {
  const original = await readFile(path, 'utf8');
  const edited = transform(original);
  if (edited === null) await unlink(path); else await writeFile(path, edited);
  try { return await body(); } finally { await writeFile(path, original); }
}
async function withHidden(path, body) {
  const stash = `${path}.hidden`;
  await rename(path, stash);
  try { return await body(); } finally { await rename(stash, path); }
}
const editJson = (path, mutate, body) => withEdit(path, (text) => { const value = JSON.parse(text); mutate(value); return `${JSON.stringify(value, null, 2)}\n`; }, body);
const problem = (verdict, planId) => verdict.details.problems.find((item) => item.plan_id === planId);

test('implement-wrapper final gate is derived from canonical records, never from a state file', async (t) => {
  const f = await buildConsumer();
  const { derive, gate } = f;
  const evidencePath = (planId) => sessionFile(f, `runtime/reviews/implementation-${planId}-evidence.json`);
  const receiptDirectory = async () => { const directory = sessionFile(f, 'runtime/execution'); return join(directory, (await readdir(directory)).find((name) => name.startsWith(`${PROFILE}-`))); };
  let newerReceipts = 0;
  // Writes a newer receipt derived from the real one, so the scenario differs from it in exactly the stated fields.
  const newerReceipt = async (changes) => {
    const source = JSON.parse(await readFile(join(await receiptDirectory(), 'receipt.json'), 'utf8'));
    const directory = sessionFile(f, `runtime/execution/${PROFILE}-aaaaaaaa-bbbb-4ccc-8ddd-${String(++newerReceipts).padStart(12, '0')}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'receipt.json'), JSON.stringify({ ...source, finished_at: new Date(Date.now() + 60_000).toISOString(), ...changes }));
    return directory;
  };
  try {
    await t.test('every canonical record present: the gate passes with no state file and plan_review gets the plan set', async () => {
      const receipt = JSON.parse(await readFile(join(await receiptDirectory(), 'receipt.json'), 'utf8'));
      assert.equal(receipt.head, f.commits.e2e);
      assert.deepEqual(receipt.uncommitted_paths, []);
      assert.match(receipt.finished_at, /^\d{4}-\d{2}-\d{2}T/);
      const { status, result } = gate();
      assert.equal(status, 0, JSON.stringify(result?.verdict));
      assert.equal(result.state, 'completed');
      assert.equal(result.ignored_state_keys, undefined);
      const checks = Object.fromEntries(result.verdict.checks.map((check) => [check.rule_id, check]));
      assert.deepEqual(Object.keys(checks).sort(), ['contract_docs', 'evidence', 'plan_review', 'required_outcome', 'retirement', 'review', 'tests', 'tracker_sync']);
      for (const check of Object.values(checks)) assert.equal(check.status, 'pass', `${check.rule_id}: ${check.reason}`);
      assert.equal(checks.plan_review.reason, 'plan_set_completion_current');
      assert.equal(checks.tests.details.profiles[0].head, f.commits.e2e);
      assert.equal(checks.retirement.details.removed_paths.length, 0);
      assert.match(checks.retirement.details.reason, /No plan of calc declares an approved removal list/);
    });

    await t.test('a hand-written state asserting success does not satisfy the gate when the records are missing', async () => {
      const directory = sessionFile(f, 'runtime/implement-wrapper');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'completion-state.json'), JSON.stringify({
        required_outcome: { passed: true }, evidence: { complete: true }, tests: { status: 'passed', e2e_failures: [] },
        reviews: { spec: { state: 'passed' }, standards: { state: 'passed' } },
        retirement: { workspace_root: f.ws, removed_paths: [], reason: 'nothing to remove' },
        plan_review: { plan_set_id: 'other-set', phase: 'planning' }, plan_set_id: 'other-set',
      }));
      const state = ['--state', 'runtime/implement-wrapper/completion-state.json'];
      await withHidden(sessionFile(f, 'runtime/execution'), () => withHidden(evidencePath('calculator'), async () => {
        const { status, result } = gate(state);
        assert.notEqual(status, 0);
        assert.equal(result.state, 'in-progress');
        assert.deepEqual(result.ignored_state_keys.sort(), ['evidence', 'plan_review', 'plan_set_id', 'required_outcome', 'retirement', 'reviews', 'tests']);
        const checks = Object.fromEntries(result.verdict.checks.map((check) => [check.rule_id, check]));
        assert.equal(checks.review.reason, 'review_evidence_missing');
        assert.equal(checks.review.details.problems[0].plan_id, 'calculator');
        assert.equal(checks.tests.reason, 'test_evidence_missing');
        for (const rule of ['review', 'tests', 'required_outcome', 'evidence']) assert.notEqual(checks[rule].status, 'pass', rule);
        assert.equal(checks.plan_review.status, 'pass', 'the plan set comes from the worktree record, not the state');
      }));
      // With the records present the same state file changes nothing: it is ignored, not trusted and not rejected.
      const { status, result } = gate(state);
      assert.equal(status, 0, JSON.stringify(result?.verdict));
      assert.equal(result.ignored_state_keys.length, 7);
    });

    await t.test('code reviews: each missing or unsound record names its plan and role', async () => {
      await withHidden(evidencePath('calculator'), async () => {
        const { checks } = await derive();
        assert.equal(checks.review.status, 'blocked');
        assert.equal(checks.review.reason, 'review_evidence_missing');
        assert.equal(problem(checks.review, 'calculator').reason, 'review_evidence_missing');
        assert.equal(checks.evidence.reason, 'evidence_incomplete');
        assert.ok(checks.evidence.details.missing.some((item) => item.kind === 'review_evidence' && item.plan_id === 'calculator'));
      });
      await editJson(evidencePath('calculator'), (value) => { value.reviews.find((item) => item.role === 'spec').state = 'failed'; delete value.passed; }, async () => {
        const { checks } = await derive();
        assert.equal(checks.review.status, 'fail');
        assert.equal(checks.review.reason, 'review_not_complete');
        assert.deepEqual(problem(checks.review, 'calculator').roles, ['spec']);
        assert.deepEqual(checks.review.violations, ['review:calculator:spec']);
      });
      await editJson(evidencePath('e2e'), (value) => { delete value.passed; }, async () => {
        const { checks } = await derive();
        assert.equal(checks.review.status, 'blocked');
        assert.equal(checks.review.reason, 'review_pass_not_recorded');
        assert.equal(problem(checks.review, 'e2e').plan_id, 'e2e');
      });
      await editJson(evidencePath('e2e'), (value) => { value.reviews.find((item) => item.role === 'spec').context_id = value.reviews.find((item) => item.role === 'standards').context_id; }, async () => {
        const { checks } = await derive();
        assert.equal(checks.review.status, 'fail');
        assert.equal(checks.review.reason, 'review_not_independent');
        assert.deepEqual(problem(checks.review, 'e2e').roles, ['standards', 'spec']);
      });
      // Reviewers the subagent hook never recorded (or forked from the caller) are not fresh independent reviewers.
      await withEdit(sessionFile(f, 'runtime/orchestrator/subagents.jsonl'), (text) => text.split('\n').filter((line) => !line.includes('"spec-e2e"')).join('\n'), async () => {
        const { checks } = await derive();
        assert.equal(checks.review.reason, 'review_reviewer_unrecorded');
        assert.deepEqual([problem(checks.review, 'e2e').role, problem(checks.review, 'e2e').context_id], ['spec', 'spec-e2e']);
      });
      await withEdit(sessionFile(f, 'runtime/orchestrator/subagents.jsonl'), (text) => `${text}${JSON.stringify({ event: 'SubagentStart', agent_id: 'standards-calculator', agent_type: 'standards_reviewer', forked: true })}\n`, async () => {
        assert.match(problem((await derive()).checks.review, 'calculator').why, /forked/);
      });
      // A review of a commit that is not in the branch history is not a review of this code.
      const orphan = f.wgit('commit-tree', 'HEAD^{tree}', '-m', 'orphan').trim();
      await withEdit(evidencePath('calculator'), (text) => text.replaceAll(f.commits.calculator, orphan), async () => {
        const { checks } = await derive();
        assert.equal(checks.review.reason, 'review_commit_not_in_history');
        assert.equal(problem(checks.review, 'calculator').commit, orphan);
      });
      await editJson(evidencePath('calculator'), (value) => { value.passed.implementation_commit_sha = orphan; }, async () => {
        const { checks } = await derive();
        assert.equal(checks.review.reason, 'review_commit_mismatch');
      });
      // A plan edited after its review needs a new review.
      const plan = join(f.ws, `docs/plans/${PLAN_SET}/calculator.md`);
      await withEdit(plan, (text) => `${text}\n추가 요구.\n`, async () => {
        const { checks } = await derive();
        assert.equal(checks.review.reason, 'review_plan_changed');
        assert.equal(problem(checks.review, 'calculator').reason, 'review_plan_changed');
      });
      assert.equal((await derive()).checks.review.status, 'pass');
    });

    await t.test('final E2E: the latest receipt must have passed for the code that is now in the branch', async () => {
      await withHidden(sessionFile(f, 'runtime/execution'), async () => {
        const { checks } = await derive();
        assert.equal(checks.tests.reason, 'test_evidence_missing');
        assert.equal(checks.required_outcome.reason, 'required_outcome_e2e_not_passed');
        assert.ok(checks.evidence.details.missing.some((item) => item.kind === 'e2e_receipt'));
      });
      const reasonAfter = async (changes, cleanup = true) => {
        const directory = await newerReceipt(changes);
        try { return (await derive()).checks.tests; } finally { if (cleanup) await rm(directory, { recursive: true, force: true }); }
      };
      const failed = await reasonAfter({ status: 'failed', exit_code: 1 });
      assert.equal(failed.status, 'fail');
      assert.equal(failed.reason, 'tests_not_passed');
      assert.deepEqual(failed.violations, [`tests:${PROFILE}`]);
      assert.equal(failed.details.e2e_learning, 'pending');
      assert.equal((await reasonAfter({ status: 'blocked', exit_code: undefined })).status, 'pass', 'a run that never reached a verdict does not replace the earlier verdict');
      const legacy = await reasonAfter({ head: undefined, uncommitted_paths: undefined });
      assert.equal(legacy.reason, 'e2e_receipt_commit_missing');
      const orphan = f.wgit('commit-tree', 'HEAD^{tree}', '-m', 'orphan').trim();
      assert.equal((await reasonAfter({ head: orphan })).reason, 'e2e_receipt_not_in_history');
      const dirty = await reasonAfter({ uncommitted_paths: ['src/calc.js'] });
      assert.equal(dirty.reason, 'e2e_receipt_ran_on_uncommitted_changes');
      assert.deepEqual(dirty.details.problems[0].paths, ['src/calc.js']);
      assert.equal((await reasonAfter({ uncommitted_paths: ['docs/specs/calc/request.md'] })).status, 'pass', 'documentation edits do not invalidate the run');

      // Application code that differs from the tested commit makes the receipt stale (untracked, then committed).
      await writeFile(join(f.ws, 'src/later.js'), 'export const later = true;\n');
      let stale = (await derive()).checks.tests;
      assert.equal(stale.reason, 'e2e_receipt_stale');
      assert.deepEqual(stale.details.problems[0].paths, ['src/later.js']);
      f.wgit('add', 'src/later.js');
      f.wgit('commit', '-q', '-m', 'Change application after the E2E');
      stale = (await derive()).checks.tests;
      assert.equal(stale.reason, 'e2e_receipt_stale');
      assert.equal(stale.details.problems[0].receipt_commit, f.commits.e2e);
      f.wgit('reset', '-q', '--hard', 'HEAD~1');
      await writeFile(join(f.ws, 'docs/notes.md'), 'notes after the E2E\n');
      assert.equal((await derive()).checks.tests.status, 'pass');
      await unlink(join(f.ws, 'docs/notes.md'));

      // The profile and the files it fingerprinted must be what the run used.
      await editJson(join(f.ws, 'docs/agents/execution.json'), (value) => { value.profiles[PROFILE].poll_interval_ms = 200; }, async () => {
        const { tests } = (await derive()).checks;
        assert.equal(tests.reason, 'e2e_receipt_config_changed');
        assert.deepEqual(tests.details.problems[0].files, ['docs/agents/execution.json']);
      });
      // The profile comes from the e2e plan; without it the gate cannot know what to require.
      await withEdit(join(f.ws, `docs/plans/${PLAN_SET}/e2e.md`), (text) => text.replaceAll(PROFILE, 'other-profile'), async () => {
        assert.equal((await derive()).checks.tests.reason, 'e2e_profile_unresolved');
      });
      assert.equal((await derive()).checks.tests.status, 'pass');
    });

    await t.test('required outcome: every plan ticket must be completed in the tracker', async () => {
      await withEdit(join(f.ws, `docs/plans/${PLAN_SET}/calculator.md`), (text) => text.replace('status: completed', 'status: in-progress'), async () => {
        const { required_outcome: outcome } = (await derive()).checks;
        assert.equal(outcome.status, 'blocked');
        assert.equal(outcome.reason, 'required_outcome_plan_incomplete');
        assert.deepEqual(outcome.details.incomplete.map((item) => [item.plan_id, item.status]), [['calculator', 'in-progress']]);
      });
    });

    await t.test('retirement: the removal list comes from the plans, and an empty list is a derived pass', async () => {
      const plan = join(f.ws, `docs/plans/${PLAN_SET}/calculator.md`);
      await withEdit(plan, (text) => `${text}\n## 제거 대상\n- \`src/calc.js\` — 새 경로로 대체\n`, async () => {
        const { retirement } = (await derive()).checks;
        assert.equal(retirement.status, 'fail');
        assert.equal(retirement.reason, 'retired_path_still_present');
        assert.deepEqual(retirement.details.path, 'src/calc.js');
      });
      await withEdit(plan, (text) => `${text}\n## 승인된 제거 목록\n- \`src/removed-already.js\`\n\n## 다음 절\n- \`src/calc.js\`\n`, async () => {
        const { retirement } = (await derive()).checks;
        assert.equal(retirement.status, 'pass');
        assert.deepEqual(retirement.details.removed_paths, ['src/removed-already.js']);
      });
      await withEdit(plan, (text) => `${text}\n## 제거 대상\n- \`../outside\`\n`, async () => {
        assert.equal((await derive()).checks.retirement.reason, 'retirement_list_invalid');
      });
      assert.equal((await derive()).checks.retirement.status, 'pass');
    });

    await t.test('evidence: the session records the other checks rest on must still be on disk', async () => {
      await withHidden(sessionFile(f, `runtime/plans/${PLAN_SET}/e2e/checkpoint.md`), async () => {
        const { evidence } = (await derive()).checks;
        assert.equal(evidence.reason, 'evidence_incomplete');
        assert.deepEqual(evidence.details.missing.map((item) => [item.kind, item.plan_id]), [['checkpoint', 'e2e']]);
      });
      const log = join(await receiptDirectory(), '0.log');
      await withHidden(log, async () => {
        const { evidence } = (await derive()).checks;
        assert.equal(evidence.details.missing[0].kind, 'e2e_step_log');
      });
      assert.equal((await derive()).checks.evidence.status, 'pass');
    });

    await t.test('dropping completion state keys is scoped to implement-wrapper', async () => {
      const run = gate(['--state', 'runtime/implement-wrapper/completion-state.json'], { workflow: 'spec-me' });
      assert.equal(run.result.workflow_id, 'spec-me');
      assert.equal(run.result.ignored_state_keys, undefined);
    });
  } finally {
    await f.cleanup();
  }
});

test('installed consumer: the derived gate ships through install and update, stays out of commits, and Doctor sees it', async () => {
  const f = await buildConsumer();
  const insideWorktree = (path) => join(f.ws, path);
  try {
    assert.ok((await discoverManagedAssetPaths(sourceRoot)).includes(NEW_FILE));
    for (const base of [f.root, f.ws]) {
      assert.match(await readFile(join(base, NEW_FILE), 'utf8'), /deriveImplementationCompletion/);
      assert.match(f.git(base, 'check-ignore', '-v', NEW_FILE), /\.git\/info\/exclude/);
    }
    await writeFile(insideWorktree('application-owned.txt'), 'keep visible');
    const status = f.wgit('status', '--short', '--untracked-files=all');
    assert.match(status, /application-owned\.txt/);
    assert.doesNotMatch(status, /\.io\/|\.harness\/src|\.codex\//);
    assert.equal(status.includes('implementation-completion'), false);
    // The orchestrator guidance no longer hands the gate a state file for implementation completion.
    for (const path of ['.agents/skills/orchestrator/SKILL.md', '.claude/skills/orchestrator/SKILL.md']) {
      const guide = await readFile(join(f.root, path), 'utf8');
      assert.match(guide, /--base-ref <시작 commit SHA> --final-workflow`/);
      assert.doesNotMatch(guide, /--final-workflow \[--state/);
      assert.match(guide, /상태 파일을 만들거나 넘기지 않는다/);
    }
    // Doctor reports a deleted runtime module of the installed lock.
    const present = await runDoctor({ root: f.root, sourceRoot });
    assert.equal(present.diagnostics.some((item) => item.code === 'installer_missing_file' && item.path.endsWith('implementation-completion.mjs')), false);
    await unlink(join(f.root, NEW_FILE));
    const missing = await runDoctor({ root: f.root, sourceRoot });
    assert.ok(missing.diagnostics.some((item) => item.code === 'installer_missing_file' && item.severity === 'error' && item.path.endsWith('implementation-completion.mjs')));
    // Update restores it for a consumer that has the previous release (no module, no lock entry yet).
    const lockPath = join(f.root, '.codex/harness-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    delete lock.files[NEW_FILE];
    await writeFile(lockPath, JSON.stringify(lock));
    const updated = await updateProject({ sourceRoot, targetRoot: f.root });
    assert.ok(updated.added.includes(NEW_FILE), JSON.stringify(updated));
    assert.match(await readFile(join(f.root, NEW_FILE), 'utf8'), /deriveImplementationCompletion/);
    assert.match(f.git(f.root, 'check-ignore', '-v', NEW_FILE), /\.git\/info\/exclude/);
    assert.equal(f.git(f.root, 'status', '--short', '--untracked-files=all'), '');
    const restored = await runDoctor({ root: f.root, sourceRoot });
    assert.equal(restored.diagnostics.some((item) => ['installer_missing_file', 'installer_unlocked_file'].includes(item.code) && item.path.endsWith('implementation-completion.mjs')), false);
  } finally {
    await f.cleanup();
  }
});
