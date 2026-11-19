import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('installed workflow commands require cwd inside the target worktree', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'worktree-cwd-'));
  const primary = join(directory, 'main'), bin = join(directory, 'bin');
  const sessionId = randomUUID();
  await mkdir(primary); await mkdir(bin);
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(primary, 'init', '-q', '-b', 'main');
  git(primary, 'config', 'user.name', 'Workflow test'); git(primary, 'config', 'user.email', 'test@example.test');
  await protectLocalInstallArtifacts(primary, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: primary, initialize: true });
  await (await import('node:fs/promises')).mkdir(join(primary, '.harness'), { recursive: true });
  await writeFile(join(primary, '.harness/harness.yaml'), 'agents:\n  provider: codex\n  codex:\n    high_performance_model: example\n    high_performance_reasoning_effort: medium\n    low_performance_model: example\n    low_performance_reasoning_effort: medium\n    implementation_model: example\n    implementation_reasoning_effort: medium\n');
  await writeFile(join(primary, '.codex/context-budget.json'), '{"schema_version":1,"context_window_tokens":10000,"max_plan_tokens":6000,"handoff_reserve_tokens":2000}\n');
  for (const path of ['docs/agents/EXEC.md', 'docs/agents/execution.json', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/contracts/manifest.json', 'docs/contracts/architecture.html']) {
    await mkdir(join(primary, path, '..'), { recursive: true }); await writeFile(join(primary, path), '');
  }
  await writeFile(join(primary, 'app.txt'), 'baseline\n');
  git(primary, 'add', 'app.txt', 'docs', 'CONTEXT.md', 'CONTEXT-MAP.md');
  git(primary, 'commit', '-qm', 'baseline');

  const invoke = (cwd, script, args = [], env = {}) => spawnSync(process.execPath, [join(cwd, '.codex/scripts', script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  const ok = (cwd, script, args = [], env = {}) => {
    const result = invoke(cwd, script, args, env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const failed = (cwd, script, args = []) => {
    const result = invoke(cwd, script, args);
    assert.notEqual(result.status, 0, result.stdout);
    return result.stderr;
  };
  const entry = (workspace, provider = 'codex') => ok(workspace, 'harness-context.mjs', ['--entry'], { HARNESS_PROVIDER_ID: provider });
  const compose = (slug) => ok(primary, 'harness-compose-workspace.mjs', ['--root', primary, '--execution-id', `compose-${slug}`, '--plan-set-id', slug, '--request', `${slug} feature`, '--orchestrator-provider', 'codex', '--orchestrator-session-id', sessionId]);
  const a = compose('alpha'), b = compose('beta');

  await t.test('primary entry shows both worktree candidates without binding either one', async () => {
    for (const provider of ['codex', 'claude-code']) {
      const context = entry(primary, provider);
      assert.equal(context.decision_hint, 'worktree_required');
      assert.equal(context.worktree_ref, null);
      assert.match(context.next, /change directory to its workspace_root/);
      assert.doesNotMatch(context.next, /harness-native-stage\.mjs launch|references\/dispatch\.md/);
      assert.deepEqual(new Set(context.candidates.map((candidate) => candidate.worktree_ref)), new Set([a.worktree_ref, b.worktree_ref]));
    }
    for (const tree of [a, b]) assert.equal((await json(tree.worktree_ref)).agent_sessions.orchestrator.session_id, sessionId);
  });

  await t.test('the composed worktree gets the first launch command and the installed worker paths', () => {
    const context = entry(b.workspace);
    assert.match(context.next, /references\/dispatch\.md, then run node \.codex\/scripts\/harness-native-stage\.mjs launch --stage-id stakeholder-analysis/);
    assert.ok(context.next.includes(join(b.workspace, '.agents/skills/orchestrator/references/dispatch.md')));
    assert.doesNotMatch(context.next, /workflow-compose\/GUIDE\.md|references\/(?:coordination|workflow-map|capability-routing)\.md/);
    assert.equal(context.candidates, undefined, 'a local entry does not list other worktrees');
    assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 1500);
    const started = ok(b.workspace, 'harness-native-stage.mjs', ['launch', '--stage-id', 'stakeholder-analysis']);
    assert.equal(started.guide, join(b.workspace, '.codex/internal-skills/stakeholder-analysis/GUIDE.md'));
    assert.ok(existsSync(started.input_path));
    assert.ok(existsSync(started.schema_path));
    const resume = entry(b.workspace);
    assert.equal(resume.current_stage, 'stakeholder-analysis');
    assert.doesNotMatch(resume.next, /launch --stage-id stakeholder-analysis/);
  });

  await t.test('root and worktree-ref cannot bypass cwd; local worktree can prepare and dispatch', async () => {
    assert.match(failed(primary, 'harness-context.mjs', ['--worktree-ref', a.worktree_ref]), /change directory into the target worktree/);
    assert.match(failed(primary, 'harness-context.mjs', ['--root', a.workspace]), /change directory first/);
    assert.match(failed(primary, 'harness-prepare-input.mjs', ['--worktree-ref', a.worktree_ref, '--stage-id', 'grilling']), /change directory into the target worktree/);

    const local = ok(a.workspace, 'harness-context.mjs');
    assert.equal(local.workspace_root, a.workspace);
    assert.equal(local.worktree_ref, a.worktree_ref);
    assert.equal(local.plan_set_id, a.plan_set_id);
    const prepared = ok(a.workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'grilling']);
    assert.equal(prepared.input.context.worktree_ref, a.worktree_ref);
    assert.equal(prepared.session_directory, a.session_directory);
    const args = ['start', '--root', a.workspace, '--worktree-ref', a.worktree_ref, '--execution-id', prepared.input.execution_id, '--verbose'];
    assert.match(failed(primary, 'harness-native-stage.mjs', args), /change directory first/);
    const started = ok(a.workspace, 'harness-native-stage.mjs', args);
    assert.equal(started.workspace, a.workspace);
    assert.equal(started.execution_id, prepared.input.execution_id, 'the verbose start echoes the execution');

  });

  await t.test('fresh install, update, Doctor and Git visibility keep managed files out of commits', async () => {
    await writeFile(join(primary, 'app.txt'), 'application change\n');
    await writeFile(join(primary, 'docs/agents/EXEC.md'), 'project execution notes\n');
    await mkdir(join(primary, 'docs/contracts'), { recursive: true });
    await writeFile(join(primary, 'docs/contracts/project-notes.md'), 'project-owned\n');
    const managed = [
      '.harness/src/workflow/cli-context.mjs',
      '.harness/src/workflow/startup-state.mjs',
      '.codex/scripts/harness-context.mjs',
      '.harness/src/workflow/user-inputs.mjs',
      '.codex/internal-skills/stakeholder-analysis/GUIDE.md',
      '.codex/scripts/harness-native-stage.mjs',
      '.harness/src/workflow/stage-cli.mjs',
    ];
    const lockPath = join(primary, '.codex/harness-lock.json'), lock = await json(lockPath);
    const old = 'export const previousVersion = true;\n';
    const hash = createHash('sha256').update(old).digest('hex');
    for (const path of managed) {
      await writeFile(join(primary, path), old);
      lock.files[path] = { ...lock.files[path], installed_sha256: hash, upstream_sha256: hash };
    }
    const profiles = ['.codex/agents/workflow_stage.toml', '.claude/agents/workflow_stage.md'];
    for (const path of profiles) {
      await writeFile(join(primary, path), old);
      lock.files[path] = { ...lock.files[path], installed_sha256: hash, upstream_sha256: hash };
    }
    await writeFile(lockPath, JSON.stringify(lock));
    await updateProject({ sourceRoot, targetRoot: primary });
    for (const path of managed) assert.equal(await readFile(join(primary, path), 'utf8'), await readFile(join(sourceRoot, path), 'utf8'));
    for (const path of profiles) assert.match(await readFile(join(primary, path), 'utf8'), /exact .*receive_command.*via stdin/);
    const installedPath = join(primary, managed[0]);
    assert.equal((await readFile(installedPath, 'utf8')).includes('change directory first'), true);
    const doctor = await runDoctor({ root: primary, sourceRoot });
    assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
    const status = git(primary, 'status', '--short', '--untracked-files=all');
    assert.match(status, /app\.txt/); assert.match(status, /docs\/agents\/EXEC\.md/); assert.match(status, /docs\/contracts\/project-notes\.md/);
    assert.doesNotMatch(status, /\.io\/|\.codex\/|\.harness\/src\//);
    for (const path of [...managed, ...profiles, '.agents/skills/orchestrator/references/dispatch.md', '.codex/scripts/harness-context.mjs', '.io/runtime/orchestrator/progress.json']) git(primary, 'check-ignore', '-v', path);
    const installed = await import(`${pathToFileURL(installedPath).href}?consumer=${randomUUID()}`);
    assert.equal(typeof installed.resolveCommandContext, 'function');
  });
});
