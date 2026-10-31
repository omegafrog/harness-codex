import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseWorktreeRecord } from '../src/workflow/worktrees.mjs';
import { recordExecutionState } from '../src/workflow/execution-state.mjs';
import { WORKTREE_STAGE } from '../src/workflow/worktree-stages.mjs';
import { findExecutionInput } from '../src/workflow/execution-input.mjs';
import { finishWorkflowWorktree, createWorkflowWorktree } from '../src/workflow/worktrees.mjs';
import { inspectStartupState } from '../src/workflow/startup-state.mjs';
import { updateProject } from '../src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../src/installer/local-exclude.mjs';
import { fileURLToPath } from 'node:url';

const record = {
  schema_version: 1,
  worktree_id: 'a77aaa03-329c-4d59-b4c5-269746a893f2',
  workspace: '/project/worktree',
  common: '/project/.git',
  return_root: '/project',
  session_directory: '/project/worktree/.io',
  branch: 'harness/worktree/example',
  state: 'active',
};
const parse = (value) => parseWorktreeRecord(JSON.stringify(value));

test('compose creates input only in the worktree and leaves main without .io', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'compose-location-contract-'));
  const root = join(parent, 'project');
  let tree;
  try {
    await mkdir(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Contract', '-c', 'user.email=contract@example.test', 'commit', '--allow-empty', '-m', 'Initial');
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    await writeFile(join(root, 'application.txt'), 'Application-owned content');
    git('add', 'application.txt');
    git('-c', 'user.name=Contract', '-c', 'user.email=contract@example.test', 'commit', '-m', 'Application');
    tree = JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-compose-workspace.mjs'), '--root', root, '--plan-set-id', 'calculator-web-app', '--request', '작은 계산기 웹 앱', '--execution-id', 'compose-1', '--codex-session-id', record.worktree_id], { cwd: root, encoding: 'utf8' }));
    const observation = await inspectStartupState({ workspaceRoot: root, codexSessionId: record.worktree_id });
    assert.equal(observation.decision_hint, 'inspect_required');
    assert.ok(observation.issues.some((item) => item.reason === 'active_worktree_without_workflow_state'));
    const found = await findExecutionInput(tree.workspace, 'compose-1');
    assert.equal(found.workspace, tree.workspace);
    assert.equal(found.input.workspace_root, tree.workspace);
    assert.equal(found.input.session_directory, tree.session_directory);
    assert.equal(found.input.context.codex_session_id, record.worktree_id);
    assert.equal(found.input.scope, '작은 계산기 웹 앱');
    assert.equal(found.input.context.control_session_directory, undefined);
    assert.deepEqual(found.input.input_refs, []);
    await assert.rejects(readFile(join(root, '.io', 'runtime', 'orchestrator', 'workflow.json')), { code: 'ENOENT' });
    const { lstat } = await import('node:fs/promises');
    await assert.rejects(lstat(join(root, '.io')), { code: 'ENOENT' });
    await writeFile(join(tree.workspace, 'application.txt'), 'Visible application change');
    const status = execFileSync('git', ['status', '--short'], { cwd: tree.workspace, encoding: 'utf8' });
    assert.match(status, /application.txt/);
    assert.doesNotMatch(status, /\.io|\.codex|\.agents/);
    execFileSync('git', ['check-ignore', '-v', '.io/worktree.json'], { cwd: tree.workspace });
  } finally {
    if (tree) await finishWorkflowWorktree({ workspace_root: tree.workspace, repository_root: root });
    await rm(parent, { recursive: true, force: true });
  }
});

test('stage enum defines allowed skill values', () => {
  assert.equal(WORKTREE_STAGE.WORKFLOW_COMPOSE, 'workflow-compose');
  assert.equal(WORKTREE_STAGE.SPEC_ME, 'spec-me');
  assert.throws(() => parse({ ...record, current_stage: 'unknown' }), /Invalid worktree current_stage/);
});

test('worktree record accepts lifecycle states and defaults source workspace', () => {
  for (const state of ['allocating', 'active', 'archived', 'removed', 'cleanup-failed']) {
    assert.equal(parse({ ...record, state }).source_workspace, record.return_root);
  }
  assert.equal(parse({ ...record, plan_set_id: 'calculator-web-app' }).plan_set_id, 'calculator-web-app');
  assert.throws(() => parse({ ...record, state: 'created' }), /Invalid worktree/);
  assert.throws(() => parse({ ...record, plan_set_id: '../outside' }), /Invalid plan_set_id/);
  assert.throws(() => parse({ ...record, workspace: 'relative' }), /Invalid worktree/);
  assert.equal(parse({ ...record, current_stage: 'workflow-compose' }).current_stage, 'workflow-compose');
  assert.throws(() => parse({ ...record, current_stage: '../spec' }), /Invalid worktree current_stage/);
});

test('worktree record validates agent session identifiers', () => {
  const agent_sessions = { 'stage:spec': { session_id: record.worktree_id, execution_id: 'spec-1' } };
  assert.deepEqual(parse({ ...record, agent_sessions }).agent_sessions, agent_sessions);
  assert.throws(() => parse({ ...record, agent_sessions: { 'stage:spec': { session_id: 'bad', execution_id: 'spec-1' } } }), /Invalid worktree agent session/);
});

test('workflow completion verifies result and immutable state, then supports idle recomposition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-contract-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    const assets = [
      '.codex/internal-skills/skill-execution/bindings.json',
      '.codex/internal-skills/skill-execution/schemas/input.schema.json',
      '.codex/internal-skills/skill-execution/schemas/return.schema.json',
      '.codex/internal-skills/skill-execution/schemas/workflow-compose-result.schema.json',
      '.codex/internal-skills/workflow-compose/schemas/workflow.schema.json',
      '.codex/skills/spec-me/SKILL.md',
    ];
    const source = fileURLToPath(new URL('../', import.meta.url));
    for (const asset of assets) {
      await mkdir(dirname(join(root, asset)), { recursive: true });
      await copyFile(join(source, asset), join(root, asset));
    }
    const session = join(root, '.io');
    const directory = join(session, 'runtime', 'orchestrator');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'workflow.json');
    const binding = { model: 'example', reasoning_effort: 'low' };
    const stage = { id: 'spec', skill: 'spec-me', role: 'default', scope: 'Write spec', needs: [], conditions: [], gates: [], inputs: [], outputs: [] };
    const workflowDefinition = (state) => ({ schema_version: 1, workflow_id: 'example', scope: 'Example', stages: [stage], state });
    const makeInput = (execution_id, recompose = false) => ({
      schema_version: 1, skill: 'workflow-compose', execution_id, workspace_root: root, shared_guidance_root: root,
      session_directory: session, scope: 'Example', input_refs: [], context: { stage_id: 'workflow-compose', ...(recompose ? { recompose: true } : {}) },
    });
    const complete = async (input, options = {}) => {
      const result_ref = `runtime/executions/${input.execution_id}/result.json`;
      const artifact = { base: 'session', path: 'runtime/orchestrator/workflow.json', kind: 'request_workflow', sha256: options.badHash ? 'a'.repeat(64) : null };
      const result = { schema_version: 1, execution_id: input.execution_id, skill: input.skill, status: 'completed', code: 'OK', summary: 'Composed', artifacts: [artifact], worktree_ref: null, question: null };
      const envelope = { schema_version: 1, execution_id: input.execution_id, skill: input.skill, status: 'completed', code: 'OK', result_ref, result };
      await mkdir(join(session, 'runtime/executions', input.execution_id), { recursive: true });
      await writeFile(join(session, result_ref), JSON.stringify(result));
      await writeFile(join(session, `runtime/executions/${input.execution_id}/return.json`), JSON.stringify(envelope));
      return recordExecutionState({ root, input, binding, status: 'completed', code: 'OK', result_ref });
    };
    const input = makeInput('compose-1');
    await recordExecutionState({ root, input, binding, status: 'running' });
    const running = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(running.state.current_stage, 'workflow-compose');
    const paused = await recordExecutionState({ root, input, binding, status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: 'runtime/executions/compose-1/result.json' });
    assert.equal(paused.workflow_status, 'waiting');
    const resumed = makeInput('compose-resumed');
    resumed.context.compose_resume = true;
    await recordExecutionState({ root, input: resumed, binding, status: 'running' });
    const continued = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(continued.state.stages['workflow-compose'].execution_id, 'compose-resumed');
    const tampered = workflowDefinition({ ...continued.state, codex_session_id: 'tampered' });
    await writeFile(path, JSON.stringify(tampered));
    await assert.rejects(complete(resumed), /Compose modified orchestrator state/);

    await writeFile(path, JSON.stringify(workflowDefinition(continued.state)));
    await complete(resumed);
    let workflow = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(workflow.state.status, 'created');
    assert.equal(workflow.state.current_stage, 'spec');
    await assert.rejects(readFile(join(directory, 'state.json')), { code: 'ENOENT' });

    const recompose = makeInput('compose-2', true);
    await recordExecutionState({ root, input: recompose, binding, status: 'running' });
    workflow = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(workflow.state.status, 'running');
    await writeFile(path, JSON.stringify(workflowDefinition(workflow.state)));
    await complete(recompose);
    workflow = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(workflow.state.status, 'created');
    assert.equal(workflow.state.current_stage, 'spec');
    assert.equal(workflow.state.stages['workflow-compose'].execution_id, 'compose-2');

    const bad = { ...input, skill: 'spec-me', execution_id: 'bad-1', context: { stage_id: 'unknown', workflow_ref: 'runtime/orchestrator/workflow.json' } };
    await assert.rejects(recordExecutionState({ root, input: bad, binding, status: 'running' }), /Current stage is not in the workflow/);
    const child = { ...bad, execution_id: 'child-1', context: { ...bad.context, stage_id: 'child-1', parent_stage_id: 'spec' } };
    await recordExecutionState({ root, input: child, binding, status: 'running' });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).state.current_stage, 'spec');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing main branch is rejected before worktree allocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-preflight-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'develop', root]);
    execFileSync('git', ['-C', root, '-c', 'user.name=Contract', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'Initialize']);
    await assert.rejects(createWorkflowWorktree({ workspace_root: root, plan_set_id: 'example' }), /committed main branch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
