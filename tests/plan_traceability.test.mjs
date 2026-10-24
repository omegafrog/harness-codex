import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { inspectPlanTraceability, inspectTraceabilityImpact, snapshotPlanTraceability } from '../src/workflow/plan-traceability.mjs';
import { sessionDirectory } from '../src/workflow/session-output.mjs';
import { PlanCheckpointStore } from '../src/wrapper/checkpoint.mjs';
import { dispatchImplementPlan } from '../src/wrapper/dispatch.mjs';
import { reconcileCompletion } from '../src/wrapper/reconciliation.mjs';
import { ExecutionSlotRegistry } from '../src/wrapper/scheduler.mjs';
import { makeContractsFixture } from './contracts-fixture.mjs';
import { updateReviewAttempt } from '../src/workflow/review-attempts.mjs';

const digest = (text) => createHash('sha256').update(text).digest('hex');
async function fixture() {
  assert.ok(process.env.HARNESS_SESSION_DIR, 'Run this test through harness-exec');
  const root = await mkdtemp(join(process.env.HARNESS_SESSION_DIR, 'tmp/traceability-'));
  const spec = 'docs/specs/ticket-9';
  const base = 'docs/plans/set-9';
  const specText = '# Product\n- **BR-38:** Prevent uncovered execution rules.\n';
  const archText = '# Architecture\nNo additional declared IDs.\n';
  const planText = 'Plan plan-a implements BR-38. all requirements map. valid criteria can still miss source rules. focused test rejects missing coverage.\n';
  execFileSync('git', ['init', '-q', root]);
  const executionProfile = {
    command: ['node', '-e', 'process.exit(0)'], required_env: [], config_inputs: ['src/feature.mjs', 'tests/feature.test.mjs'],
    prepare: [], verify_config: [['node', '-e', 'process.exit(0)']],
    dependencies: [{ id: 'service', check: ['node', '-e', "const fs=require('node:fs');const p=process.env.HARNESS_SESSION_DIR+'/tmp/trace-ready';if(!fs.existsSync(p)){fs.writeFileSync(p,'ready');process.exit(1)}"] }],
    timeout_ms: 5000, readiness_timeout_ms: 2000, poll_interval_ms: 20,
  };
  for (const [path, content] of [[`${spec}/product-spec.md`, specText], [`${spec}/architecture-spec.md`, archText], [`${base}/plans.md`, 'Plan plan-a\n'], [`${base}/plan-a.md`, planText], ['src/feature.mjs', 'export const feature = true;\n'], ['tests/feature.test.mjs', 'assert.equal(true, true);\n'], ['docs/agents/execution.json', JSON.stringify({ schema_version: 1, profiles: { focused: executionProfile } })]]) {
    const pathTarget = join(root, path); await mkdir(join(pathTarget, '..'), { recursive: true }); await writeFile(pathTarget, content);
  }
  let ledger = {
    schema_version: 2, plan_set_id: 'set-9', ticket_id: 'ticket-9', handoffs: [],
    spec_paths: [`${spec}/product-spec.md`, `${spec}/architecture-spec.md`],
    requirements: [{ id: 'BR-38', source_path: `${spec}/product-spec.md`, source_anchor: 'BR-38', statement: 'Prevent uncovered execution rules.', owner: 'plan-a', plan_ids: ['plan-a'], disposition: 'covered', coverage: [{ plan_id: 'plan-a', acceptance_criteria: ['all requirements map'], verification_cases: ['focused test rejects missing coverage'] }] }],
    plans: [{ id: 'plan-a', requirement_ids: [`${spec}/product-spec.md#BR-38`], content_path: `${base}/plan-a.md`, verification_profile: 'focused', acceptance_criteria: ['all requirements map'], counterexamples: ['valid criteria can still miss source rules'], verification_cases: ['focused test rejects missing coverage'] }],
  };
  const ledgerPath = join(root, base, 'traceability.json');
  const save = async () => writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  await save();
  const snapshot = await snapshotPlanTraceability({ root, planSetId: 'set-9' });
  ledger.review = { reviewer_id: 'independent', author_ids: ['writer'], fork_turns: 'none', verdict: 'pass', findings: [], inputs: snapshot.inputs };
  await save();
  return { root, base, spec, ledger, save };
}

test('planning traceability validates full source-to-plan coverage and independent fresh review', async () => {
  const f = await fixture();
  try {
    assert.equal((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'planning' })).status, 'pass');
    const repo = new URL('..', import.meta.url).pathname;
    const installedRuntime = join(f.root, '.codex/harness-runtime/src');
    await mkdir(join(installedRuntime, '..'), { recursive: true });
    await cp(join(repo, 'src'), installedRuntime, { recursive: true });
    await mkdir(join(f.root, '.codex/scripts'), { recursive: true });
    await writeFile(join(f.root, '.codex/scripts/harness-plan-traceability.mjs'), await readFile(new URL('../.codex/scripts/harness-plan-traceability.mjs', import.meta.url)));
    const cli = spawnSync(process.execPath, [join(f.root, '.codex/scripts/harness-plan-traceability.mjs'), 'check', '--root', f.root, '--plan-set', 'set-9', '--phase', 'dispatch', '--plan', 'plan-a'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.match(cli.stdout, /plan_traceability_dispatch_current/);
    f.ledger.review.reviewer_id = 'writer'; await f.save();
    assert.match((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'planning' })).reason, /independent/);
    f.ledger.review.reviewer_id = 'independent'; f.ledger.plans[0].requirement_ids = []; await f.save();
    assert.match((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'planning' })).reason, /changed|unknown|coverage|requirement_ids/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('plan dispatch waits for the admitted review result to be recorded', async () => {
  const f = await fixture();
  try {
    const options = { root: f.root, scope: 'plan-set-9' };
    const snapshot = await snapshotPlanTraceability({ root: f.root, planSetId: 'set-9' });
    const start = await updateReviewAttempt({ ...options, action: 'begin', inputs: snapshot.inputs });
    const blocked = await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'dispatch', planId: 'plan-a' });
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.reason, /Record a passing/);
    await updateReviewAttempt({ ...options, action: 'record', attemptId: start.attempt_id, inputs: snapshot.inputs, review: f.ledger.review });
    assert.equal((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'dispatch', planId: 'plan-a' })).status, 'pass');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('planning blocks a requirement ID whose acceptance or verification is not explicitly mapped', async () => {
  const f = await fixture();
  try {
    f.ledger.requirements[0].coverage[0].verification_cases = [];
    await f.save();
    const result = await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'planning' });
    assert.equal(result.status, 'blocked');
    assert.match(result.reason, /explicit requirement coverage|verification cases/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('legacy schema v1 remains readable for reviewed dispatch but cannot start new planning', async () => {
  const f = await fixture();
  try {
    f.ledger.schema_version = 1;
    delete f.ledger.handoffs;
    delete f.ledger.requirements[0].coverage;
    await f.save();
    f.ledger.review.inputs = (await snapshotPlanTraceability({ root: f.root, planSetId: 'set-9' })).inputs;
    await f.save();

    assert.equal((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'dispatch', planId: 'plan-a' })).status, 'pass');
    const planning = await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'planning' });
    assert.equal(planning.status, 'blocked');
    assert.match(planning.reason, /schema_version 2/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('planning requires producer and consumer responsibilities plus a consumer verification case for handoffs', async () => {
  const f = await fixture();
  try {
    const consumerPath = `${f.base}/plan-b.md`;
    const sourcePath = `${f.spec}/product-spec.md`;
    await writeFile(join(f.root, sourcePath), '# Product\n- **BR-38:** Prevent uncovered execution rules.\n- **BR-39:** Consume the produced plan data.\n');
    await writeFile(join(f.root, consumerPath), 'Plan plan-b implements BR-39. Consume plan data. Reject missing producer data. Consumer rejects missing producer output.\n');
    await writeFile(join(f.root, f.base, 'plans.md'), 'plan-a\nplan-b\n');
    f.ledger.requirements.push({ id: 'BR-39', source_path: sourcePath, source_anchor: 'BR-39', statement: 'Consume the produced plan data.', owner: 'plan-b', plan_ids: ['plan-b'], disposition: 'covered', coverage: [{ plan_id: 'plan-b', acceptance_criteria: ['Consume plan data.'], verification_cases: ['Consumer rejects missing producer output.'] }] });
    f.ledger.plans.push({ id: 'plan-b', content_path: consumerPath, requirement_ids: [`${sourcePath}#BR-39`], acceptance_criteria: ['Consume plan data.'], counterexamples: ['Reject missing producer data.'], verification_cases: ['Consumer rejects missing producer output.'], verification_profile: 'focused' });
    f.ledger.handoffs = [{ id: 'handoff-1', producer_plan_id: 'plan-a', consumer_plan_id: 'plan-b', produces: 'all requirements map', consumes: 'Consume plan data.', verification_case: 'Consumer rejects missing producer output.' }];
    await f.save();
    const passing = await snapshotPlanTraceability({ root: f.root, planSetId: 'set-9' });
    f.ledger.review.inputs = passing.inputs;
    await f.save();
    assert.equal((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'planning' })).status, 'pass');

    f.ledger.handoffs[0].verification_case = 'generic integration test';
    await f.save();
    const blocked = await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'planning' });
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.reason, /consumer verification case/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('dispatch accepts the reviewed uncommitted Spec bytes and blocks a later Spec edit', async () => {
  const f = await fixture();
  try {
    execFileSync('git', ['-C', f.root, 'config', 'user.email', 'fixture@example.invalid']);
    execFileSync('git', ['-C', f.root, 'config', 'user.name', 'Fixture']);
    execFileSync('git', ['-C', f.root, 'add', '.']);
    execFileSync('git', ['-C', f.root, 'commit', '-qm', 'fixture baseline']);
    const specPath = join(f.root, f.spec, 'product-spec.md');
    await writeFile(specPath, '# Product\n- **BR-38:** Prevent uncovered rules in the current uncommitted Spec.\n');
    f.ledger.requirements[0].statement = 'Prevent uncovered rules in the current uncommitted Spec.';
    await f.save();
    f.ledger.review.inputs = (await snapshotPlanTraceability({ root: f.root, planSetId: 'set-9' })).inputs;
    await f.save();
    assert.equal((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'dispatch', planId: 'plan-a' })).status, 'pass');

    await writeFile(specPath, '# Product\n- **BR-38:** Changed after review snapshot.\n');
    assert.match((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'dispatch', planId: 'plan-a' })).reason, /stale/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('impact reports added and removed declarations and conservatively invalidates all plans', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, f.spec, 'product-spec.md'), '# Product\n- **BR-38:** Prevent uncovered execution rules.\n- **AC-39:** Newly declared acceptance rule.\n');
    const impact = await inspectTraceabilityImpact({ root: f.root, planSetId: 'set-9' });
    assert.deepEqual(impact.added_requirement_ids, [`${f.spec}/product-spec.md#AC-39`]);
    assert.deepEqual(impact.affected_plan_ids, ['plan-a']);
    assert.match(impact.revalidation, /conservatively/);
    assert.equal((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'planning' })).status, 'blocked');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('requirement references in prose and diagram inventories are not declarations', async () => {
  const f = await fixture();
  try {
    const productPath = join(f.root, f.spec, 'product-spec.md');
    await writeFile(productPath, '# Product\n### UC-001 Prepare an ability definition.\n- UC-001 diagram inventory entry.\n- **BR-38:** Prevent uncovered execution rules.\n');
    f.ledger.requirements.push({ id: 'UC-001', source_path: `${f.spec}/product-spec.md`, source_anchor: 'UC-001', statement: 'Prepare an ability definition.', owner: 'plan-a', plan_ids: ['plan-a'], disposition: 'covered', coverage: [{ plan_id: 'plan-a', acceptance_criteria: ['all requirements map'], verification_cases: ['focused test rejects missing coverage'] }] });
    f.ledger.plans[0].requirement_ids.push(`${f.spec}/product-spec.md#UC-001`);
    await writeFile(join(f.root, f.base, 'plan-a.md'), 'Plan plan-a implements BR-38 and UC-001. all requirements map. valid criteria can still miss source rules. focused test rejects missing coverage.\n');
    await f.save();

    const snapshot = await snapshotPlanTraceability({ root: f.root, planSetId: 'set-9' });
    assert.ok(snapshot.declarations.includes(`${f.spec}/product-spec.md#UC-001`));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('unchanged planning inputs stay current after ordinary source edits and report no impact', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'src/feature.mjs'), 'export const feature = false;\n');
    assert.equal((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'planning' })).status, 'pass');
    const impact = await inspectTraceabilityImpact({ root: f.root, planSetId: 'set-9' });
    assert.deepEqual(impact.changed_paths, []);
    assert.deepEqual(impact.affected_requirement_ids, []);
    assert.deepEqual(impact.affected_plan_ids, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('review, declaration, and path validation reject compact negative cases', async (t) => {
  const cases = [
    ['inherited reviewer context', async (f) => { f.ledger.review.fork_turns = 'all'; await f.save(); }],
    ['unresolved major finding', async (f) => { f.ledger.review.findings = [{ severity: 'major' }]; await f.save(); }],
    ['finding without evidence', async (f) => { f.ledger.review.findings = [{ severity: 'minor', description: 'Small ambiguity' }]; await f.save(); }],
    ['duplicate source declaration', async (f) => { await writeFile(join(f.root, f.spec, 'product-spec.md'), '# Product\n- **BR-38:** first\n- **BR-38:** duplicate\n'); }],
    ['workspace path traversal', async (f) => { f.ledger.spec_paths.push('../outside.md'); await f.save(); }],
    ['symlink review input', async (f) => { const target = join(f.root, f.spec, 'product-spec.md'); const copy = `${target}.copy`; await writeFile(copy, await readFile(target)); await rm(target); await symlink(copy, target); }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async () => {
    const f = await fixture();
    try {
      await mutate(f);
      assert.equal((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'planning' })).status, 'blocked');
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});

test('GitHub canonical body is re-read through tracker port and invalidates old review', async () => {
  const f = await fixture();
  try {
    const body = await readFile(join(f.root, f.base, 'plan-a.md'), 'utf8');
    delete f.ledger.plans[0].content_path;
    f.ledger.plans[0].canonical = { kind: 'github', repository: 'owner/repo', issue: 42 };
    await f.save();
    const trackerPort = { execute: async ({ operation, target }) => {
      assert.equal(operation, 'read_issue'); assert.equal(target.issue, 42); return { body };
    } };
    const snapshot = await snapshotPlanTraceability({ root: f.root, planSetId: 'set-9', trackerPort });
    f.ledger.review.inputs = snapshot.inputs; await f.save();
    assert.equal((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'dispatch', planId: 'plan-a', trackerPort })).status, 'pass');
    const changedPort = { execute: async () => ({ body: `${body}\nChanged canonical acceptance text.` }) };
    assert.match((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'dispatch', planId: 'plan-a', trackerPort: changedPort })).reason, /stale/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('completion requires current evidence and successful selected-profile receipt bound to source and tests', async () => {
  const f = await fixture();
  try {
    const result = await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'completion', planId: 'plan-a' });
    assert.match(result.reason, /Implementation evidence missing/);
    const sourceHash = digest('export const feature = true;\n'), testHash = digest('assert.equal(true, true);\n');
    const execCli = new URL('../.codex/scripts/harness-exec.mjs', import.meta.url).pathname;
    const run = spawnSync(process.execPath, [execCli, '--root', f.root, '--profile', 'focused'], { cwd: f.root, encoding: 'utf8', env: process.env });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const execution = JSON.parse(run.stdout);
    assert.equal(execution.status, 'passed');
    assert.ok(execution.steps.filter((step) => step.phase === 'dependency:service').some((step) => step.exit_code !== 0), 'fixture exercises readiness retries');
    const receiptRelative = execution.evidence_path.replace(`${sessionDirectory(f.root)}/`, '');
    f.ledger.implementation = { 'plan-a': { requirements: [{ requirement_id: `${f.spec}/product-spec.md#BR-38`, files: [{ path: 'src/feature.mjs', sha256: sourceHash }], verification: [{ path: 'tests/feature.test.mjs', sha256: testHash }], receipt: receiptRelative }] } };
    await f.save();
    assert.equal((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'completion', planId: 'plan-a' })).status, 'pass');
    await writeFile(join(f.root, 'src/feature.mjs'), 'export const feature = false;\n');
    assert.match((await inspectPlanTraceability({ root: f.root, planSetId: 'set-9', phase: 'completion', planId: 'plan-a' })).reason, /stale/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('real implementation dispatch blocks before spawn when traceability is absent', async () => {
  const root = await mkdtemp(join(process.env.HARNESS_SESSION_DIR, 'tmp/traceability-dispatch-'));
  const fixture = await makeContractsFixture({ root });
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await writeFile(join(root, 'docs/agents/EXEC.md'), 'fixture execution contract');
  await writeFile(join(root, 'docs/agents/execution.json'), JSON.stringify({ schema_version: 1, profiles: { focused: { command: ['node', '-e', 'process.exit(0)'], required_env: [], config_inputs: ['docs/agents/EXEC.md'], prepare: [], verify_config: [['node', '-e', 'process.exit(0)']], dependencies: [], timeout_ms: 1000, readiness_timeout_ms: 100, poll_interval_ms: 10 } } }));
  const store = new PlanCheckpointStore({ root, planId: 'plan-a' });
  let spawned = false;
  try {
    await assert.rejects(() => dispatchImplementPlan({
      plan: { id: 'plan-a' }, plans: [{ id: 'plan-a', status: 'planned', dependencies: [], resources: ['filesystem:src/a'] }],
      planSetId: 'set-9', repository: root, executionLine: root, slotRegistry: new ExecutionSlotRegistry(), checkpointStore: store,
      spawnImplement: async () => { spawned = true; }, smartZone: { phase: 'dispatch', state: 'fits', evidence: 'fits' }, model: 'test-model',
      readGitState: async () => ({ changed_files: [] }), readTestState: async () => ({ status: 'not-run' }),
    }), (error) => error.reason === 'plan_traceability_failed');
    assert.equal(spawned, false);
  } finally { await store.close(); await fixture.cleanup(); }
});

test('failed traceability completion cannot mark a ticket done or release dependents', () => {
  const implementation = { state: 'completed', commit_sha: 'commit-1' };
  const reviews = ['standards', 'spec'].map((role) => ({ role, state: 'passed', independent: true, fresh_context: true, context_id: role, implementation_commit_sha: 'commit-1' }));
  const result = reconcileCompletion({
    plan: { id: 'plan-a' }, implementation, reviews, tests: { status: 'passed' },
    evidence: { fixed_point: 'base', implementation, tests: { status: 'passed' }, reviews },
    contractDocs: { status: 'pass' }, trackerSync: { status: 'pass' }, planTraceability: { status: 'blocked', reason: 'stale' },
    trackerSnapshot: { status: 'Done', project_status: 'Done' },
    dependents: [{ id: 'plan-b', status: 'planned', dependencies: ['plan-a'] }],
  });
  assert.equal(result.can_complete, false);
  assert.notEqual(result.tracker_reconciliation.requested_status, 'Done');
  assert.deepEqual(result.dependents.ready, []);
});
