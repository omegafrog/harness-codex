import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { inspectProjectReadiness } from '../src/workflow/project-readiness.mjs';
import { LifecycleGateRegistry, runLifecycleHook } from '../src/gates/lifecycle.mjs';
import { makeContractsFixture } from './contracts-fixture.mjs';

const execFileAsync = promisify(execFile);
const sourceRoot = new URL('..', import.meta.url).pathname;
const session = (await execFileAsync('node', ['.codex/scripts/harness-session-output.mjs', '--root', sourceRoot, '--path', 'tmp'], { cwd: sourceRoot })).stdout.trim();

async function fixture(t) {
  const root = await mkdtemp(join(session, 'project-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await writeFile(join(root, 'docs/agents/EXEC.md'), 'Execution instructions\n');
  return root;
}

function profile(command = ['node', '-e', "require('fs').writeFileSync('must-not-run', 'yes')"]) {
  return { command, required_env: [], config_inputs: ['config.json'], prepare: [], verify_config: [['node', '-e', 'process.exit(0)']], dependencies: [], timeout_ms: 1000, readiness_timeout_ms: 100, poll_interval_ms: 10 };
}

test('blocks missing execution prerequisites and invalid or empty profile manifests', async (t) => {
  const root = await fixture(t);
  assert.equal((await inspectProjectReadiness({ workspace_root: root })).execution.status, 'fail');
  await writeFile(join(root, 'docs/agents/execution.json'), JSON.stringify({ schema_version: 1, profiles: {} }));
  assert.equal((await inspectProjectReadiness({ workspace_root: root })).execution.status, 'fail');
  await writeFile(join(root, 'docs/agents/execution.json'), JSON.stringify({ schema_version: 1, profiles: { test: profile() } }));
  await writeFile(join(root, 'docs/agents/EXEC.md'), '   ');
  assert.equal((await inspectProjectReadiness({ workspace_root: root })).execution.status, 'fail');
  await writeFile(join(root, 'docs/agents/EXEC.md'), 'Execution instructions\n');
  await writeFile(join(root, 'docs/agents/execution.json'), '{');
  assert.equal((await inspectProjectReadiness({ workspace_root: root })).execution.status, 'fail');
});

test('validates profile shape without executing arbitrary configured commands', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'config.json'), '{}');
  await writeFile(join(root, 'docs/agents/execution.json'), JSON.stringify({ schema_version: 1, profiles: { test: profile() } }));
  const result = await inspectProjectReadiness({ workspace_root: root });
  assert.equal(result.execution.status, 'pass');
  await assert.rejects(readFile(join(root, 'must-not-run')));
});

test('the real project defers only its existing source snapshot drift during implementation readiness', async () => {
  const strict = await inspectProjectReadiness({ workspace_root: sourceRoot });
  assert.equal(strict.status, 'blocked');
  assert.equal(strict.contracts.reason, 'contracts_out_of_sync');
  assert.deepEqual(strict.contracts.violations, ['Contract/source snapshot changed; reconcile and seal']);
  const implementation = await inspectProjectReadiness({ workspace_root: sourceRoot, deferContractSync: true });
  assert.equal(implementation.status, 'pass', JSON.stringify(implementation));
  assert.equal(implementation.contract_sync.status, 'deferred');
});

test('implementation preflight defers only a source snapshot drift until final contract synchronization', async (t) => {
  const { root, cleanup } = await makeContractsFixture();
  t.after(cleanup);
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await writeFile(join(root, 'docs/agents/EXEC.md'), 'Execution instructions\n');
  await writeFile(join(root, 'docs/agents/execution.json'), JSON.stringify({ schema_version: 1, profiles: { focused: profile(['node', '-e', 'process.exit(0)']) } }));
  await writeFile(join(root, 'src/app.mjs'), "export const app = 'implementation changes contract snapshot';\n");

  const strict = await inspectProjectReadiness({ workspace_root: root });
  assert.equal(strict.status, 'blocked');
  assert.equal(strict.contracts.reason, 'contracts_out_of_sync');

  const deferred = await inspectProjectReadiness({ workspace_root: root, deferContractSync: true });
  assert.equal(deferred.status, 'pass');
  assert.equal(deferred.reason, 'project_ready_contract_sync_deferred');
  assert.equal(deferred.contract_sync.status, 'deferred');
  assert.equal(deferred.contract_sync.reason, 'sync_after_implementation_complete');

  const gate = await runLifecycleHook({
    hook: 'before_dispatch',
    registry: new LifecycleGateRegistry({ hooks: { before_dispatch: ['project_readiness'], before_handoff: [], before_complete: [], after_merge: [] } }),
    state: { workspace_root: root },
    eventWriter: { append: async () => ({ seq: 1 }) },
  });
  assert.equal(gate.status, 'pass');
  assert.equal(gate.checks.find((entry) => entry.rule_id === 'project_readiness').details.contract_sync.status, 'deferred');

  await writeFile(join(root, 'docs/contracts/manifest.json'), '{');
  const invalid = await inspectProjectReadiness({ workspace_root: root, deferContractSync: true });
  assert.equal(invalid.status, 'blocked');
  assert.equal(invalid.contracts.reason, 'contracts_invalid');
});

test('dispatch lifecycle recomputes readiness instead of trusting claimed pass evidence', async (t) => {
  const root = await fixture(t);
  const result = await runLifecycleHook({
    hook: 'before_dispatch',
    registry: new LifecycleGateRegistry({ hooks: { before_dispatch: ['project_readiness'], before_handoff: [], before_complete: [], after_merge: [] } }),
    state: { workspace_root: root, project_readiness: { status: 'pass' } },
    eventWriter: { append: async () => ({ seq: 1 }) },
  });
  const check = result.checks.find((entry) => entry.rule_id === 'project_readiness');
  assert.equal(check.status, 'blocked');
  assert.equal(check.reason, 'project_preparation_required');
  assert.ok(check.details.next_steps.some((step) => step.startsWith('setup:')));
  assert.ok(check.details.next_steps.some((step) => step.startsWith('sync-contracts:')));
});
