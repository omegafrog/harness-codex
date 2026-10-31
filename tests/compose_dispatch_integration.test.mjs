import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateProject } from '../src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../src/installer/local-exclude.mjs';
import { finishWorkflowWorktree } from '../src/workflow/worktrees.mjs';
import { inspectStartupState } from '../src/workflow/startup-state.mjs';

test('installed consumer CLI composes, validates, persists and resumes its first stage', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'compose-integrated-'));
  const root = join(parent, 'project');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const sessionId = 'a77aaa03-329c-4d59-b4c5-269746a893f2';
  let tree;
  try {
    await mkdir(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Contract', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'Initial');
    await protectLocalInstallArtifacts(root, source);
    await updateProject({ sourceRoot: source, targetRoot: root, initialize: true });
    await copyFile(join(source, '.codex/harness.yaml'), join(root, '.codex/harness.yaml'));
    await writeFile(join(root, 'README.md'), 'Fixture repository');
    git('add', 'README.md');
    git('-c', 'user.name=Contract', '-c', 'user.email=test@example.test', 'commit', '-m', 'Fixture');

    const invoke = (cwd, script, ...args) => JSON.parse(execFileSync(process.execPath, [join(cwd, '.codex/scripts', script), ...args], { cwd, encoding: 'utf8' }));
    tree = invoke(root, 'harness-compose-workspace.mjs', '--root', root, '--plan-set-id', 'calculator', '--request', '간단한 계산기 웹 앱', '--execution-id', 'compose-1', '--codex-session-id', sessionId);
    const worktreeRef = join(tree.session_directory, 'worktree.json');
    const flowPath = join(tree.session_directory, 'runtime/orchestrator/workflow.json');

    const compose = async (executionId, request = '간단한 계산기 웹 앱') => {
      const rootArgs = ['--root', tree.workspace, '--worktree-ref', worktreeRef, '--execution-id', executionId];
      const schema = invoke(tree.workspace, 'harness-output-schema.mjs', ...rootArgs);
      assert.ok(schema.path.endsWith('/return.schema.json'));
      invoke(tree.workspace, 'harness-execution-state.mjs', ...rootArgs, '--status', 'running');
      const pending = JSON.parse(await readFile(flowPath, 'utf8'));
      assert.equal(pending.state.stages['workflow-compose'].status, 'running');

      const workflow = {
        schema_version: 1, workflow_id: 'fixture', scope: request,
        stages: [{ id: 'spec', skill: 'spec-me', role: 'default', scope: 'Write a calculator spec', needs: [], conditions: [], gates: [], inputs: [], outputs: [] }],
        state: pending.state,
      };
      await writeFile(flowPath, JSON.stringify(workflow, null, 2));
      const prefix = `runtime/executions/${executionId}`;
      const result = {
        schema_version: 1, execution_id: executionId, skill: 'workflow-compose', status: 'completed', code: 'OK',
        summary: 'Composed fixture workflow', artifacts: [
          { base: 'session', path: 'runtime/orchestrator/workflow.json', kind: 'request_workflow', sha256: null },
        ],
        worktree_ref: worktreeRef, question: null,
      };
      await mkdir(join(tree.session_directory, prefix), { recursive: true });
      await writeFile(join(tree.session_directory, prefix, 'return.json'), JSON.stringify({
        schema_version: 1, execution_id: executionId, skill: 'workflow-compose', status: 'completed', code: 'OK',
        result_ref: `${prefix}/result.json`, result,
      }));
      invoke(tree.workspace, 'harness-result.mjs', ...rootArgs, '--return', `${prefix}/return.json`);
      invoke(tree.workspace, 'harness-execution-state.mjs', ...rootArgs, '--status', 'completed', '--code', 'OK', '--result-ref', `${prefix}/result.json`);
      const complete = JSON.parse(await readFile(flowPath, 'utf8'));
      assert.equal(complete.state.current_stage, 'spec');
      assert.equal(complete.state.stages['workflow-compose'].status, 'completed');
    };

    const initialArgs = ['--root', tree.workspace, '--worktree-ref', worktreeRef, '--execution-id', 'compose-1'];
    invoke(tree.workspace, 'harness-execution-state.mjs', ...initialArgs, '--status', 'running');
    invoke(tree.workspace, 'harness-execution-state.mjs', ...initialArgs, '--status', 'failed', '--code', 'EXECUTION_ERROR', '--reason', 'Simulated interrupted initial worker');
    assert.equal((await inspectStartupState({ workspaceRoot: root, codexSessionId: sessionId })).decision_hint, 'resume_candidate');
    const recovered = invoke(tree.workspace, 'harness-compose-workspace.mjs',
      '--root', tree.workspace, '--worktree-ref', worktreeRef, '--continue-composition', 'true',
      '--plan-set-id', 'calculator', '--request', '간단한 계산기 웹 앱', '--execution-id', 'compose-recovered', '--codex-session-id', sessionId);
    assert.equal(recovered.workspace, tree.workspace);
    await compose('compose-recovered');

    // The original session may report the worktree but must not dispatch its first stage.
    const originalStartup = await inspectStartupState({ workspaceRoot: root, codexSessionId: sessionId });
    assert.equal(originalStartup.decision_hint, 'resume_candidate');
    assert.equal(originalStartup.handoff_required, true);
    assert.equal(originalStartup.handoff_workspace, tree.workspace);
    assert.equal((await inspectStartupState({ workspaceRoot: tree.workspace, codexSessionId: 'separate-worktree-session' })).handoff_required, false);
    const hook = (cwd) => JSON.parse(execFileSync(process.execPath, [join(cwd, '.codex/scripts/harness-orchestrator-hook.mjs')], {
      cwd, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd, session_id: sessionId }),
    })).hookSpecificOutput.additionalContext;
    const originalHook = hook(root);
    assert.match(originalHook, /handoff_required/);
    assert.match(originalHook, /Do not prepare or execute any downstream workflow stage/);
    const worktreeHook = hook(tree.workspace);
    assert.match(worktreeHook, /In the prepared worktree session only/);
    assert.throws(() => invoke(root, 'harness-prepare-input.mjs', '--worktree-ref', worktreeRef, '--workflow-ref', flowPath, '--stage-id', 'spec'),
      /Stage dispatch requires running from the prepared worktree/);

    // Only reopening the prepared worktree allows the orchestrator to resolve the next stage.
    const prepare = invoke(tree.workspace, 'harness-prepare-input.mjs', '--worktree-ref', worktreeRef, '--workflow-ref', flowPath, '--stage-id', 'spec');
    assert.equal(prepare.input.skill, 'spec-me');
    assert.equal(prepare.input.scope, 'Write a calculator spec');

    const updated = invoke(tree.workspace, 'harness-compose-workspace.mjs',
      '--root', tree.workspace, '--worktree-ref', worktreeRef, '--recompose', 'true',
      '--plan-set-id', 'calculator', '--request', '수정된 계산기 웹 앱', '--execution-id', 'compose-2', '--codex-session-id', sessionId);
    assert.equal(updated.workspace, tree.workspace);
    await compose('compose-2', '수정된 계산기 웹 앱');
    assert.equal((await inspectStartupState({ workspaceRoot: root, codexSessionId: sessionId })).decision_hint, 'resume_candidate');
  } finally {
    if (tree) await finishWorkflowWorktree({ workspace_root: tree.workspace, repository_root: root });
    await rm(parent, { recursive: true, force: true });
  }
});
