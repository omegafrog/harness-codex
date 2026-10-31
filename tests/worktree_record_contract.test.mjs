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

test('installed readiness checks required files without validating their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readiness-contract-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    const { inspectProjectReadiness } = await import(`file://${join(root, '.codex/harness-runtime/src/workflow/project-readiness.mjs')}`);
    assert.equal((await inspectProjectReadiness({ workspace_root: root })).status, 'blocked');
    for (const path of ['docs/agents/EXEC.md', 'docs/agents/execution.json', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/contracts/manifest.json', 'docs/contracts/architecture.html']) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), '');
    }
    assert.equal((await inspectProjectReadiness({ workspace_root: root })).status, 'pass');
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /docs\/agents\/EXEC.md/);
    assert.doesNotMatch(status, /\.codex|\.agents|\.harness/);
    execFileSync('git', ['check-ignore', '-v', '.codex/scripts/harness-setup.mjs'], { cwd: root });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed local tracker progresses split plans without Beads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-plan-contract-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    await writeFile(join(root, '.codex/harness.yaml'), 'tracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\nbeads:\n  enabled: false\n');
    await mkdir(join(root, 'docs/plans/calculator'), { recursive: true });
    await writeFile(join(root, 'docs/plans/calculator/calculator.md'), '---\nstatus: planned\n---\n# 계산기\n');
    const { syncTrackerStatus, readTrackerStatus } = await import(`file://${join(root, '.codex/harness-runtime/src/tracker/lifecycle.mjs')}`);
    const ticket_ref = 'docs/plans/calculator/calculator.md';
    assert.equal((await syncTrackerStatus({ workspace_root: root, ticket_ref, status: 'in-progress' })).status, 'pass');
    assert.equal((await readTrackerStatus({ workspace_root: root, ticket_ref })).canonical_status, 'in-progress');
    assert.match(execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }), /docs\/plans\/calculator\/calculator.md/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed compose creates an initial commit in an empty repository', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'compose-unborn-'));
  const root = join(parent, 'project');
  let tree;
  try {
    await mkdir(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Contract');
    git('config', 'user.email', 'contract@example.test');
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    tree = JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-compose-workspace.mjs'), '--root', root, '--plan-set-id', 'calculator', '--request', '계산기', '--execution-id', 'compose-1', '--codex-session-id', record.worktree_id], { cwd: root, encoding: 'utf8' }));
    const prepared = await findExecutionInput(tree.workspace, 'compose-1');
    const resultRef = 'runtime/executions/compose-1/result.json';
    await mkdir(join(tree.session_directory, 'runtime/executions/compose-1'), { recursive: true });
    await writeFile(join(tree.session_directory, resultRef), JSON.stringify({ worktree_ref: join(tree.session_directory, 'worktree.json') }));
    await recordExecutionState({ root: tree.workspace, input: prepared.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'completed', code: 'OK', result_ref: resultRef });
    const next = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'spec-me'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(next.input.skill, 'spec-me');
    assert.equal(next.input.context.role, undefined);
    const stageInput = await findExecutionInput(tree.workspace, next.input.execution_id);
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: `runtime/executions/${next.input.execution_id}/result.json` });
    const state = JSON.parse(await readFile(join(tree.session_directory, 'runtime/orchestrator/state.json'), 'utf8'));
    assert.equal(state.current_stage, 'spec-me');
    assert.equal(state.stages['spec-me'].status, 'waiting');
    const specResult = { schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: 'completed', code: 'OK', summary: '명세 준비 완료', artifacts: [], question: null, questions: [], required_subtasks: [], review_request: null };
    const specRef = `runtime/executions/${next.input.execution_id}/result.json`;
    await writeFile(join(tree.session_directory, specRef), JSON.stringify(specResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${next.input.execution_id}/return.json`), JSON.stringify({ schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: 'completed', code: 'OK', result_ref: specRef, result: specResult }));
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'completed', code: 'OK', result_ref: specRef });
    const plan = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'to-ticket'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(plan.input.context.transition.from_stage, 'spec-me');
    assert.equal(plan.input.context.transition.result_ref, specRef);
    const planInput = await findExecutionInput(tree.workspace, plan.input.execution_id);
    await recordExecutionState({ root: tree.workspace, input: planInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    const planRef = `runtime/executions/${plan.input.execution_id}/result.json`;
    const planResult = { schema_version: 1, execution_id: plan.input.execution_id, skill: 'to-ticket', status: 'action_required', code: 'SPEC_REVISION_REQUIRED', summary: '수용 조건 보완 필요', artifacts: [], question: null, questions: [], required_subtasks: [], review_request: null };
    await writeFile(join(tree.session_directory, planRef), JSON.stringify(planResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${plan.input.execution_id}/return.json`), JSON.stringify({ schema_version: 1, execution_id: plan.input.execution_id, skill: 'to-ticket', status: 'action_required', code: 'SPEC_REVISION_REQUIRED', result_ref: planRef, result: planResult }));
    await recordExecutionState({ root: tree.workspace, input: planInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'SPEC_REVISION_REQUIRED', result_ref: planRef });
    const revision = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'spec-me'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(revision.input.context.transition.code, 'SPEC_REVISION_REQUIRED');
    assert.equal(revision.input.context.transition.result_ref, planRef);
    const revisionInput = await findExecutionInput(tree.workspace, revision.input.execution_id);
    await recordExecutionState({ root: tree.workspace, input: revisionInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    const revisionRef = `runtime/executions/${revision.input.execution_id}/result.json`;
    const revisionResult = { schema_version: 1, execution_id: revision.input.execution_id, skill: 'spec-me', status: 'action_required', code: 'PLAN_REVISION_REQUIRED', summary: '계획 세분화 필요', artifacts: [], question: null, questions: [], required_subtasks: [], review_request: null };
    await writeFile(join(tree.session_directory, revisionRef), JSON.stringify(revisionResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${revision.input.execution_id}/return.json`), JSON.stringify({ schema_version: 1, execution_id: revision.input.execution_id, skill: 'spec-me', status: 'action_required', code: 'PLAN_REVISION_REQUIRED', result_ref: revisionRef, result: revisionResult }));
    await recordExecutionState({ root: tree.workspace, input: revisionInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'PLAN_REVISION_REQUIRED', result_ref: revisionRef });
    const replan = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'to-ticket'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(replan.input.context.transition.code, 'PLAN_REVISION_REQUIRED');
    assert.equal(replan.input.context.transition.result_ref, revisionRef);
    const replanInput = await findExecutionInput(tree.workspace, replan.input.execution_id);
    await recordExecutionState({ root: tree.workspace, input: replanInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    const question = { question_id: 'choice-1', question: '계획을 선택하세요', options: [{ id: 'a', label: 'A', consequence: 'A 적용' }, { id: 'b', label: 'B', consequence: 'B 적용' }], recommended_option_id: 'a', rationale: '테스트' };
    const waitingRef = `runtime/executions/${replan.input.execution_id}/result.json`;
    const waitingResult = { schema_version: 1, execution_id: replan.input.execution_id, skill: 'to-ticket', status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '사용자 선택 필요', artifacts: [], question, questions: [], required_subtasks: [], review_request: null };
    await writeFile(join(tree.session_directory, waitingRef), JSON.stringify(waitingResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${replan.input.execution_id}/return.json`), JSON.stringify({ schema_version: 1, execution_id: replan.input.execution_id, skill: 'to-ticket', status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: waitingRef, result: waitingResult }));
    await writeFile(join(tree.session_directory, `runtime/executions/${replan.input.execution_id}/exec.stderr.json`), JSON.stringify({ thread_id: record.worktree_id }));
    await recordExecutionState({ root: tree.workspace, input: replanInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: waitingRef });
    const resumed = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'to-ticket', '--answer', 'a'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(resumed.input.context.resume_session_id, record.worktree_id);
    assert.equal(resumed.answer.question_id, 'choice-1');
    await assert.rejects(readFile(join(tree.session_directory, 'runtime/orchestrator/workflow.json')), { code: 'ENOENT' });
    assert.equal(git('ls-tree', '-r', '--name-only', 'HEAD'), '');
    const status = git('status', '--short');
    assert.equal(status, '');
    git('check-ignore', '-v', '.codex/scripts/harness-compose-workspace.mjs');
  } finally {
    if (tree) await finishWorkflowWorktree({ workspace_root: tree.workspace, repository_root: root });
    await rm(parent, { recursive: true, force: true });
  }
});

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

test('workspace preparation records completion without selecting a workflow stage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-contract-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const session = join(root, '.io');
    const directory = join(session, 'runtime', 'orchestrator');
    await mkdir(directory, { recursive: true });
    const input = { skill: 'workflow-compose', execution_id: 'compose-1', session_directory: session, context: { stage_id: 'workflow-compose' } };
    await recordExecutionState({ root, input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'completed', code: 'OK' });
    const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    assert.equal(state.status, 'created');
    assert.equal(state.current_stage, 'workflow-compose');
    assert.equal(state.workflow_ref, null);
    await assert.rejects(readFile(join(directory, 'workflow.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
