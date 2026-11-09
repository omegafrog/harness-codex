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
    await writeFile(join(root, '.io/runtime/orchestrator/state.json'), JSON.stringify({ status: 'running', current_stage: 'to-ticket', stages: { 'to-ticket': { status: 'completed', code: 'OK', execution_id: 'to-ticket-1' } } }));
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
  } finally { await rm(directory, { recursive: true, force: true }); }
});
