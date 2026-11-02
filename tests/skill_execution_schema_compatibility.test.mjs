import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateProject, discoverManagedAssetPaths } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { join } from 'node:path';
import test from 'node:test';
import { writeOutputSchema } from '../.harness/src/workflow/output-schema.mjs';

const schemas = '.codex/internal-skills/skill-execution/schemas';
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('flow schemas expose only the questions array', async () => {
  const files = await readdir(join(schemas, 'flows'));
  for (const file of files.filter((name) => name.endsWith('.schema.json'))) {
    const schema = await readJson(join(schemas, 'flows', file));
    assert.equal(Object.hasOwn(schema.properties, 'question'), false, file);
    assert.ok(schema.properties.questions);
    assert.ok(schema.required.includes('questions'));
    const item = schema.properties.questions.items;
    assert.ok(item.required.includes('title'), file);
    assert.equal(Object.hasOwn(item.properties, 'question'), false, file);
  }
});

test('generated output schemas expose questions without a singular result field', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-output-schema-'));
  try {
    for (const skill of ['spec-me', 'workflow-compose']) {
      const path = join(directory, `${skill}.schema.json`);
      await writeOutputSchema({ root: process.cwd(), input: { execution_id: 'check', skill }, prefix: 'runtime/executions/check', path });
      const schema = await readJson(path);
      assert.equal(Object.hasOwn(schema.properties.result.properties, 'question'), false);
      assert.equal(schema.properties.result.required.includes('question'), false);
      assert.ok(Object.hasOwn(schema.properties.result.properties, 'questions'));
      assert.ok(schema.properties.result.required.includes('questions'));
      const item = schema.properties.result.properties.questions.items;
      assert.ok(item.required.includes('title'));
      assert.equal(Object.hasOwn(item.properties, 'question'), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('input context types canonical and legacy profile keys', async () => {
  const schema = await readJson(join(schemas, 'input.schema.json'));
  for (const key of ['agent_profile', 'role']) {
    assert.equal(schema.properties.context.properties[key].type, 'string');
    assert.match('spec_document_writer', new RegExp(schema.properties.context.properties[key].pattern));
  }
});

test('installed stage accepts changed documents while preserving review snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-mutable-artifact-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    const managedAssets = await discoverManagedAssetPaths(sourceRoot);
    assert.ok(managedAssets.includes('.codex/agents/tracker_publisher.toml'));
    assert.ok(managedAssets.includes('.agents/skills/tracker-publish/SKILL.md'));
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    const { validateSkillInput, validateSkillReturn } = await import(`file://${join(root, '.harness/src/workflow/skill-execution.mjs')}`);
    const session = join(root, '.io');
    await mkdir(session, { recursive: true });
    const path = 'product-spec.md';
    const originalHash = createHash('sha256').update('original').digest('hex');
    await writeFile(join(root, path), 'revised');
    const reference = { base: 'workspace', path, kind: 'product-spec', sha256: originalHash };
    const input = { schema_version: 1, execution_id: 'stage-1', skill: 'spec-me', workspace_root: root, session_directory: session, scope: 'calculator', input_refs: [reference] };
    const result = { schema_version: 1, execution_id: input.execution_id, skill: input.skill, status: 'completed', code: 'OK', summary: 'Updated', artifacts: [reference], questions: [], review_request: null };
    const envelope = { schema_version: 1, execution_id: input.execution_id, skill: input.skill, status: 'completed', code: 'OK', result_ref: 'runtime/executions/stage-1/result.json', result };
    await validateSkillInput({ root, input });
    assert.equal((await validateSkillReturn({ root, input, envelope })).valid, true);
    await rm(join(root, path));
    await assert.rejects(validateSkillInput({ root, input }), { code: 'ENOENT' });
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'consumer owned');
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.doesNotMatch(status, /\.harness\/src\/|\.codex\//);
    execFileSync('git', ['check-ignore', '-v', '.harness/src/workflow/skill-execution.mjs'], { cwd: root });
    const doctor = await runDoctor({ root, sourceRoot });
    assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('fresh install and update use consolidated flow schemas and Doctor inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-schema-install-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    const managed = await discoverManagedAssetPaths(sourceRoot);
    const flowSchemas = managed.filter((path) => path.startsWith('.codex/internal-skills/skill-execution/schemas/flows/'));
    assert.deepEqual(flowSchemas.map((path) => path.split('/').at(-1)).sort(), ['common.schema.json', 'plan-review.schema.json', 'spec-review.schema.json']);

    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    const oldSchema = '.codex/internal-skills/skill-execution/schemas/flows/eli5.schema.json';
    const oldContent = 'legacy managed flow schema';
    await mkdir(join(root, oldSchema, '..'), { recursive: true });
    await writeFile(join(root, oldSchema), oldContent);
    const lockPath = join(root, '.codex/harness-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const hash = createHash('sha256').update(oldContent).digest('hex');
    lock.files[oldSchema] = { installed_sha256: hash, upstream_sha256: hash, source_path: oldSchema };
    await writeFile(lockPath, JSON.stringify(lock));

    const updated = await updateProject({ sourceRoot, targetRoot: root });
    assert.ok(updated.retired.includes(oldSchema));
    await assert.rejects(readFile(join(root, oldSchema)), { code: 'ENOENT' });
    assert.equal(await readFile(join(updated.backup_directory, oldSchema), 'utf8'), oldContent);
    for (const name of ['common.schema.json', 'plan-review.schema.json', 'spec-review.schema.json']) {
      const schema = await readJson(join(root, '.codex/internal-skills/skill-execution/schemas/flows', name));
      assert.equal(Object.hasOwn(schema.properties, 'question'), false);
      assert.ok(schema.required.includes('questions'));
    }
    for (const skill of ['grilling', 'spec-me']) {
      const instructions = await readFile(join(root, '.agents/skills', skill, 'SKILL.md'), 'utf8');
      assert.match(instructions, /결과의 `questions` 배열/);
      assert.doesNotMatch(instructions, /결과의 `question`에/);
    }
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'project owned');
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /docs\/agents\/EXEC.md/);
    assert.doesNotMatch(status, /\.codex\/|\.agents\/|\.harness\/src\//);
    execFileSync('git', ['check-ignore', '-v', '.codex/internal-skills/skill-execution/schemas/flows/common.schema.json'], { cwd: root });
    const doctor = await runDoctor({ root, sourceRoot });
    assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installed to-ticket uses skill binding and records a fresh review against the full current snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-to-ticket-install-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  high_performance_model: gpt-6.1-sol\n  high_performance_reasoning_effort: high\n');

    const installedRuntime = `file://${join(root, '.harness/src/workflow')}`;
    const { loadNamedWorkflow } = await import(`${installedRuntime}/loader.mjs`);
    const { resolveSkillBinding, resolveAgentSandbox, validateSkillInput } = await import(`${installedRuntime}/skill-execution.mjs`);
    const session = join(root, '.io');
    await mkdir(session, { recursive: true });
    const publishInput = { schema_version: 1, execution_id: 'publish-1', skill: 'tracker-publish', scope: 'publish', input_refs: [], workspace_root: root, session_directory: session, context: {} };
    await assert.rejects(validateSkillInput({ root, input: publishInput }), /User publication approval is required/);
    await assert.rejects(validateSkillInput({ root, input: { ...publishInput, context: { publication_approved: false } } }), /User publication approval is required/);
    await validateSkillInput({ root, input: { ...publishInput, context: { publication_approved: true } } });
    const { prepareStageInput } = await import(`${installedRuntime}/stage-input.mjs`);
    await mkdir(join(session, 'runtime/orchestrator'), { recursive: true });
    const statePath = join(session, 'runtime/orchestrator/state.json');
    await writeFile(statePath, JSON.stringify({ schema_version: 1, stages: { 'workflow-compose': { status: 'completed' }, 'to-ticket': { status: 'running' } } }));
    await assert.rejects(prepareStageInput({ root, session, stageId: 'tracker-publish' }), /user publication approval are required/);
    await assert.rejects(prepareStageInput({ root, session, stageId: 'tracker-publish', publicationApproved: true }), /Completed to-ticket/);
    const workflow = await loadNamedWorkflow('to-ticket', { root });
    assert.deepEqual(workflow.stages.map(({ id }) => id), ['to-ticket', 'tracker-publish']);
    assert.deepEqual(workflow.stages[1].needs, ['to-ticket']);
    assert.ok(workflow.stages.every((stage) => !Object.hasOwn(stage, 'model_tier')));
    assert.equal((await resolveSkillBinding({ root, skill: 'to-ticket', workflow: 'to-ticket', stage: 'to-ticket' })).model_tier, 'high_performance');
    assert.equal((await resolveSkillBinding({ root, skill: 'tracker-publish', workflow: 'to-ticket', stage: 'tracker-publish' })).model_tier, 'high_performance');
    const publisherProfile = await readFile(join(root, '.codex/agents/tracker_publisher.toml'), 'utf8');
    assert.match(publisherProfile, /dedicated tracker publisher/);
    assert.match(publisherProfile, /sandbox_mode = "danger-full-access"/);
    assert.deepEqual(await resolveAgentSandbox({ root, input: { skill: 'to-ticket' }, workflow: 'to-ticket', stage: 'to-ticket' }), { profile: 'to_ticket', sandbox: 'workspace-write' });
    assert.deepEqual(await resolveAgentSandbox({ root, input: { skill: 'tracker-publish' }, workflow: 'to-ticket', stage: 'tracker-publish' }), { profile: 'tracker_publisher', sandbox: 'danger-full-access' });
    await assert.rejects(resolveAgentSandbox({ root, input: { skill: 'tracker-publish' } }), /only as the to-ticket workflow stage/);
    const toTicketInstructions = await readFile(join(root, '.agents/skills/to-ticket/SKILL.md'), 'utf8');
    assert.match(toTicketInstructions, /separate `tracker-publish` workflow stage/);
    const publisherInstructions = await readFile(join(root, '.agents/skills/tracker-publish/SKILL.md'), 'utf8');
    assert.match(publisherInstructions, /dedicated workflow executor stage/);
    assert.match(publisherInstructions, /completion receipt/);
    const publishInstructions = await readFile(join(root, '.agents/skills/to-ticket/references/github-batch-publish.md'), 'utf8');
    assert.match(publishInstructions, /별도 `tracker-publish` workflow stage/);
    const installedReviewSchema = await readJson(join(root, '.codex/internal-skills/plan-review/review-record.schema.json'));
    assert.deepEqual(installedReviewSchema.required, ['schema_version', 'attempt_id', 'plan_set_id', 'reviewer_id', 'author_ids', 'fork_turns', 'verdict', 'inputs', 'findings']);

    const planRoot = join(root, 'docs/plans/sample');
    const specRoot = join(root, 'docs/specs/sample');
    await mkdir(planRoot, { recursive: true });
    await mkdir(join(specRoot, 'diagrams'), { recursive: true });
    await writeFile(join(planRoot, 'plans.md'), '- Product Spec: `docs/specs/sample/product-spec.md`\n- Architecture Spec: `docs/specs/sample/architecture-spec.md`\n- [plan](slice.md)\n');
    await writeFile(join(planRoot, 'slice.md'), '# Slice\n');
    await writeFile(join(specRoot, 'product-spec.md'), '![diagram](diagrams/flow.svg)\n');
    await writeFile(join(specRoot, 'architecture-spec.md'), '# Architecture\n');
    await writeFile(join(specRoot, 'diagrams/flow.svg'), '<svg>reviewed</svg>\n');

    const cli = join(root, '.codex/scripts/harness-plan-review.mjs');
    const begin = JSON.parse(execFileSync(process.execPath, [cli, 'begin', '--root', root, '--plan-set', 'sample'], { cwd: root, encoding: 'utf8' }));
    assert.ok(begin.inputs['docs/specs/sample/diagrams/flow.svg']);
    const reviewsDirectory = join(root, '.io/runtime/reviews');
    await mkdir(reviewsDirectory, { recursive: true });
    const reviewPath = join(reviewsDirectory, 'result.json');
    await writeFile(reviewPath, JSON.stringify({
      schema_version: 1,
      attempt_id: begin.attempt_id,
      plan_set_id: 'sample',
      reviewer_id: 'native-plan-reviewer-1',
      author_ids: ['plan-split-execution-1'],
      fork_turns: 'none',
      verdict: 'pass',
      inputs: Object.entries(begin.inputs).map(([path, sha256]) => ({ path, sha256 })),
      findings: [],
    }));
    const recorded = JSON.parse(execFileSync(process.execPath, [cli, 'record', '--root', root, '--plan-set', 'sample', '--attempt', begin.attempt_id, '--reviews', 'runtime/reviews/result.json'], { cwd: root, encoding: 'utf8' }));
    assert.equal(recorded.status, 'pass');
    const currentReview = JSON.parse(execFileSync(process.execPath, [cli, 'check', '--root', root, '--plan-set', 'sample', '--phase', 'planning'], { cwd: root, encoding: 'utf8' }));
    assert.equal(currentReview.status, 'pass');
    assert.equal(currentReview.details.review_attempt_id, begin.attempt_id);

    await writeFile(join(specRoot, 'diagrams/flow.svg'), '<svg>changed</svg>\n');
    let stale;
    try {
      execFileSync(process.execPath, [cli, 'check', '--root', root, '--plan-set', 'sample', '--phase', 'planning'], { cwd: root, encoding: 'utf8' });
      assert.fail('stale plan review should be blocked');
    } catch (error) {
      assert.equal(error.status, 1);
      stale = JSON.parse(error.stdout.toString());
    }
    assert.equal(stale.status, 'blocked');

    const doctor = await runDoctor({ root, sourceRoot });
    assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
    assert.equal(doctor.diagnostics.some((item) => ['dangerous_sandbox_scope', 'tracker_publisher_stage_missing', 'tracker_publisher_sandbox'].includes(item.code)), false);
    const toTicketProfilePath = join(root, '.codex/agents/to_ticket.toml');
    const toTicketProfile = await readFile(toTicketProfilePath, 'utf8');
    await writeFile(toTicketProfilePath, toTicketProfile.replace('sandbox_mode = "workspace-write"', 'sandbox_mode = "danger-full-access"'));
    const unsafeDoctor = await runDoctor({ root, sourceRoot });
    assert.ok(unsafeDoctor.diagnostics.some((item) => item.code === 'dangerous_sandbox_scope'));
    await writeFile(toTicketProfilePath, toTicketProfile);
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'consumer-owned setup\n');
    await mkdir(join(root, '.harness'), { recursive: true });
    await writeFile(join(root, '.harness/application-note.md'), 'consumer-owned\n');
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.match(status, /\.harness\/application-note\.md/);
    assert.doesNotMatch(status, /\.codex\/agents\/tracker_publisher\.toml|\.agents\/skills\/(to-ticket|tracker-publish)\/|\.codex\/scripts\/harness-plan-review\.mjs|\.harness\/src\/workflow\/plan-review\.mjs|\.io\/runtime\/reviews/);
    assert.match(execFileSync('git', ['check-ignore', '-v', '.codex/agents/tracker_publisher.toml'], { cwd: root, encoding: 'utf8' }), /\.codex/);
    assert.match(execFileSync('git', ['check-ignore', '-v', '.agents/skills/tracker-publish/SKILL.md'], { cwd: root, encoding: 'utf8' }), /\.agents/);
    assert.match(execFileSync('git', ['check-ignore', '-v', '.io/runtime/reviews/result.json'], { cwd: root, encoding: 'utf8' }), /\.io/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
