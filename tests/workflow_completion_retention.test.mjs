import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { snapshotSpecReview } from '../.harness/src/workflow/spec-review.mjs';
import { updateReviewAttempt } from '../.harness/src/workflow/review-attempts.mjs';
import { updatePlanReview } from '../.harness/src/workflow/plan-review.mjs';
import { writeExecutionInput } from '../.harness/src/workflow/execution-input.mjs';
import { createWorkflowWorktree, finishWorkflowWorktree } from '../.harness/src/workflow/worktrees.mjs';

test('installed to-ticket completion preserves its owned worktree and visible artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-completion-retention-'));
  let tree;
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Contract'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'contract@example.test'], { cwd: root });
    const files = {
      'CONTEXT.md': '# Context\n',
      'CONTEXT-MAP.md': '# Context map\n',
      'docs/agents/EXEC.md': '',
      'docs/agents/execution.json': '{}\n',
      'docs/contracts/product.md': '',
      'docs/contracts/architecture.md': '',
      'docs/contracts/manifest.json': '{}\n',
      'docs/contracts/architecture.html': '',
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    execFileSync('git', ['add', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs', '.harness/contracts.mjs'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'Consumer setup baseline'], { cwd: root });
    tree = await createWorkflowWorktree({ workspace_root: root, plan_set_id: 'calculator' });

    await writeFile(join(tree.workspace, '.codex/harness.yaml'), 'tracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\nbeads:\n  enabled: false\n');
    for (const path of ['docs/specs/calculator/request.md', 'docs/specs/calculator/product-spec.md', 'docs/specs/calculator/architecture-spec.md']) {
      await mkdir(join(tree.workspace, path, '..'), { recursive: true });
      await writeFile(join(tree.workspace, path), `# ${path}\n`);
    }
    await mkdir(join(tree.workspace, 'docs/plans/calculator'), { recursive: true });
    await writeFile(join(tree.workspace, 'docs/plans/calculator/plans.md'), '# Plan set\nProduct Spec: `docs/specs/calculator/product-spec.md`\nArchitecture Spec: `docs/specs/calculator/architecture-spec.md`\n');
    const ticket = 'docs/plans/calculator/calculator.md';
    await writeFile(join(tree.workspace, ticket), '---\nstatus: planned\n---\n# Calculator\n');

    const specInputs = await snapshotSpecReview({ root: tree.workspace, ticketId: 'calculator' });
    const specAttempt = await updateReviewAttempt({ root: tree.workspace, scope: 'spec-calculator-architecture', action: 'begin', inputs: specInputs });
    const specReview = { axis: 'architecture', ticket_id: 'calculator', reviewer_id: 'spec-reviewer', author_ids: ['spec-author'], fork_turns: 'none', verdict: 'pass', inputs: specInputs, findings: [] };
    await updateReviewAttempt({ root: tree.workspace, scope: 'spec-calculator-architecture', action: 'record', inputs: specInputs, attemptId: specAttempt.attempt_id, review: specReview });

    const { recordExecutionState } = await import(new URL(`file://${join(tree.workspace, '.harness/src/workflow/execution-state.mjs')}`));
    const statePath = join(tree.session_directory, 'runtime/orchestrator/state.json');
    for (const skill of ['workflow-compose', 'spec-me', 'to-ticket', 'tracker-publish']) {
      const input = { skill, execution_id: skill, session_directory: tree.session_directory, context: { worktree_ref: join(tree.session_directory, 'worktree.json') } };
      const binding = { model: 'example', reasoning_effort: 'low' };
      await recordExecutionState({ root: tree.workspace, input, binding, status: 'running' });
      if (skill === 'to-ticket') {
        await recordExecutionState({ root: tree.workspace, input, binding, status: 'action_required', code: 'REVIEW_REQUIRED' });
        const savedEnvironment = Object.fromEntries(['HARNESS_WORKSPACE_ROOT', 'HARNESS_SKILL_EXECUTION_ID'].map((key) => [key, process.env[key]]));
        try {
          process.env.HARNESS_WORKSPACE_ROOT = tree.workspace;
          process.env.HARNESS_SKILL_EXECUTION_ID = input.execution_id;
          const planAdmission = await updatePlanReview({ root: tree.workspace, planSetId: 'calculator', action: 'begin' });
          await updatePlanReview({ root: tree.workspace, planSetId: 'calculator', action: 'record', attemptId: planAdmission.attempt_id, review: { reviewer_id: 'plan-reviewer', author_ids: ['plan-author'], fork_turns: 'none', verdict: 'pass', inputs: planAdmission.inputs, findings: [] } });
        } finally {
          for (const [key, value] of Object.entries(savedEnvironment)) value === undefined ? delete process.env[key] : process.env[key] = value;
        }
        await recordExecutionState({ root: tree.workspace, input, binding, status: 'running' });
      }
      await recordExecutionState({ root: tree.workspace, input, binding, status: 'completed', code: 'OK' });
    }
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).status, 'waiting');

    const completionPath = execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-session-output.mjs'), '--root', tree.workspace, '--path', 'runtime/to-ticket/completion-state.json'], { cwd: tree.workspace, encoding: 'utf8' }).trim();
    await writeFile(completionPath, JSON.stringify({
      workspace_root: tree.workspace,
      ticket_id: 'calculator',
      plan_set_id: 'calculator',
      plan_review: { plan_set_id: 'calculator', phase: 'planning' },
      tracker_sync: { ticket_refs: [ticket] },
    }));
    const args = [join(tree.workspace, '.codex/scripts/harness-workflow-complete.mjs'), '--root', tree.workspace, '--workflow', 'to-ticket', '--worktree-id', tree.worktree_id, '--base-ref', tree.head, '--state', 'runtime/to-ticket/completion-state.json'];
    const intermediate = JSON.parse(execFileSync(process.execPath, args, { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(intermediate.state, 'completed');
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).status, 'waiting');
    const planBefore = await readFile(join(tree.workspace, ticket), 'utf8');
    await writeFile(join(tree.workspace, ticket), `${planBefore}\nChanged requirement\n`);
    assert.notEqual(spawnSync(process.execPath, [...args, '--final-workflow'], { cwd: tree.workspace }).status, 0);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).status, 'waiting');
    await writeFile(join(tree.workspace, ticket), planBefore);
    const completed = JSON.parse(execFileSync(process.execPath, [...args, '--final-workflow'], { cwd: tree.workspace, encoding: 'utf8' }));

    assert.equal(completed.state, 'completed', JSON.stringify(completed.verdict));
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).status, 'completed');
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).current_stage, 'tracker-publish');
    const progress = JSON.parse(await readFile(join(tree.session_directory, 'runtime/orchestrator/progress.json'), 'utf8'));
    assert.equal(progress.status, 'completed');
    assert.equal(progress.counts.completed, 4);
    execFileSync(process.execPath, [...args, '--final-workflow'], { cwd: tree.workspace });
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).status, 'completed');
    assert.deepEqual(completed.worktree_retained, { state: 'preserved', workspace_root: tree.workspace });
    assert.equal(JSON.parse(await readFile(join(tree.session_directory, 'worktree.json'), 'utf8')).state, 'active');
    assert.ok(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' }).includes(tree.workspace));
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: tree.workspace, encoding: 'utf8' });
    assert.match(status, /docs\/(plans|specs)\//);
    assert.doesNotMatch(status, /\.io\/|\.harness\/src\//);
    assert.match(execFileSync('git', ['check-ignore', '-v', '.io/runtime/orchestrator/state.json'], { cwd: tree.workspace, encoding: 'utf8' }), /\.io/);
    assert.equal(execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }), '');
    assert.match(await readFile(join(tree.workspace, ticket), 'utf8'), /# Calculator/);

    const specBeforeRestart = await readFile(join(tree.workspace, 'docs/specs/calculator/product-spec.md'));
    await writeFile(join(tree.workspace, 'application-owned.txt'), 'keep visible');
    const restartState = JSON.parse(await readFile(statePath, 'utf8'));
    delete restartState.stages['tracker-publish'];
    restartState.status = 'waiting';
    restartState.current_stage = 'to-ticket';
    restartState.stages['to-ticket'].status = 'waiting';
    restartState.stages['to-ticket'].result_ref = 'runtime/executions/to-ticket/result.json';
    restartState.stages['workflow-compose'].result_ref = 'runtime/executions/workflow-compose/result.json';
    await writeFile(statePath, JSON.stringify(restartState, null, 2));
    await writeExecutionInput(tree.workspace, { schema_version: 1, skill: 'workflow-compose', execution_id: 'workflow-compose', scope: 'test', input_refs: [], context: { worktree_ref: join(tree.session_directory, 'worktree.json') } }, 'calculator');
    await mkdir(join(tree.session_directory, 'runtime/executions/workflow-compose'), { recursive: true });
    await writeFile(join(tree.session_directory, 'runtime/executions/workflow-compose/result.json'), JSON.stringify({ worktree_ref: join(tree.session_directory, 'worktree.json') }));
    await mkdir(join(tree.session_directory, 'runtime/executions/to-ticket'), { recursive: true });
    await writeFile(join(tree.session_directory, 'runtime/executions/to-ticket/exec.stderr.json'), JSON.stringify({ exit_code: 0, session_id: tree.worktree_id }));
    const restart = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'to-ticket', '--restart', 'true'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(restart.input.skill, 'to-ticket');
    assert.equal(restart.input.context.transition, undefined);
    assert.equal(restart.input.context.resume_session_id, undefined);
    assert.equal(await readFile(join(tree.workspace, 'docs/specs/calculator/product-spec.md'), 'utf8'), specBeforeRestart.toString());
    const archives = await readdir(join(tree.session_directory, 'runtime/restarts'));
    assert.equal(archives.length, 1);
    assert.match(await readFile(join(tree.session_directory, 'runtime/restarts', archives[0], 'plans/plans.md'), 'utf8'), /# Plan set/);
    assert.match(await readFile(join(tree.session_directory, 'runtime/restarts', archives[0], 'restart.json'), 'utf8'), /"previous_execution_id": "to-ticket"/);
    await assert.rejects(readFile(join(tree.session_directory, 'runtime/reviews/plan-calculator.json')), { code: 'ENOENT' });
    assert.ok(await readFile(join(tree.session_directory, 'runtime/executions/to-ticket/exec.stderr.json')));
    const restartedStatus = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: tree.workspace, encoding: 'utf8' });
    assert.match(restartedStatus, /application-owned\.txt/);
    assert.doesNotMatch(restartedStatus, /\.io\/restarts/);
    assert.match(execFileSync('git', ['check-ignore', '-v', `runtime/restarts/${archives[0]}/plans/plans.md`], { cwd: tree.session_directory, encoding: 'utf8' }), /\.io/);
    const recovered = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'to-ticket', '--restart', 'true'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(recovered.input.execution_id, restart.input.execution_id);

    await mkdir(join(tree.workspace, 'docs/plans/calculator'), { recursive: true });
    for (const [path, content] of Object.entries({
      'docs/plans/calculator/plans.md': '# Replacement plans\nProduct Spec: `docs/specs/calculator/product-spec.md`\nArchitecture Spec: `docs/specs/calculator/architecture-spec.md`\n',
      'docs/plans/calculator/replacement.md': '# Replacement plan\n',
    })) await writeFile(join(tree.workspace, path), content);
    restartState.stages['to-ticket'] = { ...restartState.stages['to-ticket'], status: 'failed', execution_id: 'failed-to-ticket', code: 'EXECUTION_ERROR', result_ref: undefined };
    await writeFile(statePath, JSON.stringify(restartState, null, 2));
    await mkdir(join(tree.session_directory, 'runtime/executions/failed-to-ticket'), { recursive: true });
    await writeFile(join(tree.session_directory, 'runtime/executions/failed-to-ticket/exec.stderr.json'), JSON.stringify({ exit_code: 1, session_id: tree.worktree_id }));
    const failedRestart = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'to-ticket', '--restart', 'true'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.notEqual(failedRestart.input.execution_id, restart.input.execution_id);
    assert.deepEqual(failedRestart.input.input_refs, []);
    assert.equal(await readFile(join(tree.workspace, 'docs/specs/calculator/product-spec.md'), 'utf8'), specBeforeRestart.toString());
    assert.equal((await readdir(join(tree.session_directory, 'runtime/restarts'))).length, 2);
  } finally {
    if (tree) await finishWorkflowWorktree({ workspace_root: tree.workspace, repository_root: root, worktree_id: tree.worktree_id, outcome: 'aborted' });
    await rm(root, { recursive: true, force: true });
  }
});
