import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../.codex/scripts/', import.meta.url));
const run = (cwd, script, ...args) => spawnSync(process.execPath, [join(scripts, script), ...args], { cwd, encoding: 'utf8' });

// Commands run inside a worktree read the root and plan set themselves, so an agent does not copy IDs from files.
test('Harness commands infer the workspace and plan set from the worktree they run in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-context-'));
  const primary = join(directory, 'primary'), root = join(directory, 'workspace');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', primary]);
    execFileSync('git', ['-C', primary, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '--allow-empty', '-qm', 'base']);
    execFileSync('git', ['-C', primary, 'worktree', 'add', '-qb', 'feature/test', root]);
    for (const dir of ['docs/plans/set', 'docs/specs/set', 'docs/agents', '.io/runtime/orchestrator', 'src']) await mkdir(join(root, dir), { recursive: true });
    for (const name of ['product', 'architecture']) await writeFile(join(root, `docs/specs/set/${name}-spec.md`), `# ${name}\n`);
    await writeFile(join(root, 'docs/agents/EXEC.md'), '');
    await writeFile(join(root, 'docs/plans/set/plans.md'), '# Plans\n');
    await writeFile(join(root, 'docs/plans/set/auth.md'), '# auth\n');
    await writeFile(join(root, '.io/worktree.json'), JSON.stringify({ schema_version: 1, worktree_id: 'c5c669a2-2967-4831-98db-63a24954e857', workspace: root, common: join(primary, '.git'), return_root: primary, session_directory: join(root, '.io'), branch: 'feature/test', state: 'active', plan_set_id: 'set' }));
    await writeFile(join(root, '.io/runtime/orchestrator/state.json'), JSON.stringify({ schema_version: 1, workflow_ref: null, status: 'running', current_stage: 'to-ticket', stages: { 'to-ticket': { status: 'completed', code: 'OK', execution_id: 'to-ticket-1' } } }));
    // From a subdirectory, with no --root or --plan-set.
    const snapshot = run(join(root, 'src'), 'harness-plan-review.mjs', 'snapshot');
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.equal(JSON.parse(snapshot.stdout).plan_set_id, 'set');
    // A plan set that contradicts the worktree is refused.
    assert.match(run(root, 'harness-plan-review.mjs', 'snapshot', '--plan-set', 'other').stderr, /does not match the current worktree/);
    // One call shows the workflow context.
    const context = JSON.parse(run(root, 'harness-context.mjs').stdout);
    assert.equal(context.plan_set_id, 'set');
    assert.equal(context.current_stage, 'to-ticket');
    assert.deepEqual(context.plans, ['auth']);
    assert.equal(context.stages['to-ticket'].status, 'completed');
    // A question the orchestrator asked in conversation is kept by the Stop hook and shown here.
    const stop = spawnSync(process.execPath, [join(scripts, 'harness-orchestrator-hook.mjs')], { cwd: root, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'Stop', cwd: root, session_id: 'orchestrator', last_assistant_message: '댓글로 기록할까요?' }) });
    const turn = JSON.parse(run(root, 'harness-context.mjs').stdout).orchestrator_last_turn;
    assert.equal(turn?.message, '댓글로 기록할까요?', `status=${stop.status} stdout=${stop.stdout} stderr=${stop.stderr}`);
    assert.equal(turn.after_latest_stage, true);
    // A delivered turn's reply, written by codex -o, wins when it is newer.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(root, '.io/runtime/orchestrator/last-turn.txt'), '지원할까요?');
    assert.equal(JSON.parse(run(root, 'harness-context.mjs').stdout).orchestrator_last_turn.message, '지원할까요?');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('E2E workspace preflight checks Git registration without requiring tracker storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'e2e-preflight-'));
  const primary = join(directory, 'primary'), workspace = join(directory, 'workspace');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', primary]);
    execFileSync('git', ['-C', primary, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '--allow-empty', '-qm', 'base']);
    execFileSync('git', ['-C', primary, 'worktree', 'add', '-qb', 'test/e2e', workspace]);
    const result = run(workspace, 'harness-workspace-preflight.mjs', '--workspace-root', workspace, '--for-e2e', '--json');
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, true);
    assert.equal(report.worktree_registered, true);
    assert.deepEqual(report.tracker_sync, { status: 'not_required', reason: 'e2e_workspace_integrity_only' });
    assert.notEqual(run(workspace, 'harness-workspace-preflight.mjs', '--workspace-root', workspace, '--for-e2e', '--for-implementation', '--json').status, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
