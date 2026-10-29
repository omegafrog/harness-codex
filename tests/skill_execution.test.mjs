import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveSkillBinding, validateSkillInput, validateSkillReturn, assessContextBudget, validateComposedWorkflow } from '../src/workflow/skill-execution.mjs';
import { sessionDirectory, sessionOutputPath } from '../src/workflow/session-output.mjs';

async function fixture() {
  const root = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), 'skill-execution-'));
  await cp(new URL('../.codex/internal-skills/skill-execution', import.meta.url), join(root, '.codex/internal-skills/skill-execution'), { recursive: true });
  await cp(new URL('../.codex/internal-skills/workflow-compose', import.meta.url), join(root, '.codex/internal-skills/workflow-compose'), { recursive: true });
  const config = 'agents:\n  high_performance_model: design-model\n  high_performance_reasoning_effort: high\n  implementation_model: code-model\n  implementation_reasoning_effort: medium\n  execution_model: run-model\n  execution_reasoning_effort: low\n  low_performance_model: writer-model\n  low_performance_reasoning_effort: low\n';
  await writeFile(join(root, '.codex/harness.yaml'), config);
  return { root, config };
}

test('composed workflows use real roles and producer references rather than nonexistent future input files', async () => {
  const { root } = await fixture();
  try {
    for (const name of ['product-spec', 'architecture-spec', 'spec-review']) { await mkdir(join(root, '.codex/internal-skills', name), { recursive: true }); await writeFile(join(root, '.codex/internal-skills', name, 'GUIDE.md'), '# Skill'); }
    await mkdir(join(root, '.codex/agents'), { recursive: true });
    await writeFile(join(root, '.codex/agents/spec_adversarial_reviewer.toml'), 'name = "spec_adversarial_reviewer"\ndescription = "Fresh Architecture reviewer"\n');
    const workflow = { schema_version: 1, workflow_id: 'spec-check', scope: 'Spec and review', stages: [
      { id: 'product', skill: 'product-spec', role: 'default', scope: 'Write Product', needs: [], conditions: [], gates: ['product_coverage'], inputs: [], outputs: [{ id: 'product_spec', description: 'Written Product Spec' }] },
      { id: 'architecture', skill: 'architecture-spec', role: 'default', scope: 'Write Architecture', needs: ['product'], conditions: [], gates: ['architecture_coverage'], inputs: [{ from_stage: 'product', artifact: 'product_spec' }], outputs: [{ id: 'architecture_spec', description: 'Written Architecture Spec' }] },
      { id: 'review', skill: 'spec-review', role: 'spec_adversarial_reviewer', scope: 'Review Architecture', needs: ['architecture'], conditions: [], gates: ['architecture_adversarial_review'], inputs: [{ from_stage: 'architecture', artifact: 'architecture_spec' }], outputs: [] },
    ] };
    const session = sessionDirectory(root);
    const check = (value) => validateComposedWorkflow({ root, session_directory: session, workflow: value });
    assert.equal((await check(workflow)).stage_count, 3);
    const badRole = structuredClone(workflow); badRole.stages[0].role = 'invented-role';
    await assert.rejects(check(badRole), /ENOENT/);
    const futureFile = structuredClone(workflow); futureFile.stages[1].inputs = [{ base: 'workspace', path: 'docs/specs/<ticket-id>/product-spec.md' }];
    await assert.rejects(check(futureFile), /ENOENT/);
    const missingArtifact = structuredClone(workflow); missingArtifact.stages[1].inputs[0].artifact = 'missing';
    await assert.rejects(check(missingArtifact), /Unknown producer artifact/);
    const cyclic = structuredClone(workflow); cyclic.stages[0].needs = ['review'];
    await assert.rejects(check(cyclic), /Cyclic/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('planning budget and runtime reserve use the setup policy without inventing measured usage', async () => {
  const { root } = await fixture();
  try {
    const policy = { schema_version: 1, context_window_tokens: 100000, max_plan_tokens: 30000, handoff_reserve_tokens: 20000 };
    await writeFile(join(root, '.codex/context-budget.json'), JSON.stringify(policy));
    const planned = await assessContextBudget({ root, estimatedTokens: 30000 });
    assert.equal(planned.plan_fits, true); assert.equal(planned.action_fits, null);
    assert.equal((await assessContextBudget({ root, estimatedTokens: 30001 })).plan_fits, false);
    assert.equal((await assessContextBudget({ root, estimatedTokens: 10000, usedTokens: 70000 })).action_fits, true);
    assert.equal((await assessContextBudget({ root, estimatedTokens: 10001, usedTokens: 70000 })).action_fits, false);
    await writeFile(join(root, '.codex/context-budget.json'), JSON.stringify({ ...policy, max_plan_tokens: 90000 }));
    await assert.rejects(assessContextBudget({ root, estimatedTokens: 1 }), /reserve exceeds/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('skill binding resolves complete configured pairs and rejects missing effort rather than inheriting', async () => {
  const { root, config } = await fixture();
  try {
    for (const [skill, model, effort] of [['spec-me', 'design-model', 'high'], ['implement', 'code-model', 'medium'], ['e2e-test', 'run-model', 'low'], ['product-spec', 'writer-model', 'low']]) {
      const actual = await resolveSkillBinding({ root, skill });
      assert.equal(actual.model, model); assert.equal(actual.reasoning_effort, effort);
    }
    await assert.rejects(resolveSkillBinding({ root, skill: 'unknown' }), /Unregistered/);
    await assert.rejects(resolveSkillBinding({ root, skill: 'orchestrator' }), /main session/);
    await writeFile(join(root, '.codex/harness.yaml'), config.replace('  execution_reasoning_effort: low\n', ''));
    await assert.rejects(resolveSkillBinding({ root, skill: 'e2e-test' }), /execution_reasoning_effort/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('skill input requires shared guidance to belong to the workspace Git common directory', async () => {
  const { root } = await fixture();
  const other = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), 'unrelated-guidance-'));
  try {
    const initialized = spawnSync('git', ['init', '-q'], { cwd: other, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const input = { schema_version: 1, execution_id: 'shared-root', skill: 'spec-review', workspace_root: root, shared_guidance_root: root, session_directory: sessionDirectory(root), scope: 'Review', input_refs: [] };
    await validateSkillInput({ root, input });
    await assert.rejects(validateSkillInput({ root, input: { ...input, shared_guidance_root: other } }), /must share the workspace Git common directory/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test('workflow stage tier overrides the skill default and cannot bind another skill', async () => {
  const { root } = await fixture();
  try {
    await mkdir(join(root, '.codex/workflows'), { recursive: true });
    await mkdir(join(root, '.codex/agents'), { recursive: true });
    await mkdir(join(root, '.codex/internal-skills/product-spec'), { recursive: true });
    await writeFile(join(root, '.codex/internal-skills/product-spec/GUIDE.md'), '# Product\n');
    await writeFile(join(root, '.codex/agents/writer.toml'), 'name = "writer"\ndescription = "Writer"\n');
    await writeFile(join(root, '.codex/workflows/example.yaml'), 'schema_version: 1\nid: example\nroles: [writer]\nskills: [product-spec]\nhooks:\n  before_dispatch: []\n  before_handoff: []\n  before_complete: []\n  after_merge: []\nstages:\n  - id: revise\n    role: writer\n    skill: product-spec\n    model_tier: implementation\n    needs: []\n');
    const actual = await resolveSkillBinding({ root, skill: 'product-spec', workflow: 'example', stage: 'revise' });
    assert.equal(actual.model, 'code-model'); assert.equal(actual.reasoning_effort, 'medium');
    await assert.rejects(resolveSkillBinding({ root, skill: 'spec-me', workflow: 'example', stage: 'revise' }), /does not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('small skill returns require matching persisted results and existing artifacts', async () => {
  const { root } = await fixture();
  try {
    const input = { schema_version: 1, execution_id: 'exec-1', skill: 'spec-review', workspace_root: root, shared_guidance_root: root, session_directory: sessionDirectory(root), scope: 'Review prepared Spec', input_refs: [] };
    const envelope = { schema_version: 1, execution_id: 'exec-1', skill: 'spec-review', status: 'action_required', code: 'SPEC_REVISION_REQUIRED', result_ref: 'runtime/executions/exec-1/result.json' };
    const resultPath = sessionOutputPath(root, envelope.result_ref);
    const result = { schema_version: 1, execution_id: 'exec-1', skill: 'spec-review', status: envelope.status, code: envelope.code, summary: 'Business rule is missing', artifacts: [], details: { findings: [{ severity: 'major', description: 'Missing cancellation rule' }] } };
    await writeFile(resultPath, JSON.stringify(result));
    assert.equal((await validateSkillReturn({ root, input, envelope })).usable_result, true);
    await assert.rejects(validateSkillReturn({ root, input, envelope: { ...envelope, execution_id: 'exec-2' } }), /execution_id mismatch/);
    await assert.rejects(validateSkillReturn({ root, input, envelope: { ...envelope, next_skill: 'spec-me' } }), /unexpected field/);
    await assert.rejects(validateSkillReturn({ root, input, envelope: { ...envelope, status: 'completed' } }), /status\/code mismatch/);
    await writeFile(resultPath, JSON.stringify({ ...result, execution_id: 'exec-2' }));
    await assert.rejects(validateSkillReturn({ root, input, envelope }), /Result execution_id mismatch/);
    await writeFile(resultPath, JSON.stringify({ ...result, artifacts: [{ base: 'workspace', path: '../escape.md' }] }));
    await assert.rejects(validateSkillReturn({ root, input, envelope }), /traversal/);
    await writeFile(resultPath, JSON.stringify({ ...result, artifacts: [{ base: 'workspace', path: 'missing.md' }] }));
    await assert.rejects(validateSkillReturn({ root, input, envelope }), /ENOENT/);
    await writeFile(join(root, 'spec.md'), 'Current Spec');
    await writeFile(resultPath, JSON.stringify({ ...result, artifacts: [{ base: 'workspace', path: 'spec.md', sha256: 'a'.repeat(64) }] }));
    await assert.rejects(validateSkillReturn({ root, input, envelope }), /hash mismatch/);
    const failure = { ...envelope, status: 'failed', code: 'ARTIFACT_WRITE_FAILED', result_ref: null };
    assert.equal((await validateSkillReturn({ root, input, envelope: failure })).usable_result, false);
    await assert.rejects(validateSkillReturn({ root, input, envelope: { ...failure, status: 'completed', code: 'OK' } }), /may omit result_ref/);
    assert.ok(await readFile(resultPath));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('completed stages must return exactly one artifact for every declared output', async () => {
  const { root } = await fixture();
  try {
    const input = { schema_version: 1, execution_id: 'output-1', skill: 'product-spec', workspace_root: root, shared_guidance_root: root, session_directory: sessionDirectory(root), scope: 'Write Product', input_refs: [], context: { outputs: [{ id: 'product_spec', description: 'Product Spec' }] } };
    const envelope = { schema_version: 1, execution_id: 'output-1', skill: 'product-spec', status: 'completed', code: 'OK', result_ref: 'runtime/executions/output-1/result.json' };
    await writeFile(join(root, 'request.md'), 'Request');
    await writeFile(join(root, 'product.md'), 'Product');
    const result = { schema_version: 1, execution_id: 'output-1', skill: 'product-spec', status: 'completed', code: 'OK', summary: 'Written', artifacts: [], details: {} };
    const path = sessionOutputPath(root, envelope.result_ref);
    const check = async (artifacts) => { await writeFile(path, JSON.stringify({ ...result, artifacts })); return validateSkillReturn({ root, input, envelope }); };
    const product = { kind: 'product_spec', base: 'workspace', path: 'product.md' };
    await assert.rejects(check([]), /one artifact with kind=product_spec/);
    await assert.rejects(check([product, { ...product, path: 'request.md' }]), /one artifact with kind=product_spec/);
    assert.equal((await check([product, { kind: 'request_record', base: 'workspace', path: 'request.md' }])).valid, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Spec reviewer receives a live admitted snapshot and must return its complete workspace hashes', async () => {
  const { root } = await fixture();
  try {
    const { snapshotSpecReview, validateSpecReviewAdmission } = await import('../src/workflow/spec-review.mjs');
    const { updateReviewAttempt } = await import('../src/workflow/review-attempts.mjs');
    await mkdir(join(root, 'docs/specs/ticket'), { recursive: true });
    await writeFile(join(root, 'docs/specs/ticket/request.md'), 'request');
    await writeFile(join(root, 'docs/specs/ticket/product-spec.md'), 'product');
    await writeFile(join(root, 'docs/specs/ticket/architecture-spec.md'), 'architecture');
    const inputs = await snapshotSpecReview({ root, ticketId: 'ticket' });
    const begin = await updateReviewAttempt({ root, scope: 'spec-ticket-architecture', action: 'begin', inputs });
    const admission = { ...begin, target: { workspace_root: root, ticket_id: 'ticket', axis: 'architecture', attempt_id: begin.attempt_id } };
    assert.equal((await validateSpecReviewAdmission({ root, admission })).attempt_id, begin.attempt_id);
    const input = { schema_version: 1, execution_id: 'review-1', skill: 'spec-review', workspace_root: root, shared_guidance_root: root, session_directory: sessionDirectory(root), scope: 'Review', input_refs: [], context: { review_admission: admission } };
    const envelope = { schema_version: 1, execution_id: 'review-1', skill: 'spec-review', status: 'completed', code: 'OK', result_ref: 'runtime/executions/review-1/result.json' };
    const result = { schema_version: 1, execution_id: 'review-1', skill: 'spec-review', status: 'completed', code: 'OK', summary: 'Reviewed', artifacts: [], details: { axis: 'architecture', ticket_id: 'ticket', inputs } };
    const resultPath = sessionOutputPath(root, envelope.result_ref);
    await writeFile(resultPath, JSON.stringify(result));
    assert.equal((await validateSkillReturn({ root, input, envelope })).valid, true);
    await writeFile(resultPath, JSON.stringify({ ...result, details: { ...result.details, inputs: {} } }));
    await assert.rejects(validateSkillReturn({ root, input, envelope }), /admitted workspace snapshot/);
    await writeFile(join(root, 'docs/specs/ticket/architecture-spec.md'), 'changed');
    await assert.rejects(validateSpecReviewAdmission({ root, admission }), /stale/);
    await assert.rejects(validateSpecReviewAdmission({ root, admission: { ...admission, attempt_id: 'other' } }), /target/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('linked workers keep task outputs in the worktree session and read explicit controller references', async () => {
  const { root } = await fixture();
  const foreign = await fixture();
  try {
    const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    git('init', '-q');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial');
    const worker = join(root, 'worker');
    git('worktree', 'add', '--detach', worker, 'HEAD');
    await cp(join(root, '.codex/internal-skills/skill-execution'), join(worker, '.codex/internal-skills/skill-execution'), { recursive: true });
    const controlSession = sessionDirectory(root);
    const taskSession = sessionDirectory(worker, { repositoryRoot: root });
    const input = { schema_version: 1, execution_id: 'exec-worker', skill: 'implement', workspace_root: worker, shared_guidance_root: root, session_directory: taskSession, scope: 'Apply owned change', input_refs: [{ base: 'control_session', path: 'runtime/request.md' }, { base: 'session', path: 'runtime/task-context.md' }], context: { control_session_directory: controlSession } };
    const envelope = { schema_version: 1, execution_id: input.execution_id, skill: input.skill, status: 'completed', code: 'OK', result_ref: 'runtime/executions/exec-worker/result.json' };
    const result = { schema_version: 1, execution_id: input.execution_id, skill: input.skill, status: 'completed', code: 'OK', summary: 'Owned action completed', artifacts: [], details: {} };
    const prefix = 'runtime/executions/exec-worker';
    await writeFile(sessionOutputPath(root, 'runtime/request.md'), 'Controller request');
    await writeFile(sessionOutputPath(worker, 'runtime/task-context.md', { repositoryRoot: root }), 'Task context');
    for (const [name, value] of [['input', input], ['return', envelope], ['result', result]]) await writeFile(sessionOutputPath(worker, `${prefix}/${name}.json`, { repositoryRoot: root }), JSON.stringify(value));
    const cli = fileURLToPath(new URL('../.codex/scripts/harness-skill-execution.mjs', import.meta.url));
    const checked = spawnSync(process.execPath, [cli, 'validate-return', '--root', worker, '--session-directory', input.session_directory, '--input', `${prefix}/input.json`, '--return', `${prefix}/return.json`], { cwd: worker, encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).usable_result, true);
    await assert.rejects(validateSkillReturn({ root: worker, input: { ...input, session_directory: sessionDirectory(foreign.root) }, envelope }), /another repository/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(foreign.root, { recursive: true, force: true });
  }
});

test('workflow stages dispatch to the prepared worktree session while retaining controller state', async () => {
  const { root } = await fixture();
  try {
    const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    git('init', '-q');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial');
    const worker = join(root, 'worker');
    git('worktree', 'add', '-b', 'spec-test', worker, 'HEAD');
    const { registerWorkflowWorktree } = await import('../src/workflow/worktrees.mjs');
    const record = await registerWorkflowWorktree({ workspace_root: worker, return_root: root });
    const controlSession = sessionDirectory(root);
    const taskSession = record.session_directory;
    await mkdir(join(root, '.codex/internal-skills/spec-me'), { recursive: true });
    await writeFile(join(root, '.codex/internal-skills/spec-me/GUIDE.md'), '# Spec me');
    await cp(join(root, '.codex/internal-skills/skill-execution'), join(worker, '.codex/internal-skills/skill-execution'), { recursive: true });
    await cp(join(root, '.codex/internal-skills/workflow-compose'), join(worker, '.codex/internal-skills/workflow-compose'), { recursive: true });
    await cp(join(root, '.codex/internal-skills/spec-me'), join(worker, '.codex/internal-skills/spec-me'), { recursive: true });
    await writeFile(join(worker, '.codex/harness.yaml'), await readFile(join(root, '.codex/harness.yaml')));
    await writeFile(sessionOutputPath(root, 'runtime/request.md'), 'Initial user request');
    const workflowRef = 'runtime/orchestrator/workflow.json';
    const workflow = { schema_version: 1, workflow_id: 'prepared-worktree', scope: 'Create the requested Spec', stages: [
      { id: 'spec_authoring', skill: 'spec-me', role: 'default', scope: 'Write the Specs', needs: [], conditions: [], gates: [], inputs: [{ base: 'session', path: 'runtime/request.md' }], outputs: [] },
    ] };
    const composerExecution = 'workflow-compose-result';
    const composerResultRef = `runtime/executions/${composerExecution}/result.json`;
    const composerInput = { schema_version: 1, execution_id: composerExecution, skill: 'workflow-compose', workspace_root: root, shared_guidance_root: root, session_directory: controlSession, scope: 'Compose workflow', input_refs: [], context: { worktree_ref: join(taskSession, 'worktree.json') } };
    const composerResult = { schema_version: 1, execution_id: composerExecution, skill: 'workflow-compose', status: 'completed', code: 'OK', summary: 'Prepared', artifacts: [], details: { worktree_ref: composerInput.context.worktree_ref } };
    await writeFile(sessionOutputPath(root, workflowRef), JSON.stringify(workflow));
    await writeFile(sessionOutputPath(root, 'runtime/orchestrator/state.json'), JSON.stringify({ schema_version: 1, codex_session_id: 'old-session', workflow_ref: workflowRef, stages: { 'workflow-compose': { status: 'completed', execution_id: composerExecution, result_ref: composerResultRef, result_session_directory: controlSession } } }));
    await writeFile(sessionOutputPath(root, `runtime/executions/${composerExecution}/input.json`), JSON.stringify(composerInput));
    await writeFile(sessionOutputPath(root, composerResultRef), JSON.stringify(composerResult));
    const { prepareStageInput } = await import('../src/workflow/stage-input.mjs');
    const prepared = await prepareStageInput({ root: worker, session: controlSession, workflowRef, stageId: 'spec_authoring', codexSessionId: 'new-session' });
    assert.equal(prepared.input.workspace_root, worker);
    assert.equal(prepared.input.session_directory, taskSession);
    assert.equal(prepared.session_directory, taskSession);
    assert.equal(prepared.input.context.control_session_directory, controlSession);
    assert.equal(prepared.input.context.worktree_ref, composerInput.context.worktree_ref);
    assert.ok(!prepared.input.input_refs.some((item) => item.path === composerResultRef));
    assert.ok(prepared.input.input_refs.some((item) => item.base === 'control_session' && item.path === 'runtime/request.md'));
    assert.equal(JSON.parse(await readFile(join(taskSession, prepared.path), 'utf8')).workspace_root, worker);
    assert.equal(await readFile(join(taskSession, 'worktree.json'), 'utf8').then((raw) => JSON.parse(raw).state), 'active');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('grilling returns one validated question and resumes with the matching answer and checkpoint', async () => {
  const { root } = await fixture();
  try {
    const { prepareStageInput } = await import('../src/workflow/stage-input.mjs');
    await mkdir(join(root, '.codex/internal-skills/product-spec'), { recursive: true });
    await writeFile(join(root, '.codex/internal-skills/product-spec/GUIDE.md'), '# Product');
    const session = sessionDirectory(root), prefix = 'runtime/executions/ask-1';
    const question = { question_id: 'resolution', question: '누가 판정하나요?', options: [{ id: 'rules', label: '규칙', consequence: '고정 규칙' }, { id: 'gm', label: 'GM', consequence: '이야기 재량' }], recommended_option_id: 'rules', rationale: '일관성' };
    const input = { schema_version: 1, execution_id: 'ask-1', skill: 'product-spec', workspace_root: root, shared_guidance_root: root, session_directory: session, scope: 'Interview', input_refs: [] };
    const envelope = { schema_version: 1, execution_id: 'ask-1', skill: 'product-spec', status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: `${prefix}/result.json` };
    const result = { schema_version: 1, execution_id: 'ask-1', skill: 'product-spec', status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: 'Decision', artifacts: [], details: { checkpoint: 'Keep confirmed requirements', question } };
    for (const [name, value] of Object.entries({ input, return: envelope, result, question })) await writeFile(sessionOutputPath(root, `${prefix}/${name}.json`), JSON.stringify(value));
    assert.equal((await validateSkillReturn({ root, input, envelope })).valid, true);
    question.recommended_option_id = 'unknown';
    await writeFile(sessionOutputPath(root, `${prefix}/result.json`), JSON.stringify(result));
    await assert.rejects(validateSkillReturn({ root, input, envelope }), /recommendation/);
    question.recommended_option_id = 'rules';
    await writeFile(sessionOutputPath(root, `${prefix}/result.json`), JSON.stringify(result));
    const workflow = { schema_version: 1, workflow_id: 'interview', scope: 'Interview', stages: [{ id: 'spec', skill: 'product-spec', role: 'default', scope: 'Continue interview', needs: [], conditions: [], gates: [], inputs: [], outputs: [] }] };
    await writeFile(sessionOutputPath(root, 'runtime/orchestrator/workflow.json'), JSON.stringify(workflow));
    await writeFile(sessionOutputPath(root, `${prefix}/exec.stderr.json`), JSON.stringify({ thread_id: '01a185ae-2681-74a1-96c4-d9c5007f9ef8' }));
    await writeFile(sessionOutputPath(root, 'runtime/orchestrator/state.json'), JSON.stringify({ schema_version: 1, codex_session_id: 'owner', workflow_ref: 'runtime/orchestrator/workflow.json', stages: { spec: { status: 'waiting', code: 'USER_DECISION_REQUIRED', execution_id: 'ask-1', result_ref: envelope.result_ref, result_session_directory: session } } }));
    const args = { root, session, workflowRef: 'runtime/orchestrator/workflow.json', stageId: 'spec', codexSessionId: 'owner' };
    await assert.rejects(prepareStageInput(args), /answer required/);
    await assert.rejects(prepareStageInput({ ...args, answer: '  ' }), /must not be empty/);
    const resumed = await prepareStageInput({ ...args, answer: 'Rules' });
    assert.equal(resumed.input.context.previous_result_ref, envelope.result_ref);
    assert.deepEqual(resumed.answer, { question_id: 'resolution', answer: 'Rules' });
    assert.equal(resumed.input.context.resume_session_id, '01a185ae-2681-74a1-96c4-d9c5007f9ef8');
    assert.doesNotMatch(JSON.stringify(resumed.input), /Rules/);
    assert.equal(resumed.input.context.question.question_id, 'resolution');
    assert.ok(!resumed.input.input_refs.some((ref) => ref.path === `${prefix}/question.json`));
    const resumedInNewSession = await prepareStageInput({ ...args, codexSessionId: 'next-session', answer: 'Rules' });
    assert.equal(resumedInNewSession.input.context.codex_session_id, 'next-session');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pending internal subtasks resume only with their validated successful result', async () => {
  const { root } = await fixture();
  try {
    const { prepareStageInput } = await import('../src/workflow/stage-input.mjs');
    for (const skill of ['product-spec', 'code-research', 'architecture-review']) {
      await mkdir(join(root, '.codex/internal-skills', skill), { recursive: true });
      await writeFile(join(root, '.codex/internal-skills', skill, 'GUIDE.md'), '# Skill');
    }
    await mkdir(join(root, '.codex/agents'), { recursive: true });
    await writeFile(join(root, '.codex/agents/architecture_review_lead.toml'), 'name = "architecture_review_lead"\ndescription = "Reviewer"\n');
    await mkdir(join(root, '.codex/workflows'), { recursive: true });
    await writeFile(join(root, '.codex/workflows/spec-me.yaml'), 'schema_version: 1\nid: spec-me\nroles: [architecture_review_lead]\nskills: [architecture-review]\nhooks:\n  before_dispatch: []\n  before_handoff: []\n  before_complete: []\n  after_merge: []\nstages:\n  - id: review-architecture-decisions\n    role: architecture_review_lead\n    skill: architecture-review\n    model_tier: high_performance\n    needs: []\n    condition: learning_mode\n    gates: []\n');
    const session = sessionDirectory(root), workflowRef = 'runtime/orchestrator/workflow.json';
    const workflow = { schema_version: 1, workflow_id: 'subtask-flow', scope: 'Write Spec', stages: [{ id: 'spec', skill: 'product-spec', role: 'default', scope: 'Write Spec', needs: [], conditions: [], gates: [], inputs: [], outputs: [] }] };
    const parent = { schema_version: 1, execution_id: 'parent-1', skill: 'product-spec', workspace_root: root, shared_guidance_root: root, session_directory: session, scope: 'Write Spec', input_refs: [], context: { stage_id: 'spec' } };
    const parentRef = 'runtime/executions/parent-1/result.json';
    const parentReturn = { schema_version: 1, execution_id: parent.execution_id, skill: parent.skill, status: 'action_required', code: 'SUBTASK_REQUIRED', result_ref: parentRef };
    const parentResult = { ...parentReturn, summary: 'Research needed', artifacts: [], details: { required_subtasks: [{ skill: 'code-research', purpose: 'Inspect current code' }] } };
    delete parentResult.result_ref;
    await writeFile(sessionOutputPath(root, workflowRef), JSON.stringify(workflow));
    await writeFile(sessionOutputPath(root, 'runtime/orchestrator/state.json'), JSON.stringify({ schema_version: 1, workflow_ref: workflowRef, stages: { spec: { status: 'waiting', code: 'SUBTASK_REQUIRED', execution_id: parent.execution_id, result_ref: parentRef, result_session_directory: session } } }));
    for (const [name, value] of [['input', parent], ['return', parentReturn], ['result', parentResult]]) await writeFile(sessionOutputPath(root, `runtime/executions/parent-1/${name}.json`), JSON.stringify(value));
    await writeFile(sessionOutputPath(root, 'runtime/executions/parent-1/exec.stderr.json'), JSON.stringify({ thread_id: '01a185ae-2681-74a1-96c4-d9c5007f9ef8' }));
    const args = { root, session, workflowRef, stageId: 'spec', codexSessionId: 'new-session' };
    await assert.rejects(prepareStageInput(args), /Select a pending subtask/);
    const stageAnswer = await prepareStageInput({ ...args, answer: '계속 진행' });
    assert.deepEqual(stageAnswer.answer, { answer: '계속 진행' });
    assert.equal(stageAnswer.input.context.resume_session_id, '01a185ae-2681-74a1-96c4-d9c5007f9ef8');
    const child = await prepareStageInput({ ...args, subtask: '0' });
    assert.equal(child.input.skill, 'code-research');
    assert.equal(child.input.context.parent_execution_id, 'parent-1');
    const childId = child.input.execution_id, childRef = `runtime/executions/${childId}/result.json`;
    const { recordExecutionState } = await import('../src/workflow/execution-state.mjs');
    const binding = { model: 'test', reasoning_effort: 'low' };
    const waiting = await prepareStageInput({ ...args, subtask: '0' });
    const waitingId = waiting.input.execution_id, waitingRef = `runtime/executions/${waitingId}/result.json`, waitingQuestion = `runtime/executions/${waitingId}/question.json`;
    const waitingEnvelope = { schema_version: 1, execution_id: waitingId, skill: 'code-research', status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: waitingRef };
    const waitingResult = { schema_version: 1, execution_id: waitingId, skill: 'code-research', status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: 'Decision', artifacts: [{ kind: 'user_question', base: 'session', path: waitingQuestion }], details: {} };
    await writeFile(sessionOutputPath(root, waitingQuestion), JSON.stringify({ question_id: 'child-question', question: '어떻게 하나요?', options: [{ id: 'yes', label: '진행', consequence: '진행한다' }, { id: 'no', label: '중단', consequence: '중단한다' }], recommended_option_id: 'yes', rationale: '진행' }));
    await writeFile(sessionOutputPath(root, waitingRef), JSON.stringify(waitingResult));
    await writeFile(sessionOutputPath(root, `runtime/executions/${waitingId}/return.json`), JSON.stringify(waitingEnvelope));
    await writeFile(sessionOutputPath(root, `runtime/executions/${waitingId}/exec.stderr.json`), JSON.stringify({ thread_id: '01a185ae-2681-74a1-96c4-d9c5007f9ef8', stderr: '' }));
    await recordExecutionState({ root, input: waiting.input, binding, status: 'running' });
    await recordExecutionState({ root, input: waiting.input, binding, status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: waitingRef });
    const continued = await prepareStageInput({ ...args, resumeSubtask: waitingId, answer: '사용자 실제 답변' });
    assert.equal(continued.input.context.resume_session_id, '01a185ae-2681-74a1-96c4-d9c5007f9ef8');
    assert.equal(continued.input.context.previous_result_ref, waitingRef);
    assert.deepEqual(continued.answer, { question_id: 'child-question', answer: '사용자 실제 답변' });
    assert.doesNotMatch(JSON.stringify(continued.input), /사용자 실제 답변/);
    await assert.rejects(prepareStageInput({ ...args, resumeSubtask: waitingId, answer: ' ' }), /must not be empty/);
    const reviewTarget = await prepareStageInput({ ...args, subtask: '0' });
    const targetId = reviewTarget.input.execution_id, targetRef = `runtime/executions/${targetId}/result.json`;
    const targetReturn = { schema_version: 1, execution_id: targetId, skill: 'code-research', status: 'action_required', code: 'REVIEW_REQUIRED', result_ref: targetRef };
    const targetResult = { schema_version: 1, execution_id: targetId, skill: 'code-research', status: 'action_required', code: 'REVIEW_REQUIRED', summary: 'Review needed', artifacts: [], details: {} };
    await writeFile(sessionOutputPath(root, targetRef), JSON.stringify(targetResult));
    await writeFile(sessionOutputPath(root, `runtime/executions/${targetId}/return.json`), JSON.stringify(targetReturn));
    await writeFile(sessionOutputPath(root, `runtime/executions/${targetId}/exec.stderr.json`), JSON.stringify({ thread_id: '01a185ae-2681-74a1-96c4-d9c5007f9ef8' }));
    await recordExecutionState({ root, input: reviewTarget.input, binding, status: 'running' });
    await recordExecutionState({ root, input: reviewTarget.input, binding, status: 'action_required', code: 'REVIEW_REQUIRED', result_ref: targetRef });
    await assert.rejects(prepareStageInput({ ...args, reviewSubtask: targetId }), /Structured review request/);
    const clarify = await prepareStageInput({ ...args, resumeSubtask: targetId, reviewDetails: true });
    assert.equal(clarify.input.context.resume_session_id, '01a185ae-2681-74a1-96c4-d9c5007f9ef8');
    assert.equal(clarify.input.context.review_details_requested, true);
    const directAnswer = await prepareStageInput({ ...args, resumeSubtask: targetId, answer: '사용자의 답변' });
    assert.deepEqual(directAnswer.answer, { answer: '사용자의 답변' });
    assert.equal(directAnswer.input.context.resume_session_id, '01a185ae-2681-74a1-96c4-d9c5007f9ef8');
    targetResult.details.review_request = { skill: 'architecture-review', role: 'architecture_review_lead', purpose: 'Review the decision', context: { decision_id: 'AD-001' } };
    await writeFile(sessionOutputPath(root, targetRef), JSON.stringify(targetResult));
    const reviewer = await prepareStageInput({ ...args, reviewSubtask: targetId });
    assert.equal(reviewer.input.context.reviewed_execution_id, targetId);
    assert.equal(reviewer.input.context.review_context.decision_id, 'AD-001');
    const reviewerId = reviewer.input.execution_id, reviewerRef = `runtime/executions/${reviewerId}/result.json`, reportRef = `runtime/executions/${reviewerId}/review.md`;
    const checklist = ['requirements', 'targets', 'alternatives', 'tradeoffs', 'evidence', 'boundary', 'answered_objections'].map((item) => `- [ ] AD-001 / ${item} — 검토 필요`).join('\n') + '\n';
    await writeFile(sessionOutputPath(root, reportRef), checklist);
    const reviewerReturn = { schema_version: 1, execution_id: reviewerId, skill: 'architecture-review', status: 'completed', code: 'OK', result_ref: reviewerRef };
    await writeFile(sessionOutputPath(root, reviewerRef), JSON.stringify({ schema_version: 1, execution_id: reviewerId, skill: 'architecture-review', status: 'completed', code: 'OK', summary: 'Reviewed', artifacts: [{ kind: 'architecture_review', base: 'session', path: reportRef }], details: {} }));
    await writeFile(sessionOutputPath(root, `runtime/executions/${reviewerId}/return.json`), JSON.stringify(reviewerReturn));
    await recordExecutionState({ root, input: reviewer.input, binding, status: 'running' });
    await recordExecutionState({ root, input: reviewer.input, binding, status: 'completed', code: 'OK', result_ref: reviewerRef });
    const reviewed = await prepareStageInput({ ...args, reviewSubtask: targetId, reviewResult: reviewerId });
    assert.equal(reviewed.input.context.resume_session_id, '01a185ae-2681-74a1-96c4-d9c5007f9ef8');
    assert.equal(reviewed.input.context.review_result.execution_id, reviewerId);
    assert.ok(!reviewed.input.input_refs.some((ref) => ref.path === reviewerRef));
    await writeFile(sessionOutputPath(root, reportRef), '- [x] AD-001 / requirements — 근거\n');
    await assert.rejects(prepareStageInput({ ...args, reviewSubtask: targetId, reviewResult: reviewerId }), /checklist missing/);
    await writeFile(sessionOutputPath(root, reportRef), checklist);
    await writeFile(sessionOutputPath(root, reviewerRef), JSON.stringify({ schema_version: 1, execution_id: reviewerId, skill: 'architecture-review', status: 'action_required', code: 'REVIEW_REQUIRED', summary: 'Evidence missing', artifacts: [{ kind: 'architecture_review', base: 'session', path: reportRef }], details: { outcome: 'NEEDS_EVIDENCE' } }));
    await writeFile(sessionOutputPath(root, `runtime/executions/${reviewerId}/return.json`), JSON.stringify({ ...reviewerReturn, status: 'action_required', code: 'REVIEW_REQUIRED' }));
    await recordExecutionState({ root, input: reviewer.input, binding, status: 'running' });
    await recordExecutionState({ root, input: reviewer.input, binding, status: 'action_required', code: 'REVIEW_REQUIRED', result_ref: reviewerRef });
    const unresolved = await prepareStageInput({ ...args, reviewSubtask: targetId, reviewResult: reviewerId });
    assert.equal(unresolved.input.context.review_result.execution_id, reviewerId);
    assert.ok(unresolved.input.input_refs.some((ref) => ref.path === reportRef));
    const childReturn = { schema_version: 1, execution_id: childId, skill: 'code-research', status: 'completed', code: 'OK', result_ref: childRef };
    const childResult = { schema_version: 1, execution_id: childId, skill: 'code-research', status: 'completed', code: 'OK', summary: 'Inspected', artifacts: [], details: {} };
    await writeFile(sessionOutputPath(root, `runtime/executions/${childId}/return.json`), JSON.stringify(childReturn));
    await writeFile(sessionOutputPath(root, childRef), JSON.stringify(childResult));
    await recordExecutionState({ root, input: child.input, binding, status: 'running' });
    await recordExecutionState({ root, input: child.input, binding, status: 'completed', code: 'OK', result_ref: childRef });
    const resumed = await prepareStageInput({ ...args, subtaskResult: childId });
    assert.equal(resumed.input.context.previous_result_ref, parentRef);
    assert.equal(resumed.input.context.subtask_result_execution_id, childId);
    assert.ok(!resumed.input.input_refs.some((ref) => ref.path === childRef));
    const resumedId = resumed.input.execution_id, resumedRef = `runtime/executions/${resumedId}/result.json`, questionRef = `runtime/executions/${resumedId}/question.json`;
    const question = { question_id: 'followup', question: '어떻게 진행하나요?', options: [{ id: 'yes', label: '진행', consequence: '진행한다' }, { id: 'no', label: '중단', consequence: '중단한다' }], recommended_option_id: 'yes', rationale: '요청된 진행' };
    const resumedReturn = { schema_version: 1, execution_id: resumedId, skill: 'product-spec', status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: resumedRef };
    const resumedResult = { schema_version: 1, execution_id: resumedId, skill: 'product-spec', status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: 'Decision needed', artifacts: [{ kind: 'user_question', base: 'session', path: questionRef }], details: {} };
    await writeFile(sessionOutputPath(root, questionRef), JSON.stringify(question));
    await writeFile(sessionOutputPath(root, resumedRef), JSON.stringify(resumedResult));
    await writeFile(sessionOutputPath(root, `runtime/executions/${resumedId}/return.json`), JSON.stringify(resumedReturn));
    await writeFile(sessionOutputPath(root, `runtime/executions/${resumedId}/exec.stderr.json`), JSON.stringify({ thread_id: '01a185ae-2681-74a1-96c4-d9c5007f9ef8' }));
    await recordExecutionState({ root, input: resumed.input, binding, status: 'running' });
    await recordExecutionState({ root, input: resumed.input, binding, status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: resumedRef });
    const afterQuestion = await prepareStageInput({ ...args, answer: '진행' });
    assert.deepEqual(afterQuestion.input.context.completed_subtasks.map((item) => item.execution_id), [childId]);
    assert.ok(!afterQuestion.input.input_refs.some((ref) => ref.path === childRef));
    await writeFile(sessionOutputPath(root, childRef), JSON.stringify({ ...childResult, status: 'failed', code: 'EXECUTION_ERROR' }));
    await assert.rejects(prepareStageInput({ ...args, answer: '진행' }), /Result status mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
