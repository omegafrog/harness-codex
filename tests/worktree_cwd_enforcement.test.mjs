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
  await writeFile(join(primary, '.codex/harness.yaml'), 'agents:\n  provider: codex\n  codex:\n    high_performance_model: example\n    high_performance_reasoning_effort: medium\n    low_performance_model: example\n    low_performance_reasoning_effort: medium\n');
  await writeFile(join(primary, '.codex/context-budget.json'), '{"schema_version":1,"context_window_tokens":10000,"max_plan_tokens":6000,"handoff_reserve_tokens":2000}\n');
  for (const path of ['docs/agents/EXEC.md', 'docs/agents/execution.json', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/contracts/manifest.json', 'docs/contracts/architecture.html']) {
    await mkdir(join(primary, path, '..'), { recursive: true }); await writeFile(join(primary, path), '');
  }
  await writeFile(join(primary, 'app.txt'), 'baseline\n');
  git(primary, 'add', 'app.txt', 'docs', 'CONTEXT.md', 'CONTEXT-MAP.md', '.harness/contracts.mjs');
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
  const compose = (slug) => ok(primary, 'harness-compose-workspace.mjs', ['--root', primary, '--execution-id', `compose-${slug}`, '--plan-set-id', slug, '--request', `${slug} feature`, '--orchestrator-provider', 'codex', '--orchestrator-session-id', sessionId]);
  const a = compose('alpha'), b = compose('beta');

  await t.test('primary checkout can compose, but its prompt is not routed into linked worktrees', async () => {
    const submitted = spawnSync(process.execPath, [join(primary, '.codex/scripts/harness-orchestrator-hook.mjs')], {
      cwd: primary, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: primary, session_id: sessionId, prompt: 'approve everything' }),
    });
    assert.equal(submitted.status, 0, submitted.stderr);
    const context = JSON.parse(submitted.stdout).hookSpecificOutput.additionalContext;
    const observed = JSON.parse(context.match(/Observed state \(read-only worktree\.json\/orchestrator files and Git CLI\): ([\s\S]*?)\. Progress snapshot:/)[1]);
    assert.equal(observed.decision_hint, 'worktree_required');
    assert.equal(observed.input_worktree_ref, null);
    assert.equal(observed.input_routing, 'unbound');
    assert.equal(observed.session_worktrees.length, 0);
    assert.deepEqual(new Set(observed.worktree_candidates.map((candidate) => candidate.worktree_ref)), new Set([a.worktree_ref, b.worktree_ref]));
    for (const tree of [a, b]) assert.equal(existsSync(join(tree.session_directory, 'runtime/orchestrator/user-inputs.jsonl')), false);

    const claude = spawnSync(process.execPath, [join(primary, '.claude/harness/scripts/harness-claude-orchestrator-hook.mjs')], {
      cwd: primary, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: primary, session_id: sessionId, prompt: 'approve everything' }),
    });
    assert.equal(claude.status, 0, claude.stderr);
    const claudeContext = JSON.parse(claude.stdout).hookSpecificOutput.additionalContext;
    assert.match(claudeContext, /current working directory is inside that worktree/);
    assert.match(claudeContext, /change directory to its workspace_root before invoking the orchestrator/);
    for (const tree of [a, b]) assert.equal(existsSync(join(tree.session_directory, 'runtime/orchestrator/user-inputs.jsonl')), false);
  });

  await t.test('root and worktree-ref cannot bypass cwd; local worktree can prepare and dispatch', async () => {
    assert.match(failed(primary, 'harness-context.mjs', ['--worktree-ref', a.worktree_ref]), /change directory into the target worktree/);
    assert.match(failed(primary, 'harness-context.mjs', ['--root', a.workspace]), /change directory first/);
    assert.match(failed(primary, 'harness-prepare-input.mjs', ['--worktree-ref', a.worktree_ref, '--stage-id', 'spec-me']), /change directory into the target worktree/);

    const local = ok(a.workspace, 'harness-context.mjs');
    assert.equal(local.workspace_root, a.workspace);
    assert.equal(local.worktree_ref, a.worktree_ref);
    assert.equal(local.plan_set_id, a.plan_set_id);
    const prepared = ok(a.workspace, 'harness-prepare-input.mjs', ['--stage-id', 'spec-me']);
    assert.equal(prepared.input.context.worktree_ref, a.worktree_ref);
    assert.equal(prepared.session_directory, a.session_directory);
    assert.match(failed(primary, 'harness-agent-run.mjs', ['--worktree-ref', a.worktree_ref, '--execution-id', prepared.input.execution_id, '--background', 'true']), /change directory into the target worktree/);

    const fakeCodex = join(bin, 'codex');
    const cwdFile = join(directory, 'stage-cwd.txt');
    await writeFile(fakeCodex, `#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv[2]==='mcp'){process.stdout.write('{"enabled":false}');process.exit(0);}fs.writeFileSync(${JSON.stringify(cwdFile)},process.cwd());process.exit(1);\n`);
    await chmod(fakeCodex, 0o755);
    const launched = ok(a.workspace, 'harness-agent-run.mjs', ['--execution-id', prepared.input.execution_id, '--background', 'true'], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(launched.status, 'started');
    const deadline = Date.now() + 10000;
    while (!existsSync(cwdFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(await readFile(cwdFile, 'utf8'), a.workspace);
    const events = join(prepared.session_directory, 'runtime/executions', prepared.input.execution_id, 'process-events.jsonl');
    while (Date.now() < deadline) {
      try { if ((await readFile(events, 'utf8')).includes('"event":"runner_completed"')) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(await readFile(events, 'utf8'), /"event":"runner_completed"/);
  });

  await t.test('fresh install, update, Doctor and Git visibility keep managed files out of commits', async () => {
    await writeFile(join(primary, 'app.txt'), 'application change\n');
    await writeFile(join(primary, 'docs/agents/EXEC.md'), 'project execution notes\n');
    await mkdir(join(primary, 'docs/contracts'), { recursive: true });
    await writeFile(join(primary, 'docs/contracts/project-notes.md'), 'project-owned\n');
    const managed = '.harness/src/workflow/cli-context.mjs';
    const lockPath = join(primary, '.codex/harness-lock.json'), lock = await json(lockPath);
    const old = 'export const previousVersion = true;\n';
    const hash = createHash('sha256').update(old).digest('hex');
    await writeFile(join(primary, managed), old);
    lock.files[managed] = { ...lock.files[managed], installed_sha256: hash, upstream_sha256: hash };
    await writeFile(lockPath, JSON.stringify(lock));
    await updateProject({ sourceRoot, targetRoot: primary });
    assert.equal(await readFile(join(primary, managed), 'utf8'), await readFile(join(sourceRoot, managed), 'utf8'));
    const installedPath = join(primary, '.harness/src/workflow/cli-context.mjs');
    assert.equal((await readFile(installedPath, 'utf8')).includes('change directory first'), true);
    const doctor = await runDoctor({ root: primary, sourceRoot });
    assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
    const status = git(primary, 'status', '--short', '--untracked-files=all');
    assert.match(status, /app\.txt/); assert.match(status, /docs\/agents\/EXEC\.md/); assert.match(status, /docs\/contracts\/project-notes\.md/);
    assert.doesNotMatch(status, /\.io\/|\.codex\/|\.harness\/src\//);
    for (const path of [managed, '.codex/scripts/harness-context.mjs', '.io/runtime/orchestrator/progress.json']) git(primary, 'check-ignore', '-v', path);
    const installed = await import(`${pathToFileURL(installedPath).href}?consumer=${randomUUID()}`);
    assert.equal(typeof installed.resolveCommandContext, 'function');
  });
});
