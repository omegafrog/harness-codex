import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorktreeRecord } from '../src/workflow/worktrees.mjs';
import { recordExecutionState } from '../src/workflow/execution-state.mjs';
import { WORKTREE_STAGE } from '../src/workflow/worktree-stages.mjs';
import { findExecutionInput } from '../src/workflow/execution-input.mjs';
import { finishWorkflowWorktree } from '../src/workflow/worktrees.mjs';
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

test('workflow composition records the initial stage in the workflow file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-contract-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const session = join(root, '.io');
    const directory = join(session, 'runtime', 'orchestrator');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'workflow.json');
    await writeFile(path, JSON.stringify({ schema_version: 1, workflow_id: 'example', scope: 'Example', stages: [{ id: 'spec', skill: 'spec-me' }] }));
    const input = { skill: 'workflow-compose', execution_id: 'compose-1', session_directory: session, context: { stage_id: 'workflow-compose' } };
    await recordExecutionState({ root, input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'completed', code: 'OK' });
    const workflow = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(workflow.state.status, 'created');
    assert.equal(workflow.state.current_stage, 'spec');
    await assert.rejects(readFile(join(directory, 'state.json')), { code: 'ENOENT' });
    const bad = { ...input, skill: 'spec-me', execution_id: 'bad-1', context: { stage_id: 'unknown', workflow_ref: 'runtime/orchestrator/workflow.json' } };
    await assert.rejects(recordExecutionState({ root, input: bad, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' }), /Current stage is not in the workflow/);
    const child = { ...bad, execution_id: 'child-1', context: { ...bad.context, stage_id: 'child-1', parent_stage_id: 'spec' } };
    await recordExecutionState({ root, input: child, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).state.current_stage, 'spec');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
