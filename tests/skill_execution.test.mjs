import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveSkillBinding, validateSkillReturn, assessContextBudget, validateComposedWorkflow } from '../src/workflow/skill-execution.mjs';
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

test('linked workers validate file returns in their caller session without accepting another repository', async () => {
  const { root } = await fixture();
  const foreign = await fixture();
  try {
    const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    git('init', '-q');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial');
    const worker = join(root, 'worker');
    git('worktree', 'add', '--detach', worker, 'HEAD');
    await cp(join(root, '.codex/internal-skills/skill-execution'), join(worker, '.codex/internal-skills/skill-execution'), { recursive: true });
    const input = { schema_version: 1, execution_id: 'exec-worker', skill: 'implement', workspace_root: worker, shared_guidance_root: root, session_directory: sessionDirectory(root), scope: 'Apply owned change', input_refs: [] };
    const envelope = { schema_version: 1, execution_id: input.execution_id, skill: input.skill, status: 'completed', code: 'OK', result_ref: 'runtime/executions/exec-worker/result.json' };
    const result = { schema_version: 1, execution_id: input.execution_id, skill: input.skill, status: 'completed', code: 'OK', summary: 'Owned action completed', artifacts: [], details: {} };
    const prefix = 'runtime/executions/exec-worker';
    for (const [name, value] of [['input', input], ['return', envelope], ['result', result]]) await writeFile(sessionOutputPath(root, `${prefix}/${name}.json`), JSON.stringify(value));
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
    const result = { schema_version: 1, execution_id: 'ask-1', skill: 'product-spec', status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: 'Decision', artifacts: [{ kind: 'user_question', base: 'session', path: `${prefix}/question.json` }], details: { checkpoint: 'Keep confirmed requirements' } };
    for (const [name, value] of Object.entries({ input, return: envelope, result, question })) await writeFile(sessionOutputPath(root, `${prefix}/${name}.json`), JSON.stringify(value));
    assert.equal((await validateSkillReturn({ root, input, envelope })).valid, true);
    question.recommended_option_id = 'unknown';
    await writeFile(sessionOutputPath(root, `${prefix}/question.json`), JSON.stringify(question));
    await assert.rejects(validateSkillReturn({ root, input, envelope }), /recommendation/);
    question.recommended_option_id = 'rules';
    await writeFile(sessionOutputPath(root, `${prefix}/question.json`), JSON.stringify(question));
    const workflow = { schema_version: 1, workflow_id: 'interview', scope: 'Interview', stages: [{ id: 'spec', skill: 'product-spec', role: 'default', scope: 'Continue interview', needs: [], conditions: [], gates: [], inputs: [], outputs: [] }] };
    await writeFile(sessionOutputPath(root, 'runtime/orchestrator/workflow.json'), JSON.stringify(workflow));
    await writeFile(sessionOutputPath(root, 'runtime/orchestrator/state.json'), JSON.stringify({ schema_version: 1, codex_session_id: 'owner', workflow_ref: 'runtime/orchestrator/workflow.json', stages: { spec: { status: 'waiting', code: 'USER_DECISION_REQUIRED', result_ref: envelope.result_ref } } }));
    const args = { root, session, workflowRef: 'runtime/orchestrator/workflow.json', stageId: 'spec', codexSessionId: 'owner' };
    await assert.rejects(prepareStageInput(args), /answer required/);
    await writeFile(sessionOutputPath(root, 'runtime/answer.json'), JSON.stringify({ question_id: 'wrong', answer: 'Rules' }));
    await assert.rejects(prepareStageInput({ ...args, answerRef: 'runtime/answer.json' }), /does not match/);
    await writeFile(sessionOutputPath(root, 'runtime/answer.json'), JSON.stringify({ question_id: 'resolution', answer: 'Rules' }));
    const resumed = await prepareStageInput({ ...args, answerRef: 'runtime/answer.json' });
    assert.equal(resumed.input.context.previous_result_ref, envelope.result_ref);
    assert.equal(resumed.input.context.answer_ref, 'runtime/answer.json');
    assert.ok(resumed.input.input_refs.some((ref) => ref.path === `${prefix}/question.json`));
  } finally { await rm(root, { recursive: true, force: true }); }
});
