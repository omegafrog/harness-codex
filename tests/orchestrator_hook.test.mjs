import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { updateProject } from '../src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../src/installer/local-exclude.mjs';
import { inspectOrchestratorHook } from '../src/installer/orchestrator-hook.mjs';
import { runDoctor } from '../src/doctor/index.mjs';
import { prepareComposerWorkspace } from '../src/workflow/composer-workspace.mjs';
import { recordExecutionState } from '../src/workflow/execution-state.mjs';
import { inspectStartupState } from '../src/workflow/startup-state.mjs';
import { createWorkflowWorktree, registerWorkflowWorktree, finishWorkflowWorktree } from '../src/workflow/worktrees.mjs';
import { sessionDirectory, sessionOutputPath } from '../src/workflow/session-output.mjs';

const SOURCE = fileURLToPath(new URL('..', import.meta.url));

test('installed startup hook routes workflow composition before any request workflow exists and preserves other hooks', async () => {
  const root = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), "harness hook 'quoted'-"));
  const user = { type: 'command', command: 'bd codex-hook UserPromptSubmit', statusMessage: 'Existing user hook' };
  const old = { description: 'Project-owned configuration', hooks: { UserPromptSubmit: [{ hooks: [user] }], SessionStart: [{ hooks: [{ type: 'command', command: 'echo custom-start' }] }] } };
  try {
    const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
    git('init', '-q');
    await mkdir(join(root, '.beads'));
    await mkdir(join(root, '.codex'), { recursive: true });
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, '.codex/hooks.json'), JSON.stringify(old));
    await writeFile(join(root, 'app.txt'), 'Application edit\n');
    await protectLocalInstallArtifacts(root, SOURCE);
    for (const initialize of [true, false]) {
      await updateProject({ sourceRoot: SOURCE, targetRoot: root, initialize });
      const hooks = JSON.parse(await readFile(join(root, '.codex/hooks.json'), 'utf8'));
      assert.equal(hooks.description, old.description);
      assert.deepEqual(hooks.hooks.SessionStart, old.hooks.SessionStart);
      assert.deepEqual(hooks.hooks.UserPromptSubmit[0], old.hooks.UserPromptSubmit[0]);
      assert.equal(hooks.hooks.UserPromptSubmit.length, 2);
      assert.equal((await inspectOrchestratorHook(root)).valid, true);
      const own = hooks.hooks.UserPromptSubmit[1].hooks[0];
      const event = { hook_event_name: 'UserPromptSubmit', cwd: join(root, 'nested'), session_id: 'fixture-session', prompt: 'Design a new feature' };
      const invoked = spawnSync(own.command, { shell: true, cwd: event.cwd, input: JSON.stringify(event), encoding: 'utf8' });
      assert.equal(invoked.status, 0, invoked.stderr);
      const result = JSON.parse(invoked.stdout).hookSpecificOutput;
      assert.equal(result.hookEventName, 'UserPromptSubmit');
      assert.ok(result.additionalContext.includes(join(root, '.agents/skills/orchestrator/SKILL.md')));
      assert.ok(result.additionalContext.includes(join(root, '.codex/internal-skills/workflow-compose/GUIDE.md')));
      assert.ok(result.additionalContext.includes('"decision_hint":"compose_candidate"'));
      const child = spawnSync(own.command, { shell: true, cwd: root, input: JSON.stringify({ ...event, agent_id: 'child' }), encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, '');
      await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  low_performance_model: fixture-model\n  low_performance_reasoning_effort: low\n');
      const executionId = initialize ? 'exec-fresh' : 'exec-update';
      const execSession = sessionDirectory(root);
      const execInput = { schema_version: 1, execution_id: executionId, skill: 'beads', workspace_root: root, shared_guidance_root: root, session_directory: execSession, scope: 'Fixture structured dispatch', input_refs: [], context: { codex_session_id: 'fixture-session', stage_id: 'fixture-task' } };
      const inputPath = `runtime/executions/${executionId}/input.json`;
      await writeFile(sessionOutputPath(root, inputPath), JSON.stringify(execInput));
      const fakeBin = sessionOutputPath(root, 'tmp/fake-bin/codex');
      await writeFile(fakeBin, `#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2);const output=args[args.indexOf('--output-last-message')+1];
if(!args.includes('--output-schema')||args[args.indexOf('--model')+1]!=='fixture-model'||!process.env.HARNESS_SKILL_EXECUTION_ID)process.exit(9);
if(!args.some((arg,index)=>arg==='--add-dir'&&args[index+1]===path.join(process.cwd(),'.beads')))process.exit(12);
const prompt=fs.readFileSync(0,'utf8');const session=process.env.HARNESS_SESSION_DIR;
const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
if(schema.properties.execution_id.const!==process.env.HARNESS_SKILL_EXECUTION_ID||schema.properties.skill.const!=='beads'||schema.properties.result_ref.enum[0]!=='runtime/executions/'+process.env.HARNESS_SKILL_EXECUTION_ID+'/result.json')process.exit(11);
if(!session||!prompt.includes(path.join(session,'runtime/executions',process.env.HARNESS_SKILL_EXECUTION_ID,'result.json'))||!prompt.includes('not the workspace cwd'))process.exit(10);
const id=process.env.HARNESS_SKILL_EXECUTION_ID;const e={schema_version:1,execution_id:id,skill:'beads',status:'completed',code:'OK',result_ref:'runtime/executions/'+id+'/result.json'};
const {result_ref,...fields}=e;fs.writeFileSync(path.join(path.dirname(output),'result.json'),JSON.stringify({...fields,summary:'Fixture',artifacts:[],details:{}}));
fs.writeFileSync(output,JSON.stringify(e));
`, { mode: 0o700 });
      const executed = spawnSync('node', ['.codex/scripts/harness-skill-exec.mjs', '--root', root, '--session-directory', execSession, '--input', inputPath], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: join(execSession, 'tmp/fake-bin') + ':' + process.env.PATH } });
      assert.equal(executed.status, 0, executed.stderr);
      assert.equal(JSON.parse(executed.stdout).status, 'completed');
      const recorded = JSON.parse(await readFile(join(execSession, 'runtime/orchestrator/state.json'), 'utf8'));
      assert.equal(recorded.stages['fixture-task'].status, 'completed');
      assert.equal(recorded.status, 'waiting');
      await rm(join(execSession, 'runtime/orchestrator/state.json'));
      const duplicate = spawnSync('node', ['.codex/scripts/harness-skill-exec.mjs', '--root', root, '--session-directory', execSession, '--input', inputPath], { cwd: root, encoding: 'utf8' });
      assert.notEqual(duplicate.status, 0);
      const composed = { schema_version: 1, workflow_id: 'stage-dispatch', scope: 'Fixture', stages: [{ id: 'task', skill: 'beads', role: 'default', scope: 'Generated input scope', needs: [], conditions: [], gates: [], inputs: [{ base: 'workspace', path: 'app.txt' }], outputs: [] }] };
      await writeFile(sessionOutputPath(root, 'runtime/orchestrator/workflow.json'), JSON.stringify(composed));
      await writeFile(sessionOutputPath(root, 'runtime/orchestrator/state.json'), JSON.stringify({ schema_version: 1, codex_session_id: 'fixture-session', workflow_ref: 'runtime/orchestrator/workflow.json', status: 'waiting', stages: {} }));
      const selected = spawnSync('node', ['.codex/scripts/harness-skill-exec.mjs', '--root', root, '--session-directory', execSession, '--request-workflow', 'runtime/orchestrator/workflow.json', '--stage', 'task', '--codex-session-id', 'fixture-session'], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: join(execSession, 'tmp/fake-bin') + ':' + process.env.PATH } });
      assert.equal(selected.status, 0, selected.stderr);
      const selectedReturn = JSON.parse(selected.stdout);
      const generated = JSON.parse(await readFile(join(execSession, 'runtime/executions', selectedReturn.execution_id, 'input.json'), 'utf8'));
      assert.equal(generated.scope, 'Generated input scope');
      assert.deepEqual(generated.input_refs, [{ base: 'workspace', path: 'app.txt' }]);
      assert.equal(generated.context.stage_id, 'task');
      assert.equal(JSON.parse(await readFile(join(execSession, 'runtime/orchestrator/progress.json'), 'utf8')).completion_percent, 100);
      const statePath = sessionOutputPath(root, 'runtime/orchestrator/state.json');
      await writeFile(sessionOutputPath(root, 'runtime/orchestrator/workflow.json'), JSON.stringify({ schema_version: 1, workflow_id: 'test', stages: [{ id: 'spec' }, { id: 'review', needs: ['spec'] }] }));
      const state = { schema_version: 1, codex_session_id: 'fixture-session', status: 'blocked', current_stage: 'review', workflow_ref: 'runtime/orchestrator/workflow.json', stages: { spec: { status: 'completed', execution_id: 'spec-1', result_ref: 'runtime/spec/result.json' }, review: { status: 'blocked', reason: 'User decision required' } } };
      await writeFile(statePath, JSON.stringify(state));
      for (const hookEvent of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
        const handler = hooks.hooks[hookEvent].flatMap((group) => group.hooks).find((hook) => hook.command.includes('harness-orchestrator-hook'));
        const invoked = spawnSync(handler.command, { shell: true, cwd: root, input: JSON.stringify({ ...event, hook_event_name: hookEvent }), encoding: 'utf8' });
        assert.equal(invoked.status, 0, invoked.stderr);
        const progress = JSON.parse(await readFile(sessionOutputPath(root, 'runtime/orchestrator/progress.json'), 'utf8'));
        assert.equal(progress.completion_percent, 50);
        assert.equal(progress.counts.blocked, 1);
        assert.equal(progress.stages[1].reason, 'User decision required');
        assert.equal(progress.observed_event, hookEvent);
        assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), state);
      }
      const progressPath = sessionOutputPath(root, 'runtime/orchestrator/progress.json');
      const previous = await readFile(progressPath, 'utf8');
      const foreign = spawnSync(own.command, { shell: true, cwd: root, input: JSON.stringify({ ...event, session_id: 'another-session' }), encoding: 'utf8' });
      assert.equal(foreign.status, 0, foreign.stderr);
      assert.equal(await readFile(progressPath, 'utf8'), previous);
      state.stages.spec = { status: 'running', execution_id: 'spec-2' };
      await writeFile(statePath, JSON.stringify(state));
      const retry = spawnSync(own.command, { shell: true, cwd: root, input: JSON.stringify(event), encoding: 'utf8' });
      assert.equal(retry.status, 0, retry.stderr);
      const retryProgress = JSON.parse(await readFile(progressPath, 'utf8'));
      assert.equal(retryProgress.completion_percent, 0);
      assert.equal(retryProgress.stages[0].execution_id, 'spec-2');
      await rm(statePath);
      await rm(sessionOutputPath(root, 'runtime/orchestrator/workflow.json'));
      const status = git('status', '--short', '--untracked-files=all');
      assert.ok(status.includes('app.txt'));
      assert.ok(!status.includes('.codex/'));
      assert.ok(!status.includes('.agents/'));
      assert.equal(spawnSync('git', ['check-ignore', '-v', '.codex/hooks.json'], { cwd: root }).status, 0);
      const doctor = await runDoctor({ root, sourceRoot: SOURCE });
      assert.ok(!doctor.diagnostics.some((item) => item.code.startsWith('orchestrator_hook')));
    }
    const stable = await readFile(join(root, '.codex/hooks.json'), 'utf8');
    await updateProject({ sourceRoot: SOURCE, targetRoot: root });
    assert.equal(await readFile(join(root, '.codex/hooks.json'), 'utf8'), stable);
    await writeFile(join(root, '.codex/hooks.json'), JSON.stringify(old));
    const broken = await runDoctor({ root, sourceRoot: SOURCE });
    assert.ok(broken.diagnostics.some((item) => item.code === 'orchestrator_hook_missing'));
    await updateProject({ sourceRoot: SOURCE, targetRoot: root });
    assert.equal((await inspectOrchestratorHook(root)).valid, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function worktreeFixture() {
  const root = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), 'hook-state-'));
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial');
  return { root, git, tree: join(root, 'worker') };
}

test('startup inspection is read-only and an unmanaged linked worktree is not treated as a fresh primary workspace', async () => {
  const { root, git, tree } = await worktreeFixture();
  try {
    const empty = await inspectStartupState({ workspaceRoot: root, codexSessionId: 'session-a' });
    assert.equal(empty.decision_hint, 'compose_candidate');
    await assert.rejects(readFile(join(root, '.git/harness-workflows/sessions')), { code: 'ENOENT' });
    const pendingPath = sessionOutputPath(root, 'runtime/orchestrator/state.json');
    await writeFile(pendingPath, JSON.stringify({ schema_version: 1, codex_session_id: 'session-a', status: 'running', current_stage: 'workflow-compose', workflow_ref: null }));
    const pending = await inspectStartupState({ workspaceRoot: root, codexSessionId: 'session-a' });
    assert.equal(pending.decision_hint, 'resume_candidate');
    assert.equal(pending.matching_workflows[0].composition_pending, true);
    await rm(pendingPath);
    await writeFile(sessionOutputPath(root, 'runtime/orchestrator/workflow.json'), JSON.stringify({ schema_version: 1, stages: [{ id: 'spec' }] }));
    assert.equal((await inspectStartupState({ workspaceRoot: root, codexSessionId: 'session-a' })).decision_hint, 'inspect_required');
    git('worktree', 'add', '-qb', 'worker', tree);
    const unmanaged = await inspectStartupState({ workspaceRoot: tree, codexSessionId: 'session-a' });
    assert.equal(unmanaged.git.current_registered, true);
    assert.equal(unmanaged.git.is_primary, false);
    assert.equal(unmanaged.decision_hint, 'inspect_required');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('startup inspection correlates the same Codex session, canonical ownership and actual Git registration', async () => {
  const { root, git, tree } = await worktreeFixture();
  try {
    git('worktree', 'add', '-qb', 'worker', tree);
    await registerWorkflowWorktree({ workspace_root: tree, return_root: root });
    const recordPath = join(sessionDirectory(tree), 'worktree.json');
    const recordBefore = await readFile(recordPath, 'utf8');
    let observed = await inspectStartupState({ workspaceRoot: tree, codexSessionId: 'session-a' });
    assert.equal(observed.worktrees[0].status, 'verified_active');
    assert.equal(observed.decision_hint, 'inspect_required');
    const statePath = sessionOutputPath(tree, 'runtime/orchestrator/state.json');
    const workflowPath = sessionOutputPath(tree, 'runtime/orchestrator/workflow.json');
    await writeFile(workflowPath, JSON.stringify({ schema_version: 1, stages: [{ id: 'spec', skill: 'spec-me' }] }));
    const state = { schema_version: 1, codex_session_id: 'session-a', status: 'running', current_stage: 'spec', workflow_ref: 'runtime/orchestrator/workflow.json' };
    await writeFile(statePath, JSON.stringify(state));
    observed = await inspectStartupState({ workspaceRoot: root, codexSessionId: 'session-a' });
    assert.equal(observed.decision_hint, 'resume_candidate');
    assert.equal(observed.matching_workflows[0].path, statePath);
    const foreign = await inspectStartupState({ workspaceRoot: tree, codexSessionId: 'session-b' });
    assert.equal(foreign.matching_workflows.length, 0);
    assert.equal(foreign.current_workspace_has_other_session_state, true);
    assert.equal(foreign.decision_hint, 'inspect_required');
    assert.equal(await readFile(recordPath, 'utf8'), recordBefore);
    assert.equal(await readFile(statePath, 'utf8'), JSON.stringify(state));
    git('-C', tree, 'branch', '-m', 'renamed-worker');
    observed = await inspectStartupState({ workspaceRoot: root, codexSessionId: 'session-a' });
    assert.equal(observed.worktrees[0].branch_matches, false);
    assert.equal(observed.decision_hint, 'inspect_required');
    git('-C', tree, 'branch', '-m', 'worker');
    await writeFile(statePath, JSON.stringify({ ...state, status: 'completed' }));
    await finishWorkflowWorktree({ workspace_root: tree, repository_root: root, outcome: 'completed' });
    observed = await inspectStartupState({ workspaceRoot: root, codexSessionId: 'session-a' });
    assert.equal(observed.worktrees[0].status, 'closed');
    assert.equal(observed.decision_hint, 'compose_candidate');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing registered paths and corrupt state remain inspect-required without record migration', async () => {
  const { root, git, tree } = await worktreeFixture();
  try {
    git('worktree', 'add', '-qb', 'worker', tree);
    await registerWorkflowWorktree({ workspace_root: tree, return_root: root });
    const statePath = sessionOutputPath(tree, 'runtime/orchestrator/state.json');
    await writeFile(sessionOutputPath(tree, 'runtime/orchestrator/workflow.json'), JSON.stringify({ schema_version: 1, stages: [{ id: 'spec' }] }));
    await writeFile(statePath, JSON.stringify({ schema_version: 1, codex_session_id: 'a', status: 'running', workflow_ref: 'runtime/orchestrator/workflow.json' }));
    const recordPath = join(sessionDirectory(tree), 'worktree.json');
    const legacyPath = join(sessionDirectory(tree), 'receipt.json');
    await rename(recordPath, legacyPath);
    let observed = await inspectStartupState({ workspaceRoot: root, codexSessionId: 'a' });
    assert.equal(observed.decision_hint, 'inspect_required');
    assert.ok(observed.issues.some((issue) => issue.reason === 'legacy_worktree_record_requires_recovery'));
    await assert.rejects(readFile(recordPath), { code: 'ENOENT' });
    await rename(legacyPath, recordPath);
    await rm(tree, { recursive: true, force: true });
    observed = await inspectStartupState({ workspaceRoot: root, codexSessionId: 'a' });
    assert.equal(observed.worktrees[0].git_registered, true);
    assert.equal(observed.worktrees[0].path_exists, false);
    assert.equal(observed.decision_hint, 'inspect_required');
    await writeFile(statePath, '{broken');
    observed = await inspectStartupState({ workspaceRoot: root, codexSessionId: 'a' });
    assert.equal(observed.decision_hint, 'inspect_required');
    assert.equal(await readFile(statePath, 'utf8'), '{broken');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('installed worktree creation provisions ignored runtime and preserves application files', async () => {
  const { root, git } = await worktreeFixture();
  try {
    await protectLocalInstallArtifacts(root, SOURCE);
    await updateProject({ sourceRoot: SOURCE, targetRoot: root, initialize: true });
    await writeFile(join(root, 'app.txt'), 'Application baseline\n');
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'Project execution instructions\n');
    git('add', 'app.txt', 'docs', '.github');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'consumer baseline');
    const session = sessionDirectory(root);
    const input = { execution_id: 'composer-fixture', context: {} };
    const inputPath = 'runtime/executions/composer-fixture/input.json';
    await writeFile(sessionOutputPath(root, inputPath), JSON.stringify(input));
    const created = await prepareComposerWorkspace({ root, session, input, inputPath });
    assert.equal(JSON.parse(await readFile(join(session, inputPath), 'utf8')).context.worktree_ref, join(created.session_directory, 'worktree.json'));
    const reused = await prepareComposerWorkspace({ root, session, input, inputPath });
    assert.equal(reused.worktree_id, created.worktree_id);
    const run = (command, args) => spawnSync(command, args, { cwd: created.workspace, encoding: 'utf8' });
    assert.equal(await readFile(join(created.workspace, 'docs/agents/EXEC.md'), 'utf8'), 'Project execution instructions\n');
    const preflight = run('node', ['.codex/scripts/harness-workspace-preflight.mjs', '--workspace-root', created.workspace, '--json']);
    assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout);
    assert.equal(JSON.parse(preflight.stdout).valid, true);
    assert.equal((await inspectOrchestratorHook(created.workspace)).valid, true);
    const doctor = await runDoctor({ root: created.workspace, sourceRoot: SOURCE });
    assert.ok(!doctor.diagnostics.some((item) => item.code.startsWith('installer_') || item.code.startsWith('orchestrator_hook')), JSON.stringify(doctor.diagnostics));
    const nestedSession = sessionDirectory(created.workspace, { repositoryRoot: root });
    const nestedInputPath = 'runtime/executions/composer-nested/input.json';
    const nestedInput = { execution_id: 'composer-nested', shared_guidance_root: root, context: {} };
    await writeFile(sessionOutputPath(created.workspace, nestedInputPath), JSON.stringify(nestedInput));
    const nested = await prepareComposerWorkspace({ root: created.workspace, session: nestedSession, input: nestedInput, inputPath: nestedInputPath });
    assert.equal(nested.source_workspace, created.workspace);
    assert.equal(nested.return_root, root);
    await finishWorkflowWorktree({ workspace_root: nested.workspace, repository_root: root, worktree_id: nested.worktree_id, outcome: 'aborted' });
    await writeFile(join(created.workspace, 'app.txt'), 'Application change\n');
    await writeFile(join(created.workspace, 'docs/agents/EXEC.md'), 'Project-owned edit\n');
    const status = run('git', ['status', '--short', '--untracked-files=all']).stdout;
    assert.ok(status.includes('app.txt') && status.includes('docs/agents/EXEC.md'));
    assert.ok(!status.includes('.codex/') && !status.includes('.agents/'));
    assert.equal(run('git', ['check-ignore', '-v', '.codex/scripts/harness-workspace-preflight.mjs']).status, 0);
    assert.equal(run('git', ['check-ignore', '-v', 'docs/agents/EXEC.md']).status, 1);
    assert.equal(git('status', '--short'), '');
    await finishWorkflowWorktree({ workspace_root: created.workspace, repository_root: root, outcome: 'aborted' });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('execution lifecycle preserves retries and rejects foreign state owners', async () => {
  const { root } = await worktreeFixture();
  try {
    const session = sessionDirectory(root);
    const input = { execution_id: 'attempt-1', skill: 'beads', session_directory: session, context: { codex_session_id: 'owner', stage_id: 'check' } };
    const args = { root, input, binding: { model: 'fixture', reasoning_effort: 'low' } };
    await recordExecutionState({ ...args, status: 'running' });
    await recordExecutionState({ ...args, status: 'failed', code: 'EXECUTION_ERROR', reason: 'CLI failed' });
    input.execution_id = 'attempt-2';
    await recordExecutionState({ ...args, status: 'running' });
    await recordExecutionState({ ...args, status: 'completed', code: 'OK', result_ref: 'runtime/result.json' });
    const state = JSON.parse(await readFile(join(session, 'runtime/orchestrator/state.json'), 'utf8'));
    assert.equal(state.status, 'waiting');
    assert.equal(state.stages.check.status, 'completed');
    assert.equal(state.stages.check.attempts[0].reason, 'CLI failed');
    const progress = JSON.parse(await readFile(join(session, 'runtime/orchestrator/progress.json'), 'utf8'));
    assert.equal(progress.observed_event, 'SkillExecution');
    input.context.codex_session_id = 'foreign';
    await assert.rejects(recordExecutionState({ ...args, status: 'running' }), /ownership mismatch/);
    assert.deepEqual(JSON.parse(await readFile(join(session, 'runtime/orchestrator/state.json'), 'utf8')), state);
  } finally { await rm(root, { recursive: true, force: true }); }
});
