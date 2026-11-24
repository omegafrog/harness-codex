import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReportedUseCases, runExecution } from '../.harness/src/workflow/execution.mjs';
// The completion gate is loaded through its entry module, as the runner does; the gate modules import each other.
import '../.harness/src/workflow/completion.mjs';
import { useCaseCoverage } from '../.harness/src/workflow/implementation-completion.mjs';

async function workspaceWith(command) {
  const root = await mkdtemp(join(tmpdir(), 'harness-use-cases-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-qm', 'baseline']);
  await mkdir(join(root, '.io'), { recursive: true });
  await mkdir(join(root, '.harness/agents'), { recursive: true });
  await writeFile(join(root, '.harness/agents/EXEC.md'), 'execution contract\n');
  const noop = [process.execPath, '-e', '0'];
  await writeFile(join(root, '.harness/agents/execution.json'), JSON.stringify({ schema_version: 1, profiles: { e2e: {
    purpose: 'e2e', command, required_env: [], config_inputs: ['.harness/agents/EXEC.md'], prepare: [], verify_config: [noop], dependencies: [],
    timeout_ms: 5_000, readiness_timeout_ms: 2_000, poll_interval_ms: 10,
  } } }));
  return root;
}

const reports = (lines) => [process.execPath, '-e', `require('node:fs').appendFileSync(process.env.HARNESS_E2E_USE_CASES_FILE, ${JSON.stringify(lines)})`];

test('the E2E receipt records the use cases the run reported, and says so when it reported none', async (t) => {
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  const run = async (command) => {
    const root = await workspaceWith(command);
    t.after(() => rm(root, { recursive: true, force: true }));
    process.chdir(root);
    const receipt = await runExecution({ workspace_root: root, profile_id: 'e2e', environment: process.env });
    return { receipt, saved: JSON.parse(await readFile(receipt.evidence_path, 'utf8')) };
  };

  const reported = await run(reports('UC-02\nUC-01\nUC-02\n{"use_case":"UC-03"}\nnot a case!\n'));
  assert.equal(reported.receipt.status, 'passed');
  assert.deepEqual(reported.saved.use_cases, { status: 'reported', exercised: ['UC-01', 'UC-02', 'UC-03'], invalid_lines: 1 });

  const silent = await run([process.execPath, '-e', '0']);
  assert.equal(silent.receipt.status, 'passed');
  assert.deepEqual(silent.saved.use_cases, { status: 'unreported', exercised: [] }, 'a run that reports nothing is not credited with coverage');

  const failing = await run([process.execPath, '-e', `require('node:fs').appendFileSync(process.env.HARNESS_E2E_USE_CASES_FILE, 'UC-01\\n'); process.exitCode = 1`]);
  assert.equal(failing.receipt.status, 'failed');
  assert.deepEqual(failing.saved.use_cases.exercised, ['UC-01'], 'what a failed run reached is still recorded');

  const unreadable = await run([process.execPath, '-e', `require('node:fs').mkdirSync(process.env.HARNESS_E2E_USE_CASES_FILE)`]);
  assert.equal(unreadable.receipt.status, 'passed', 'a report that cannot be read never fails a passing run');
  assert.equal(unreadable.saved.use_cases.status, 'unreported');
});

test('the reported use cases are bounded and only well-formed IDs count', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'harness-use-case-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'use-cases.txt');
  assert.deepEqual(await readReportedUseCases(file), { status: 'unreported', exercised: [] });
  await writeFile(file, `${'x'.repeat(2 * 1024 * 1024)}\nUC-LATE\n`);
  const huge = await readReportedUseCases(file);
  assert.equal(huge.exercised.includes('UC-LATE'), false, 'the report is read up to a bounded size');
  await writeFile(file, ' UC-01 \n{"id":"UC-02"}\n{broken\n../escape\n\n');
  assert.deepEqual(await readReportedUseCases(file), { status: 'reported', exercised: ['UC-01', 'UC-02'], invalid_lines: 2 });
});

test('completion compares the reported use cases with the approved scope and blocks only on a recorded gap', () => {
  const receipt = (exercised) => ({ use_cases: { status: 'reported', exercised } });
  const request = { scenarios: ['UC-02', 'UC-01'] };

  assert.deepEqual(useCaseCoverage({ request, receipt: receipt(['UC-01', 'UC-02', 'UC-09']) }), { status: 'covered', approved_source: 'scenarios', approved: ['UC-01', 'UC-02'], exercised: ['UC-01', 'UC-02', 'UC-09'], uncovered: [], outside_approved: ['UC-09'] });
  const gap = useCaseCoverage({ request, receipt: receipt(['UC-01']) });
  assert.equal(gap.status, 'uncovered');
  assert.deepEqual(gap.uncovered, ['UC-02'], 'the use case that was not run is named');

  // Nothing reported: coverage cannot be judged. It is unverified, not a failure and not a pass.
  for (const unreported of [{}, { use_cases: { status: 'unreported', exercised: [] } }, { use_cases: { status: 'reported' } }]) {
    const result = useCaseCoverage({ request, receipt: unreported });
    assert.equal(result.status, 'unreported');
    assert.deepEqual(result.uncovered, ['UC-01', 'UC-02']);
    assert.equal(result.exercised, null);
  }

  // The user's approved use cases take precedence over the scenario list that names them.
  const named = useCaseCoverage({ request: { use_cases: ['UC-05'], scenarios: ['E2E-01'] }, receipt: receipt(['E2E-01']) });
  assert.equal(named.approved_source, 'use_cases');
  assert.deepEqual(named.uncovered, ['UC-05']);
  assert.equal(useCaseCoverage({ request: { scenarios: [] }, receipt: {} }).status, 'none_approved', 'nothing approved leaves nothing to compare');
});
