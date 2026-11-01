import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorktreeRecord } from '../src/workflow/worktrees.mjs';
import { recordExecutionState, processIdentity } from '../src/workflow/execution-state.mjs';
import { WORKTREE_STAGE } from '../src/workflow/worktree-stages.mjs';
import { findExecutionInput, writeExecutionInput } from '../src/workflow/execution-input.mjs';
import { readExecutionInput } from '../src/workflow/skill-execution.mjs';
import { finishWorkflowWorktree } from '../src/workflow/worktrees.mjs';
import { updateProject } from '../src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../src/installer/local-exclude.mjs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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

async function seedSetup(root) {
  await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  low_performance_model: example\n  low_performance_reasoning_effort: medium\n  high_performance_model: example\n  high_performance_reasoning_effort: medium\n');
  await writeFile(join(root, '.codex/context-budget.json'), '{"schema_version":1,"context_window_tokens":1000,"max_plan_tokens":600,"handoff_reserve_tokens":200}\n');
  for (const path of ['docs/agents/EXEC.md', 'docs/agents/execution.json', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/contracts/manifest.json', 'docs/contracts/architecture.html']) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), '');
  }
}

test('startup identifies a new workspace before Git initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'startup-new-'));
  try {
    for (const path of ['.codex/skills/orchestrator/SKILL.md', '.codex/internal-skills/workflow-compose/GUIDE.md']) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), '');
    }
    const hook = fileURLToPath(new URL('../.codex/scripts/harness-orchestrator-hook.mjs', import.meta.url));
    const result = JSON.parse(execFileSync(process.execPath, [hook], { cwd: root, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: record.worktree_id }), encoding: 'utf8' }));
    assert.match(result.hookSpecificOutput.additionalContext, /setup_candidate/);
    await assert.rejects(readFile(join(root, '.git', 'HEAD')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed readiness checks required files without validating their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readiness-contract-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    const { inspectProjectReadiness } = await import(`file://${join(root, '.codex/harness-runtime/src/workflow/project-readiness.mjs')}`);
    const { writeOutputSchema } = await import(`file://${join(root, '.codex/harness-runtime/src/workflow/output-schema.mjs')}`);
    const { evaluateWorkflowCondition } = await import(`file://${join(root, '.codex/harness-runtime/src/workflow/stage-gates.mjs')}`);
    const generatedSchemaPath = join(root, '.io', 'installed-schema.json');
    await writeOutputSchema({ root, input: { execution_id: 'installed-spec', skill: 'spec-me', context: { stage_id: 'spec-me' } }, prefix: 'runtime/executions/installed-spec', path: generatedSchemaPath });
    const generatedSchema = JSON.parse(await readFile(generatedSchemaPath, 'utf8'));
    assert.equal(Object.hasOwn(generatedSchema.properties.result.properties, 'question'), false);
    assert.ok(generatedSchema.properties.result.properties.questions);
    assert.ok(generatedSchema.properties.result.required.includes('questions'));
    assert.deepEqual(evaluateWorkflowCondition('product_diagram_required', { product_diagram_required: true }), { condition_id: 'product_diagram_required', applies: true });
    assert.deepEqual(evaluateWorkflowCondition('architecture_diagram_required', { architecture_diagram_required: false }), { condition_id: 'architecture_diagram_required', applies: false });
    const lockPath = join(root, '.codex/harness-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    for (const path of ['.codex/scripts/harness-static-call.mjs', '.codex/internal-skills/static-caller/GUIDE.md']) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), 'legacy managed asset');
      const hash = createHash('sha256').update('legacy managed asset').digest('hex');
      lock.files[path] = { installed_sha256: hash, upstream_sha256: hash, source_path: path };
    }
    await writeFile(lockPath, JSON.stringify(lock));
    const updated = await updateProject({ sourceRoot, targetRoot: root });
    for (const path of ['.codex/scripts/harness-static-call.mjs', '.codex/internal-skills/static-caller/GUIDE.md']) {
      await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' });
      assert.equal(await readFile(join(updated.backup_directory, path), 'utf8'), 'legacy managed asset');
    }
    await readFile(join(root, '.codex/scripts/harness-codex-run.mjs'));
    await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  low_performance_model: example\ntracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\n');
    const installedDoctor = JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-doctor.mjs'), '--project', root, '--json'], { cwd: root, encoding: 'utf8' }));
    assert.equal(installedDoctor.passed, true);
    assert.equal(installedDoctor.diagnostics.some((item) => item.code === 'installer_unlocked_file' && item.path.endsWith('/.codex/harness.yaml')), false);
    const { runDoctor } = await import('../src/doctor/doctor.mjs');
    const doctor = await runDoctor({ root, sourceRoot });
    assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
    assert.equal((await inspectProjectReadiness({ workspace_root: root })).status, 'blocked');
    for (const path of ['docs/agents/EXEC.md', 'docs/agents/execution.json', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/contracts/manifest.json', 'docs/contracts/architecture.html']) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), '');
    }
    assert.equal((await inspectProjectReadiness({ workspace_root: root })).status, 'pass');
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /docs\/agents\/EXEC.md/);
    assert.doesNotMatch(status, /\.codex|\.agents|\.harness/);
    const ignoredHarnessFile = execFileSync('git', ['check-ignore', '-v', '.codex/scripts/harness-setup.mjs'], { cwd: root, encoding: 'utf8' });
    assert.match(ignoredHarnessFile, /\.codex\/scripts\/harness-setup\.mjs/);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/application-change.js'), 'export const changed = true;\n');
    const visibleApplicationFile = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(visibleApplicationFile, /src\/application-change\.js/);
    assert.doesNotMatch(visibleApplicationFile, /\.codex\/scripts\/harness-setup\.mjs/);
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

test('compose rejects an unprepared project without leaving an active worktree', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'compose-unprepared-'));
  const root = join(parent, 'project');
  try {
    await mkdir(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Contract', '-c', 'user.email=contract@example.test', 'commit', '--allow-empty', '-m', 'Initial');
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await seedSetup(root);
    await rm(join(root, 'docs/agents/EXEC.md'));
    git('add', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs');
    git('-c', 'user.name=Contract', '-c', 'user.email=contract@example.test', 'commit', '-m', 'Incomplete setup');
    assert.throws(() => execFileSync(process.execPath, [join(root, '.codex/scripts/harness-compose-workspace.mjs'), '--root', root, '--plan-set-id', 'calculator', '--request', '계산기', '--execution-id', 'compose-1', '--codex-session-id', record.worktree_id], { cwd: root, stdio: 'pipe' }), /Command failed/);
    assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
    assert.equal(git('status', '--short'), '');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('installed compose uses the setup baseline and preserves workflow transitions', async () => {
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
    await seedSetup(root);
    git('add', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs');
    git('commit', '-m', 'setup baseline');
    tree = JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-compose-workspace.mjs'), '--root', root, '--plan-set-id', 'calculator', '--request', '계산기', '--execution-id', 'compose-1', '--codex-session-id', record.worktree_id], { cwd: root, encoding: 'utf8' }));
    const prepared = { input: await readExecutionInput({ root: tree.workspace, execution_id: 'compose-1' }) };
    const worktreeRecord = JSON.parse(await readFile(join(tree.session_directory, 'worktree.json'), 'utf8'));
    assert.equal(worktreeRecord.agent_sessions.orchestrator.session_id, record.worktree_id);
    const resultRef = 'runtime/executions/compose-1/result.json';
    assert.equal(tree.status, 'completed');
    assert.equal(JSON.parse(await readFile(join(tree.session_directory, resultRef), 'utf8')).worktree_ref, tree.worktree_ref);
    const hook = join(root, '.codex/scripts/harness-orchestrator-hook.mjs');
    const context = JSON.parse(execFileSync(process.execPath, [hook], { cwd: root, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: record.worktree_id }), encoding: 'utf8' })).hookSpecificOutput.additionalContext;
    assert.ok(context.includes('계산기'));
    assert.ok(context.includes(tree.worktree_ref));
    assert.ok(context.includes('worktree_candidates'));
    assert.match(await readFile(join(root, '.agents/skills/orchestrator/SKILL.md'), 'utf8'), /worktree_candidates/);
    await writeFile(join(root, 'application-change.txt'), 'preserved');
    assert.match(git('status', '--short'), /application-change\.txt/);
    assert.equal(await readFile(join(root, 'application-change.txt'), 'utf8'), 'preserved');
    await rm(join(root, 'application-change.txt'));
    const next = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'spec-me'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(next.input.skill, 'spec-me');
    assert.equal(next.input.context.role, undefined);
    const stageInput = await findExecutionInput(tree.workspace, next.input.execution_id);
    const resultDir = join(tree.session_directory, 'runtime/executions', next.input.execution_id);
    await mkdir(resultDir, { recursive: true });
    const resultRefForQuestion = `runtime/executions/${next.input.execution_id}/result.json`;
    const generatedSchema = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-output-schema.mjs'), '--root', tree.workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', next.input.execution_id], { cwd: tree.workspace, encoding: 'utf8' }));
    const schema = JSON.parse(await readFile(generatedSchema.path, 'utf8'));
    const subtaskSchema = schema.properties.result.properties.required_subtasks.items;
    assert.ok(subtaskSchema.properties.skill.enum.includes('product-spec'));
    assert.ok(subtaskSchema.properties.agent_profile.enum.includes('spec_document_writer'));
    assert.equal(subtaskSchema.properties.role, undefined);
    const questionResult = { schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '파일 정본', artifacts: [], question: { question_id: 'scope', question: '범위는?', options: [{ id: 'basic', label: '기본', consequence: '기본 계산' }, { id: 'scientific', label: '공학', consequence: '추가 계산' }], recommended_option_id: 'basic', rationale: '작은 범위' }, questions: [], required_subtasks: [], review_request: null };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(questionResult));
    const answerEnvelope = { schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: resultRefForQuestion, result: { ...questionResult, summary: '다르게 표현된 응답' } };
    await writeFile(join(resultDir, 'return.json'), JSON.stringify(answerEnvelope));
    const resultCommand = [join(tree.workspace, '.codex/scripts/harness-result.mjs'), '--root', tree.workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', next.input.execution_id, '--return', `runtime/executions/${next.input.execution_id}/return.json`];
    const validated = JSON.parse(execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(validated.result.summary, '파일 정본');
    assert.equal(validated.result.question, null);
    assert.equal(validated.result.questions.length, 1);
    assert.equal(validated.result.questions[0].question_id, `${next.input.execution_id}:1`);
    assert.deepEqual(validated.result, JSON.parse(await readFile(join(resultDir, 'result.json'), 'utf8')));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify({ ...answerEnvelope, status: 'completed', code: 'OK' }));
    assert.throws(() => execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, stdio: 'pipe' }));
    assert.deepEqual(JSON.parse(await readFile(join(resultDir, 'result.json'), 'utf8')), validated.result);
    const badSubtask = { ...questionResult, code: 'SUBTASK_REQUIRED', question: null, required_subtasks: [{ skill: 'spec_document_writer', agent_profile: 'product-spec', purpose: '작성' }] };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(badSubtask));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify({ ...answerEnvelope, code: 'SUBTASK_REQUIRED', result: badSubtask }));
    assert.throws(() => execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, stdio: 'pipe' }));
    const validSubtask = { ...badSubtask, artifacts: [{ base: 'workspace', path: 'docs/agents/EXEC.md', kind: 'guidance', sha256: null }], required_subtasks: [{ skill: 'product-spec', agent_profile: 'spec_document_writer', purpose: '작성' }] };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(validSubtask));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify({ ...answerEnvelope, code: 'SUBTASK_REQUIRED', result: validSubtask }));
    assert.equal(JSON.parse(execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, encoding: 'utf8' })).result.required_subtasks[0].agent_profile, 'spec_document_writer');
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'SUBTASK_REQUIRED', result_ref: resultRefForQuestion });
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--subtask', '0'], { cwd: tree.workspace, stdio: 'pipe' }));
    const { prepareStageInput } = await import('../src/workflow/stage-input.mjs');
    const child = await prepareStageInput({ root: tree.workspace, session: tree.session_directory, worktreeRef: tree.worktree_ref, workflowRef: null, stageId: 'spec-me', codexSessionId: record.worktree_id, subtask: '0' });
    assert.equal(child.input.context.agent_profile, 'spec_document_writer');
    assert.deepEqual(child.input.input_refs, validSubtask.artifacts);
    await writeFile(join(resultDir, 'exec.stderr.json'), JSON.stringify({ thread_id: record.worktree_id }));
    const childId = child.input.execution_id;
    const childInput = await readExecutionInput({ root: tree.workspace, execution_id: childId });
    const { recordWorkflowSession } = await import('../src/workflow/worktrees.mjs');
    await recordWorkflowSession({ workspace_root: tree.workspace, repository_root: root, key: childId, session_id: record.worktree_id, execution_id: childId });
    await recordExecutionState({ root: tree.workspace, input: childInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: childInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'failed', reason: 'Invalid return' });
    const childRepair = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--resume-subtask', childId, '--feedback', '필요한 입력을 blocked로 반환하세요'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(childRepair.input.context.resume_session_id, record.worktree_id);
    const repairedInput = await readExecutionInput({ root: tree.workspace, execution_id: childRepair.input.execution_id });
    const blockedRef = `runtime/executions/${repairedInput.execution_id}/result.json`;
    const blockedResult = { ...questionResult, execution_id: repairedInput.execution_id, skill: 'product-spec', status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', question: null, summary: '확정된 입력이 필요합니다.' };
    await writeFile(join(tree.session_directory, blockedRef), JSON.stringify(blockedResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${repairedInput.execution_id}/return.json`), JSON.stringify({ schema_version: 1, execution_id: repairedInput.execution_id, skill: 'product-spec', status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', result_ref: blockedRef, result: blockedResult }));
    await recordExecutionState({ root: tree.workspace, input: repairedInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: repairedInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', result_ref: blockedRef });
    const parentResume = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--subtask-result', repairedInput.execution_id], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(parentResume.input.context.subtask_result_ref, blockedRef);
    assert.equal(parentResume.input.context.resume_session_id, record.worktree_id);
    const resumedParentInput = await readExecutionInput({ root: tree.workspace, execution_id: parentResume.input.execution_id });
    const retriedResult = { ...validSubtask, execution_id: resumedParentInput.execution_id };
    const retriedRef = `runtime/executions/${resumedParentInput.execution_id}/result.json`;
    await writeFile(join(tree.session_directory, retriedRef), JSON.stringify(retriedResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${resumedParentInput.execution_id}/return.json`), JSON.stringify({ ...answerEnvelope, execution_id: resumedParentInput.execution_id, code: 'SUBTASK_REQUIRED', result_ref: retriedRef, result: retriedResult }));
    await recordExecutionState({ root: tree.workspace, input: resumedParentInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: resumedParentInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'SUBTASK_REQUIRED', result_ref: retriedRef });
    const nextChild = await prepareStageInput({ root: tree.workspace, session: tree.session_directory, worktreeRef: tree.worktree_ref, workflowRef: null, stageId: 'spec-me', codexSessionId: record.worktree_id, subtask: '0' });
    assert.equal(nextChild.input.context.agent_profile, 'spec_document_writer');
    const legacySubtask = { ...badSubtask, required_subtasks: [{ skill: 'spec_document_writer', role: 'product-spec', purpose: '작성' }] };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(legacySubtask));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify({ ...answerEnvelope, code: 'SUBTASK_REQUIRED', result: legacySubtask }));
    await writeFile(join(resultDir, 'exec.stderr.json'), JSON.stringify({ thread_id: record.worktree_id }));
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'SUBTASK_REQUIRED', result_ref: resultRefForQuestion });
    const repair = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--feedback', 'skill과 agent_profile을 수정하세요'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(repair.input.context.resume_session_id, record.worktree_id);
    assert.match(await readFile(join(tree.session_directory, 'runtime/executions', repair.input.execution_id, 'feedback.json'), 'utf8'), /agent_profile/);
    assert.deepEqual(JSON.parse(await readFile(join(resultDir, 'result.json'), 'utf8')), legacySubtask);
    const blockedStage = { ...questionResult, status: 'blocked', code: 'ENVIRONMENT_UNAVAILABLE', question: null, questions: [], required_subtasks: [] };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(blockedStage));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify({ ...answerEnvelope, status: 'blocked', code: 'ENVIRONMENT_UNAVAILABLE', result: blockedStage }));
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'blocked', code: 'ENVIRONMENT_UNAVAILABLE', result_ref: resultRefForQuestion });
    const unblocked = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--feedback', '누락된 자료를 준비했습니다'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(unblocked.input.context.resume_session_id, record.worktree_id);
    assert.equal(unblocked.input.context.previous_result_ref, resultRefForQuestion);
    const conflicting = { ...questionResult, questions: [{ ...questionResult.question, question: '다른 질문' }] };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(conflicting));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify(answerEnvelope));
    assert.throws(() => execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, stdio: 'pipe' }));
    await writeFile(join(resultDir, 'findings.md'), '검토 지적');
    const findings = { base: 'session', path: `runtime/executions/${next.input.execution_id}/findings.md`, kind: 'review_findings', sha256: null };
    const review = { ...questionResult, code: 'REVIEW_REQUIRED', artifacts: [findings] };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(review));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify({ ...answerEnvelope, code: 'REVIEW_REQUIRED', result: review }));
    const reviewed = JSON.parse(execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(reviewed.result.questions.length, 1);
    assert.deepEqual(reviewed.result.artifacts, [findings]);
    const multi = { ...questionResult, questions: [questionResult.question, { ...questionResult.question, question_id: 'input', question: '입력 방식은?' }] };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(multi));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify({ ...answerEnvelope, result: multi }));
    const normalized = JSON.parse(execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(normalized.result.questions.length, 2);
    await writeFile(join(resultDir, 'exec.stderr.json'), JSON.stringify({ thread_id: record.worktree_id }));
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: resultRefForQuestion });
    const prepare = [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me'];
    const earlierAnswers = [{ question_id: 'earlier:1', answer: 'prior' }];
    await writeFile(join(resultDir, 'answers.json'), JSON.stringify(earlierAnswers));
    const firstAnswer = JSON.stringify([{ question_id: `${next.input.execution_id}:1`, answer: 'basic' }]);
    const pending = JSON.parse(execFileSync(process.execPath, [...prepare, '--answer', firstAnswer], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(pending.waiting_for_answers, true);
    assert.throws(() => execFileSync(process.execPath, [...prepare, '--answer', JSON.stringify([{ question_id: 'stale', answer: 'basic' }])], { cwd: tree.workspace, stdio: 'pipe' }));
    const secondAnswer = JSON.stringify([{ question_id: `${next.input.execution_id}:2`, answer: 'basic' }]);
    const continued = JSON.parse(execFileSync(process.execPath, [...prepare, '--answer', secondAnswer], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(continued.input.context.resume_session_id, record.worktree_id);
    assert.equal(continued.answer.length, 2);
    assert.deepEqual(JSON.parse(await readFile(join(resultDir, 'answers.json'), 'utf8')), earlierAnswers);
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
    assert.match(git('ls-tree', '-r', '--name-only', 'HEAD'), /CONTEXT.md/);
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
    await seedSetup(root);
    await writeFile(join(root, 'application.txt'), 'Application-owned content');
    git('add', 'application.txt', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs');
    git('-c', 'user.name=Contract', '-c', 'user.email=contract@example.test', 'commit', '-m', 'Application');
    tree = JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-compose-workspace.mjs'), '--root', root, '--plan-set-id', 'calculator-web-app', '--request', '작은 계산기 웹 앱', '--execution-id', 'compose-1', '--codex-session-id', record.worktree_id], { cwd: root, encoding: 'utf8' }));
    const found = await findExecutionInput(tree.workspace, 'compose-1');
    assert.equal(found.workspace, tree.workspace);
    assert.equal(found.input.workspace_root, undefined);
    assert.equal(found.input.session_directory, undefined);
    assert.equal(found.input.context.codex_session_id, record.worktree_id);
    assert.equal(found.input.scope, '작은 계산기 웹 앱');
    assert.equal(found.input.context.control_session_directory, undefined);
    assert.deepEqual(found.input.input_refs, []);
    const { resolveSkillSession, validateSkillInput, validateSkillReturn } = await import(`file://${join(tree.workspace, '.codex/harness-runtime/src/workflow/skill-execution.mjs')}`);
    await validateSkillInput({ root: tree.workspace, input: found.input });
    await assert.rejects(validateSkillInput({ root: tree.workspace, input: { ...found.input, context: { worktree_ref: found.input.context.worktree_ref } } }), /required/);
    const foreign = join(parent, 'foreign');
    await mkdir(foreign);
    execFileSync('git', ['init', '-q', foreign]);
    await mkdir(join(foreign, '.io'));
    await assert.rejects(resolveSkillSession(tree.workspace, join(foreign, '.io')), /must share the workspace Git common directory/);
    const result = { schema_version: 1, execution_id: 'compose-1', skill: 'workflow-compose', status: 'completed', code: 'OK', summary: '준비 완료', artifacts: [], worktree_ref: join(tree.session_directory, 'worktree.json'), question: null };
    const envelope = { schema_version: 1, execution_id: 'compose-1', skill: 'workflow-compose', status: 'completed', code: 'OK', result_ref: 'runtime/executions/compose-1/result.json', result };
    assert.equal((await validateSkillReturn({ root: tree.workspace, input: found.input, envelope })).valid, true);
    const next = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', result.worktree_ref, '--stage-id', 'spec-me'], { cwd: tree.workspace, encoding: 'utf8' }));
    const runId = next.input.execution_id;
    const bin = join(parent, 'bin');
    await mkdir(bin);
    const fakeCodex = join(bin, 'codex');
    await writeFile(fakeCodex, '#!/usr/bin/env node\nconst fs=require("fs");const a=process.argv;const schema=a[a.indexOf("--output-schema")+1];if(!fs.existsSync(schema)||JSON.parse(fs.readFileSync(schema,"utf8")).properties.execution_id.const!==process.env.TEST_CODEX_EXECUTION_ID)process.exit(41);let p="";process.stdin.on("data",x=>p+=x);process.stdin.on("end",()=>{fs.writeFileSync(a[a.indexOf("--output-last-message")+1],process.env.TEST_CODEX_RETURN);fs.writeFileSync(process.env.TEST_CODEX_PROMPT,p);fs.writeFileSync(process.env.TEST_CODEX_ARGS,JSON.stringify(a));console.log(JSON.stringify({type:"thread.started",thread_id:process.env.TEST_CODEX_THREAD}));});\n');
    await chmod(fakeCodex, 0o755);
    const promptPath = join(tree.session_directory, 'runtime/executions', runId, 'test-prompt');
    const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_CODEX_RETURN: JSON.stringify(envelope), TEST_CODEX_PROMPT: promptPath, TEST_CODEX_ARGS: join(tree.session_directory, 'runtime/executions', runId, 'test-args'), TEST_CODEX_THREAD: record.worktree_id, TEST_CODEX_EXECUTION_ID: runId };
    const execution = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-codex-run.mjs'), '--worktree-ref', result.worktree_ref, '--execution-id', runId], { cwd: tree.workspace, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.equal(execution.code, 0);
    assert.equal(execution.threadId, record.worktree_id);
    assert.equal(execution.binding.model, 'example');
    const schemaPath = join(tree.session_directory, 'runtime/executions', runId, 'return.schema.json');
    assert.equal(JSON.parse(await readFile(schemaPath, 'utf8')).properties.execution_id.const, runId);
    assert.match(execFileSync('git', ['check-ignore', '-v', `.io/runtime/executions/${runId}/return.schema.json`], { cwd: tree.workspace, encoding: 'utf8' }), /\.io/);
    await writeFile(join(root, 'consumer-change.txt'), 'visible application change');
    const consumerStatus = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(consumerStatus, /consumer-change\.txt/);
    assert.doesNotMatch(consumerStatus, /\.io\/runtime\/executions/);
    const stageArgs = JSON.parse(await readFile(environment.TEST_CODEX_ARGS, 'utf8'));
    assert.equal(stageArgs[stageArgs.indexOf('--enable') + 1], 'multi_agent');
    const nested = { ...next.input, execution_id: 'nested-child', context: { ...next.input.context, parent_execution_id: runId } };
    await writeExecutionInput(tree.workspace, nested, tree.plan_set_id);
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-codex-run.mjs'), '--worktree-ref', result.worktree_ref, '--execution-id', 'nested-child'], { cwd: tree.workspace, env: environment, stdio: 'pipe' }));
    assert.equal(JSON.parse(await readFile(join(tree.session_directory, 'runtime/executions', runId, 'exec.stderr.json'), 'utf8')).thread_id, record.worktree_id);
    assert.match(await readFile(promptPath, 'utf8'), /spec-me\/SKILL.md/);
    const reviewer = { ...next.input, execution_id: 'spec-reviewer', context: { ...next.input.context, agent_profile: 'spec_adversarial_reviewer' } };
    await writeExecutionInput(tree.workspace, reviewer, tree.plan_set_id);
    environment.TEST_CODEX_EXECUTION_ID = 'spec-reviewer';
    execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-codex-run.mjs'), '--worktree-ref', result.worktree_ref, '--execution-id', 'spec-reviewer'], { cwd: tree.workspace, env: environment, stdio: 'pipe' });
    const args = JSON.parse(await readFile(environment.TEST_CODEX_ARGS, 'utf8'));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(args.includes('--add-dir'), false);
    assert.match(await readFile(promptPath, 'utf8'), /artifact_contents/);
    const reviewResult = { schema_version: 1, execution_id: 'spec-reviewer', skill: 'spec-me', status: 'completed', code: 'OK', summary: '검토 완료', artifacts: [], question: null, questions: [], required_subtasks: [], review_request: null, artifact_contents: [{ name: 'review.md', kind: 'architecture_review', content: '검토 내용' }] };
    await writeFile(join(tree.session_directory, 'runtime/executions/spec-reviewer/return.json'), JSON.stringify({ schema_version: 1, execution_id: 'spec-reviewer', skill: 'spec-me', status: 'completed', code: 'OK', result_ref: 'runtime/executions/spec-reviewer/result.json', result: reviewResult }));
    const reviewEnvelope = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-result.mjs'), '--root', tree.workspace, '--worktree-ref', result.worktree_ref, '--execution-id', 'spec-reviewer', '--return', 'runtime/executions/spec-reviewer/return.json'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(await readFile(join(tree.session_directory, reviewEnvelope.result.artifacts[0].path), 'utf8'), '검토 내용');
    assert.equal(reviewEnvelope.result.artifact_contents, undefined);
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-codex-run.mjs'), '--worktree-ref', result.worktree_ref, '--execution-id', 'compose-1'], { cwd: tree.workspace, env: environment, stdio: 'pipe' }));
    const resumed = { ...next.input, execution_id: 'spec-resume', context: { ...next.input.context, resume_session_id: record.worktree_id } };
    await writeExecutionInput(tree.workspace, resumed, tree.plan_set_id);
    const answersPath = join(tree.session_directory, 'runtime/executions/spec-resume/answers.json');
    await mkdir(join(tree.session_directory, 'runtime/executions/spec-resume'), { recursive: true });
    await writeFile(answersPath, '{"answer":"예"}');
    environment.TEST_CODEX_EXECUTION_ID = 'spec-resume';
    const resumedRun = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-codex-run.mjs'), '--worktree-ref', result.worktree_ref, '--execution-id', 'spec-resume'], { cwd: tree.workspace, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.equal(resumedRun.threadId, record.worktree_id);
    assert.match(await readFile(promptPath, 'utf8'), /answers\.json/);
    const interruptedInput = { ...next.input, execution_id: 'interrupted-parent' };
    await writeExecutionInput(tree.workspace, interruptedInput, tree.plan_set_id);
    const interruptedStoredInput = await readExecutionInput({ root: tree.workspace, execution_id: interruptedInput.execution_id });
    const runtime = `file://${join(tree.workspace, '.codex/harness-runtime/src/workflow')}`;
    const { recordExecutionState: recordInstalledState } = await import(`${runtime}/execution-state.mjs`);
    const { recordWorkflowSession: recordInstalledSession } = await import(`${runtime}/worktrees.mjs`);
    const liveIdentity = await processIdentity(process.pid);
    const deadIdentity = { ...liveIdentity, pid: 2147483647, start: 'not-this-process' };
    await recordInstalledState({ root: tree.workspace, input: interruptedStoredInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running', owner: deadIdentity, child: deadIdentity });
    await recordInstalledSession({ workspace_root: tree.workspace, repository_root: root, key: 'spec-me', session_id: record.worktree_id, execution_id: interruptedInput.execution_id });
    const interruptedResume = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', result.worktree_ref, '--stage-id', 'spec-me', '--feedback', 'Continue the interrupted parent stage'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(interruptedResume.input.context.resume_session_id, record.worktree_id);
    assert.equal(interruptedResume.input.context.previous_result_ref, undefined);
    assert.equal(JSON.parse(await readFile(join(tree.session_directory, 'runtime/executions', interruptedResume.input.execution_id, 'feedback.json'), 'utf8')).feedback, 'Continue the interrupted parent stage');
    const interruptedResumeInput = await readExecutionInput({ root: tree.workspace, execution_id: interruptedResume.input.execution_id });
    environment.TEST_CODEX_EXECUTION_ID = interruptedResume.input.execution_id;
    const resumedParentRun = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-codex-run.mjs'), '--worktree-ref', result.worktree_ref, '--execution-id', interruptedResume.input.execution_id], { cwd: tree.workspace, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.equal(resumedParentRun.threadId, record.worktree_id);
    const resumedParentArgs = JSON.parse(await readFile(environment.TEST_CODEX_ARGS, 'utf8'));
    assert.equal(resumedParentArgs[resumedParentArgs.indexOf('resume') + 1], record.worktree_id);
    assert.equal(resumedParentArgs[resumedParentArgs.indexOf('--enable') + 1], 'multi_agent');
    const ownerIdentity = await processIdentity(process.pid);
    await recordInstalledState({ root: tree.workspace, input: interruptedResumeInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running', owner: ownerIdentity, child: ownerIdentity });
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', result.worktree_ref, '--stage-id', 'spec-me', '--feedback', 'Do not dispatch a duplicate'], { cwd: tree.workspace, stdio: 'pipe' }), /Command failed/);
    await rm(join(tree.workspace, 'docs/agents/EXEC.md'));
    await assert.rejects(validateSkillReturn({ root: tree.workspace, input: found.input, envelope }), /Project preparation incomplete/);
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
