import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listPlanTickets, planDependencies, syncTrackerStatus } from '../.harness/src/tracker/lifecycle.mjs';

test('local tracker resolves prerequisites and changes status without invoking an external command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-tracker-'));
  try {
    await mkdir(join(root, '.harness'), { recursive: true });
    await mkdir(join(root, 'docs/plans/set'), { recursive: true });
    await writeFile(join(root, '.harness/harness.yaml'), 'tracker:\n  mode: local-markdown\n');
    await writeFile(join(root, 'docs/plans/set/P1.md'), '---\nstatus: planned\n---\n# P1\n');
    await writeFile(join(root, 'docs/plans/set/P2.md'), '---\nstatus: planned\n---\n# P2\n\n## 의존성\n`P1` 선행\n');
    const run = () => { throw new Error('unexpected external command'); };
    assert.equal((await listPlanTickets({ workspace_root: root, plan_set_id: 'set', run })).length, 2);
    assert.equal((await planDependencies({ workspace_root: root, plan_set_id: 'set', plan_id: 'P2', run })).status, 'blocked');
    await assert.rejects(syncTrackerStatus({ workspace_root: root, ticket_ref: 'docs/plans/set/P1.md', phase: 'test', run }), /retired with Beads/);
    assert.equal((await syncTrackerStatus({ workspace_root: root, ticket_ref: 'docs/plans/set/P1.md', status: 'completed', run })).status, 'pass');
    assert.equal((await planDependencies({ workspace_root: root, plan_set_id: 'set', plan_id: 'P2', run })).status, 'pass');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('GitHub plan mapping reads issue identities directly from repository Issues', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-tracker-'));
  try {
    await mkdir(join(root, '.harness'), { recursive: true });
    await writeFile(join(root, '.harness/harness.yaml'), 'tracker:\n  mode: github\n  github:\n    repository: owner/repo\n    project_owner: owner\n    project_number: 1\n    status_field: Workflow Status\n');
    const run = async (command, args) => {
      assert.equal(command, 'gh');
      if (args[0] === 'api' && args[1] === '--paginate') return JSON.stringify([[{ number: 42, html_url: 'https://github.com/owner/repo/issues/42', body: '<!-- harness-plan {"plan_set_id":"set","plan_id":"P1"} -->' }]]);
      throw new Error(`unexpected command ${args}`);
    };
    assert.deepEqual(await listPlanTickets({ workspace_root: root, plan_set_id: 'set', run }), [{ plan_id: 'P1', ticket_ref: 'owner/repo#42' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installer backs up and retires old Beads hooks while preserving project hooks', async () => {
  const { retireProjectHooks, inspectRetiredProjectHooks } = await import('../.harness/src/installer/orchestrator-hook.mjs');
  const { readFile, readdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'harness-hooks-'));
  try {
    await mkdir(join(root, '.codex'), { recursive: true });
    const original = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'bd codex-hook SessionStart', type: 'command' }, { command: 'custom', type: 'command' }] }] } });
    await writeFile(join(root, '.codex/hooks.json'), original);
    assert.equal((await inspectRetiredProjectHooks(root)).beads, 1);
    await retireProjectHooks(root);
    assert.equal((await inspectRetiredProjectHooks(root)).beads, 0);
    const hooks = JSON.parse(await readFile(join(root, '.codex/hooks.json'), 'utf8'));
    assert.deepEqual(hooks.hooks.SessionStart[0].hooks, [{ command: 'custom', type: 'command' }]);
    const backup = (await readdir(join(root, '.codex/installer-backups')))[0];
    assert.equal(await readFile(join(root, '.codex/installer-backups', backup, 'hooks.json'), 'utf8'), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed consumer uses local tracker and retires managed Beads assets without hiding project files', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { updateProject } = await import('../.harness/src/installer/update.mjs');
  const { protectLocalInstallArtifacts } = await import('../.harness/src/installer/local-exclude.mjs');
  const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'harness-consumer-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    await writeFile(join(root, 'app.txt'), 'application change\n');
    await mkdir(join(root, '.beads'), { recursive: true });
    await writeFile(join(root, '.beads/user-data'), 'keep\n');
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await mkdir(join(root, 'docs/plans/set'), { recursive: true });
    await writeFile(join(root, '.harness/harness.yaml'), 'tracker:\n  mode: local-markdown\n');
    await writeFile(join(root, 'docs/plans/set/P1.md'), '---\nstatus: planned\n---\n# P1\n');
    const hookPath = join(root, '.codex/hooks.json');
    const hookConfig = JSON.parse(await readFile(hookPath, 'utf8').catch((error) => { if (error.code === 'ENOENT') return '{\"hooks\":{}}'; throw error; }));
    hookConfig.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'bd codex-hook SessionStart' }] }];
    await writeFile(hookPath, JSON.stringify(hookConfig));
    const { runDoctor } = await import(pathToFileURL(join(root, '.harness/src/doctor/doctor.mjs')).href);
    assert.ok((await runDoctor({ root, sourceRoot })).diagnostics.some(({ code }) => code === 'retired_beads_hook'));
    await mkdir(join(root, '.codex/internal-skills/beads'), { recursive: true });
    await writeFile(join(root, '.codex/internal-skills/beads/GUIDE.md'), 'old guide');
    const updated = await updateProject({ sourceRoot, targetRoot: root, noBackup: true });
    assert.equal(await readFile(join(updated.backup_directory, '.codex/internal-skills/beads/GUIDE.md'), 'utf8'), 'old guide');
    assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some(({ code }) => code === 'retired_beads_hook'), false);
    const installed = await import(pathToFileURL(join(root, '.harness/src/tracker/lifecycle.mjs')).href);
    assert.equal((await installed.syncTrackerStatus({ workspace_root: root, ticket_ref: 'docs/plans/set/P1.md', status: 'completed' })).status, 'pass');
    assert.equal(await readFile(join(root, '.beads/user-data'), 'utf8'), 'keep\n');
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /app\.txt/);
    assert.match(status, /docs\/plans\/set\/P1\.md/);
    assert.doesNotMatch(status, /\.harness\/skills/);
    await assert.rejects(readFile(join(root, '.codex/internal-skills/beads/GUIDE.md')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
