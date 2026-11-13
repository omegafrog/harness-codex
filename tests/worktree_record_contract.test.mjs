import './support/trusted-codex-home.mjs';
import { bindNativeReviewer } from './support/native-reviewer.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile, chmod, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorktreeRecord, specArtifactPath } from '../.harness/src/workflow/worktrees.mjs';
import { recordExecutionState, processIdentity } from '../.harness/src/workflow/execution-state.mjs';
import { WORKTREE_STAGE } from '../.harness/src/workflow/worktree-stages.mjs';
import { findExecutionInput, writeExecutionInput } from '../.harness/src/workflow/execution-input.mjs';
import { readExecutionInput } from '../.harness/src/workflow/skill-execution.mjs';
import { finishWorkflowWorktree } from '../.harness/src/workflow/worktrees.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { parseWorkflowBinding } from '../.harness/src/workflow/providers/index.mjs';

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

test('skill exposure migration retires old public copies for Codex and Claude safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-exposure-migration-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    assert.deepEqual((await readdir(join(root, '.agents/skills'))).sort(), ['eli5', 'orchestrator', 'setup']);
    assert.deepEqual((await readdir(join(root, '.claude/skills'))).sort(), ['eli5', 'orchestrator', 'setup']);
    const policyPath = '.agents/skills/orchestrator/agents/openai.yaml';
    const policy = await readFile(join(root, policyPath), 'utf8');
    assert.match(policy, /policy:\s*\n\s+allow_implicit_invocation:\s*false/);
    await writeFile(join(root, policyPath), policy.replace(/\npolicy:\s*\n\s+allow_implicit_invocation:\s*false\s*$/, '\n'));

    const lock = JSON.parse(await readFile(join(root, '.codex/harness-lock.json'), 'utf8'));
    assert.ok(lock.files[policyPath], 'explicit-only invocation policy is managed');
    for (const path of ['.harness/src/workflow/stage-checkpoint.mjs', '.codex/scripts/harness-native-stage.mjs', '.codex/internal-skills/skill-execution/worker-base.md']) {
      assert.ok(lock.files[path], `installer lock includes ${path}`);
      assert.ok((await readFile(join(root, path), 'utf8')).length > 0);
      execFileSync('git', ['check-ignore', '-v', path], { cwd: root });
    }
    const lockPath = join(root, '.codex/harness-lock.json');
    const retired = [
      ['.codex/scripts/harness-stage-listen.mjs', 'old listener'],
      ['.codex/scripts/harness-agent-run.mjs', 'old runner'],
      ['.harness/src/workflow/codex-wake.mjs', 'old wake'],
      ['.agents/skills/e2e-test/SKILL.md', 'old e2e public guide'],
      ['.claude/skills/e2e-test/SKILL.md', 'old claude e2e public guide'],
      ['.agents/skills/spec-me/SKILL.md', 'modified local public guide'],
    ];
    for (const [path, content] of retired) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
      const hash = createHash('sha256').update(content).digest('hex');
      lock.files[path] = { source_path: path.includes('/skills/') ? `.codex/skills/${path.split('/')[2]}/SKILL.md` : path, installed_sha256: hash, upstream_sha256: hash };
    }
    const localPath = '.agents/skills/spec-me/SKILL.md';
    lock.files[localPath].installed_sha256 = createHash('sha256').update('old public guide').digest('hex');
    lock.files[localPath].upstream_sha256 = lock.files[localPath].installed_sha256;
    await writeFile(lockPath, JSON.stringify(lock));
    await mkdir(join(root, '.agents/skills/custom'), { recursive: true });
    await writeFile(join(root, '.agents/skills/custom/SKILL.md'), 'project-owned skill');
    await mkdir(join(root, '.agents/skills/code-review'), { recursive: true });
    await writeFile(join(root, '.agents/skills/code-review/SKILL.md'), 'project-owned Codex review skill');
    await mkdir(join(root, '.claude/skills/code-review'), { recursive: true });
    await writeFile(join(root, '.claude/skills/code-review/SKILL.md'), 'project-owned Claude review skill');

    const result = await updateProject({ sourceRoot, targetRoot: root });
    assert.match(await readFile(join(root, policyPath), 'utf8'), /policy:\s*\n\s+allow_implicit_invocation:\s*false/);
    execFileSync('git', ['check-ignore', '-v', policyPath], { cwd: root });
    assert.ok(result.retired.includes('.agents/skills/e2e-test/SKILL.md'));
    assert.ok(result.retired.includes('.claude/skills/e2e-test/SKILL.md'));
    assert.ok(result.retired.includes(localPath));
    for (const [path, content] of retired.slice(0, 3)) {
      assert.ok(result.retired.includes(path));
      await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' });
      assert.equal(await readFile(join(result.backup_directory, path), 'utf8'), content);
    }
    await assert.rejects(readFile(join(root, '.agents/skills/e2e-test/SKILL.md')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(root, '.claude/skills/e2e-test/SKILL.md')), { code: 'ENOENT' });
    assert.equal(await readFile(join(result.backup_directory, '.agents/skills/e2e-test/SKILL.md'), 'utf8'), 'old e2e public guide');
    assert.equal(await readFile(join(result.backup_directory, '.claude/skills/e2e-test/SKILL.md'), 'utf8'), 'old claude e2e public guide');
    await assert.rejects(readFile(join(root, localPath)), { code: 'ENOENT' });
    assert.equal(await readFile(join(result.backup_directory, localPath), 'utf8'), 'modified local public guide');
    assert.equal(await readFile(join(root, '.agents/skills/custom/SKILL.md'), 'utf8'), 'project-owned skill');
    assert.equal(await readFile(join(root, '.agents/skills/code-review/SKILL.md'), 'utf8'), 'project-owned Codex review skill');
    assert.equal(await readFile(join(root, '.claude/skills/code-review/SKILL.md'), 'utf8'), 'project-owned Claude review skill');

    const doctor = await runDoctor({ root, sourceRoot });
    assert.equal(doctor.diagnostics.some((item) => item.path?.endsWith(policyPath) && ['execution_asset_missing', 'installer_unlocked_file'].includes(item.code)), false);
    assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing' && /stage-listen|stage-result-events|worker-base/.test(item.path)), false);
    assert.equal(doctor.diagnostics.some((item) => item.code === 'harness_skill_exposed' && item.path.endsWith('/.agents/skills/spec-me/SKILL.md')), false);
    assert.equal(doctor.diagnostics.some((item) => item.code === 'harness_skill_exposed' && item.path.endsWith('/.agents/skills/custom/SKILL.md')), false);
    assert.equal(doctor.diagnostics.some((item) => item.code === 'harness_skill_exposed' && item.path.endsWith('/code-review/SKILL.md')), false);
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'project-owned execution guide');
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.match(status, /\.agents\/skills\/custom\/SKILL\.md/);
    assert.doesNotMatch(status, /\.codex\/internal-skills\/|\.codex\/scripts\/harness-stage-listen|\.harness\/src\/workflow\/stage-result-events|\.claude\/skills\/orchestrator\/|\.io\/installer-backups/);
    execFileSync('git', ['check-ignore', '-v', '.codex/internal-skills/e2e-test/GUIDE.md'], { cwd: root });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('spec paths use the canonical plan set and reject traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canonical-spec-path-'));
  try {
    await mkdir(join(root, '.io'));
    const planSetId = 'calculator-8762a95d-55a6-43fe-81e6-5d097396041a';
    await writeFile(join(root, '.io/worktree.json'), JSON.stringify({ ...record, workspace: root, session_directory: join(root, '.io'), plan_set_id: planSetId }));
    const script = fileURLToPath(new URL('../.codex/scripts/harness-spec-path.mjs', import.meta.url));
    assert.equal(execFileSync(process.execPath, [script, root, 'architecture-reviews/AR-CODE-STACK.yaml'], { encoding: 'utf8' }).trim(), `docs/specs/${planSetId}/architecture-reviews/AR-CODE-STACK.yaml`);
    for (const path of ['../outside', '/absolute', 'a/../b', 'a\\b']) assert.throws(() => specArtifactPath(planSetId, path));
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function seedSetup(root) {
  await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  codex:\n    high_performance_model: example\n    high_performance_reasoning_effort: medium\n    low_performance_model: example\n    low_performance_reasoning_effort: medium\n');
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
    const result = JSON.parse(execFileSync(process.execPath, [hook], { cwd: root, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: record.worktree_id, prompt: '$orchestrator' }), encoding: 'utf8' }));
    assert.match(result.hookSpecificOutput.additionalContext, /setup_candidate/);
    await assert.rejects(readFile(join(root, '.git', 'HEAD')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('consumer update retires writer receipt runtime and preserves project files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spec-no-writer-receipt-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true, noBackup: true });
    const oldPaths = ['.codex/scripts/harness-spec-writer.mjs', '.harness/src/workflow/spec-writer.mjs', '.harness/src/workflow/spec-writer-loop.mjs'];
    const lockPath = join(root, '.codex/harness-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    for (const path of oldPaths) {
      const content = `old managed ${path}`;
      const hash = createHash('sha256').update(content).digest('hex');
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
      lock.files[path] = { source_path: path, installed_sha256: hash, upstream_sha256: hash };
    }
    for (const path of ['.harness/src/workflow/stage-input.mjs', '.codex/internal-skills/spec-me/GUIDE.md']) {
      const content = `previous managed ${path}`;
      const hash = createHash('sha256').update(content).digest('hex');
      await writeFile(join(root, path), content);
      lock.files[path].installed_sha256 = hash;
      lock.files[path].upstream_sha256 = hash;
    }
    await writeFile(lockPath, JSON.stringify(lock));
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'project-owned\n');
    const result = await updateProject({ sourceRoot, targetRoot: root, noBackup: true });
    for (const path of oldPaths) {
      assert.ok(result.retired.includes(path));
      await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' });
    }
    assert.equal(await readFile(join(root, 'docs/agents/EXEC.md'), 'utf8'), 'project-owned\n');
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /docs\/agents\/EXEC\.md/);
    assert.doesNotMatch(status, /\.codex\/|\.harness\/src\//);
    execFileSync('git', ['check-ignore', '-v', '.codex/scripts/harness-native-stage.mjs'], { cwd: root });
    const runner = await readFile(join(root, '.codex/scripts/harness-native-stage.mjs'), 'utf8');
    const stageInput = await readFile(join(root, '.harness/src/workflow/stage-input.mjs'), 'utf8');
    const skill = await readFile(join(root, '.codex/internal-skills/spec-me/GUIDE.md'), 'utf8');
    const claudeSkill = await readFile(join(root, '.codex/internal-skills/spec-me/GUIDE.md'), 'utf8');
    assert.doesNotMatch(runner, /spec-writer-loop|dispatchSpecWriter/);
    assert.match(stageInput, /decision-answers\.json/);
    assert.match(stageInput, /revisionWaiting/);
    assert.match(skill, /별도의 writer receipt나 writer 요청 envelope는 사용하지 않는다/);
    assert.match(claudeSkill, /별도의 writer receipt나 writer 요청 envelope는 사용하지 않는다/);
    const { runDoctor } = await import('../.harness/src/doctor/doctor.mjs');
    const doctor = await runDoctor({ root, sourceRoot });
    assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed readiness checks required files without validating their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readiness-contract-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const legacyRuntimePath = '.codex/harness-runtime/src/workflow/old-runtime.mjs';
    const legacyRuntimeText = 'legacy runtime';
    await mkdir(join(root, legacyRuntimePath, '..'), { recursive: true });
    await writeFile(join(root, legacyRuntimePath), legacyRuntimeText);
    const runtimeLockPath = join(root, '.codex/harness-lock.json');
    const legacyLock = JSON.parse(await readFile(runtimeLockPath, 'utf8'));
    const legacyHash = createHash('sha256').update(legacyRuntimeText).digest('hex');
    legacyLock.files[legacyRuntimePath] = { installed_sha256: legacyHash, upstream_sha256: legacyHash, source_path: legacyRuntimePath };
    await writeFile(runtimeLockPath, JSON.stringify(legacyLock));
    const { runDoctor: inspectLegacyDoctor } = await import('../.harness/src/doctor/doctor.mjs');
    assert.ok((await inspectLegacyDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'legacy_runtime_present'));
    const runtimeMigration = await updateProject({ sourceRoot, targetRoot: root });
    await assert.rejects(readFile(join(root, legacyRuntimePath)), { code: 'ENOENT' });
    assert.equal(await readFile(join(runtimeMigration.backup_directory, legacyRuntimePath), 'utf8'), legacyRuntimeText);
    const { checkRetirement } = await import('../.harness/src/gates/lifecycle.mjs');
    assert.equal((await checkRetirement({ retirement: { workspace_root: root, removed_paths: ['src', '.codex/harness-runtime/src'] } })).status, 'pass');
    const installedSpecMe = await readFile(join(root, '.codex/internal-skills/spec-me/GUIDE.md'), 'utf8');
    assert.doesNotMatch(installedSpecMe, /Resolve the source tracker ticket before writing the Specs/);
    assert.match(installedSpecMe, /explicitly states a reusable implementation-only or test-running preference/);
    assert.match(installedSpecMe, /inside the active `workspace_root`/);
    assert.doesNotMatch(installedSpecMe, /original-project `shared_guidance_root`/);
    const installedGuidance = await readFile(join(root, '.codex/internal-skills/implementation-guidance/GUIDE.md'), 'utf8');
    assert.match(installedGuidance, /<workspace_root>\/docs\/agents\/implementation-guidance\.md/);
    assert.match(installedGuidance, /workflow branch when committed and pushed/);
    const installedSpecReview = await readFile(join(root, '.codex/internal-skills/spec-me/references/adversarial-spec-review.md'), 'utf8');
    assert.match(installedSpecReview, /pre-dispatch preparation/);
    assert.match(installedSpecReview, /substantive attempt/);
    assert.match(installedSpecReview, /REVIEW_REQUIRED/);
    const { updateReviewAttempt: installedReviewAttempt } = await import(`file://${join(root, '.harness/src/workflow/review-attempts.mjs')}`);
    const installedAdmission = await installedReviewAttempt({ root, scope: 'spec-installed-architecture', action: 'begin', inputs: { spec: 'hash' } });
    const installedAbort = await installedReviewAttempt({ root, scope: 'spec-installed-architecture', action: 'abort', attemptId: installedAdmission.attempt_id, reason: 'pre-dispatch preparation: missing reviewer inputs' });
    assert.equal(installedAbort.round, 1);
    const retryAdmission = await installedReviewAttempt({ root, scope: 'spec-installed-architecture', action: 'begin', inputs: { spec: 'hash' } });
    assert.equal(retryAdmission.round, 1);
    await installedReviewAttempt({ root, scope: 'spec-installed-architecture', action: 'abort', attemptId: retryAdmission.attempt_id, reason: 'pre-dispatch preparation: missing reviewer inputs' });
    const finalPreparation = await installedReviewAttempt({ root, scope: 'spec-installed-architecture', action: 'begin', inputs: { spec: 'hash' } });
    assert.equal(finalPreparation.round, 1);
    await installedReviewAttempt({ root, scope: 'spec-installed-architecture', action: 'abort', attemptId: finalPreparation.attempt_id, reason: 'pre-dispatch preparation: missing reviewer inputs' });
    await assert.rejects(installedReviewAttempt({ root, scope: 'spec-installed-architecture', action: 'begin', inputs: { spec: 'hash' } }), /preparation retry limit exhausted/);
    await installedReviewAttempt({ root, scope: 'spec-installed-architecture', action: 'resolve', reason: 'preparation recovery: reviewer inputs are available' });
    assert.equal((await installedReviewAttempt({ root, scope: 'spec-installed-architecture', action: 'begin', inputs: { spec: 'hash' } })).round, 1);
    const { inspectProjectReadiness } = await import(`file://${join(root, '.harness/src/workflow/project-readiness.mjs')}`);
    const { writeOutputSchema } = await import(`file://${join(root, '.harness/src/workflow/output-schema.mjs')}`);
    const { evaluateWorkflowCondition } = await import(`file://${join(root, '.harness/src/workflow/stage-gates.mjs')}`);
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
    await readFile(join(root, '.codex/scripts/harness-native-stage.mjs'));
    await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  codex:\n    low_performance_model: example\ntracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\n');
    const installedDoctor = JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-doctor.mjs'), '--project', root, '--json'], { cwd: root, encoding: 'utf8' }));
    assert.equal(installedDoctor.passed, true);
    assert.equal(installedDoctor.diagnostics.some((item) => item.code === 'installer_unlocked_file' && item.path.endsWith('/.codex/harness.yaml')), false);
    const { runDoctor } = await import('../.harness/src/doctor/doctor.mjs');
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
    assert.doesNotMatch(status, /\.codex|\.agents|\.harness\/src/);
    assert.match(status, /\.harness\/contracts\.mjs/);
    const ignoredHarnessFile = execFileSync('git', ['check-ignore', '-v', '.codex/scripts/harness-setup.mjs'], { cwd: root, encoding: 'utf8' });
    assert.match(ignoredHarnessFile, /\.codex\/scripts\/harness-setup\.mjs/);
    const ignoredRuntimeFile = execFileSync('git', ['check-ignore', '-v', '.harness/src/installer/update.mjs'], { cwd: root, encoding: 'utf8' });
    assert.match(ignoredRuntimeFile, /\.harness\/src\/installer\/update\.mjs/);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/application-change.js'), 'export const changed = true;\n');
    for (const path of ['.codex/application-notes.md', '.agents/application-skill/SKILL.md', '.harness/application-notes.md']) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), 'application-owned');
    }
    const visibleApplicationFile = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(visibleApplicationFile, /src\/application-change\.js/);
    assert.match(visibleApplicationFile, /\.codex\/application-notes\.md/);
    assert.match(visibleApplicationFile, /\.agents\/application-skill\/SKILL\.md/);
    assert.match(visibleApplicationFile, /\.harness\/application-notes\.md/);
    assert.doesNotMatch(visibleApplicationFile, /\.codex\/scripts\/harness-setup\.mjs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed setup writes reusable guidance to the active linked worktree', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'workspace-memory-install-'));
  const root = join(parent, 'main');
  const workspace = join(parent, 'worktree');
  try {
    await mkdir(root);
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Contract');
    git(root, 'config', 'user.email', 'contract@example.test');
    await mkdir(join(root, 'docs/agents'), { recursive: true });
    const original = '# Implementation guidance\n\n## Active guidance\n\n';
    const testOriginal = '# Testing guidance\n\n## Active guidance\n\n';
    await writeFile(join(root, 'docs/agents/implementation-guidance.md'), original);
    await writeFile(join(root, 'docs/agents/testing-guidance.md'), testOriginal);
    git(root, 'add', 'docs/agents');
    git(root, '-c', 'user.name=Contract', '-c', 'user.email=contract@example.test', 'commit', '-m', 'Add workspace memory');
    git(root, 'worktree', 'add', '-q', '-b', 'memory-worktree', workspace);

    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    await protectLocalInstallArtifacts(workspace, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: workspace, initialize: true });
    await updateProject({ sourceRoot, targetRoot: workspace });
    const helper = join(workspace, '.codex/scripts/harness-victorialogs.mjs');
    execFileSync(process.execPath, [helper, 'setup', '--root', workspace, '--port', '19428', '--retention-days', '7'], { cwd: workspace, stdio: 'pipe' });

    const activeGuidance = await readFile(join(workspace, 'docs/agents/implementation-guidance.md'), 'utf8');
    assert.match(activeGuidance, /opentelemetry-local-observability-v2/);
    assert.equal(await readFile(join(root, 'docs/agents/implementation-guidance.md'), 'utf8'), original);
    assert.equal(await readFile(join(root, 'docs/agents/testing-guidance.md'), 'utf8'), testOriginal);
    const worktreeStatus = git(workspace, 'status', '--short', '--untracked-files=all').toString('utf8');
    assert.match(worktreeStatus, /docs\/agents\/implementation-guidance\.md/);
    assert.match(worktreeStatus, /docs\/agents\/testing-guidance\.md/);
    assert.match(worktreeStatus, /docs\/agents\/EXEC\.md/);
    assert.doesNotMatch(worktreeStatus, /\.codex\/scripts\/harness-victorialogs\.mjs/);
    assert.throws(() => execFileSync(process.execPath, [helper, 'setup', '--root', workspace, '--shared-guidance-root', root], { cwd: workspace, stdio: 'pipe' }));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('installed local tracker progresses split plans without Beads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-plan-contract-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    const answerGuide = await readFile(join(root, '.codex/internal-skills/skill-execution/references/input.md'), 'utf8');
    assert.match(answerGuide, /\{"question_id":"<현재-질문-ID>","answer":/);
    assert.match(answerGuide, /“모두 추천” 같은 일괄 답변은 사용자에게 제시된 질문 묶음에만 적용한다/);
    const installedOrchestrator = await readFile(join(root, '.agents/skills/orchestrator/SKILL.md'), 'utf8');
    assert.match(installedOrchestrator, /사용자가 질문 묶음에 대해 “모두 추천”이라고 답하면 그 답은 보여준 해당 묶음에만 적용한다/);
    await writeFile(join(root, 'consumer-change.txt'), 'visible application change');
    const consumerStatus = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.match(consumerStatus, /consumer-change\.txt/);
    assert.doesNotMatch(consumerStatus, /\.codex\/internal-skills\/|\.agents\/skills\/|\.harness\/src\/|\.io\//);
    for (const path of ['.codex/internal-skills/skill-execution/references/input.md', '.agents/skills/orchestrator/SKILL.md']) {
      execFileSync('git', ['check-ignore', '-v', path], { cwd: root });
    }
    assert.equal(await readFile(join(root, 'consumer-change.txt'), 'utf8'), 'visible application change');
    assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
    await writeFile(join(root, '.codex/harness.yaml'), 'tracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\nbeads:\n  enabled: false\n');
    await mkdir(join(root, 'docs/plans/calculator'), { recursive: true });
    await writeFile(join(root, 'docs/plans/calculator/calculator.md'), '---\nstatus: planned\n---\n# 계산기\n');
    const { syncTrackerStatus, readTrackerStatus } = await import(`file://${join(root, '.harness/src/tracker/lifecycle.mjs')}`);
    const ticket_ref = 'docs/plans/calculator/calculator.md';
    assert.equal((await syncTrackerStatus({ workspace_root: root, ticket_ref, status: 'in-progress' })).status, 'pass');
    assert.equal((await readTrackerStatus({ workspace_root: root, ticket_ref })).canonical_status, 'in-progress');
    assert.match(execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }), /docs\/plans\/calculator\/calculator.md/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compose preserves a failed worktree when project preparation is incomplete', async () => {
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
    git('add', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs', '.harness/contracts.mjs');
    git('-c', 'user.name=Contract', '-c', 'user.email=contract@example.test', 'commit', '-m', 'Incomplete setup');
    assert.throws(() => execFileSync(process.execPath, [join(root, '.codex/scripts/harness-compose-workspace.mjs'), '--root', root, '--plan-set-id', 'calculator', '--request', '계산기', '--execution-id', 'compose-1'], { cwd: root, stdio: 'pipe' }), /Command failed/);
    const worktrees = git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
    assert.equal(worktrees.length, 2);
    const failed = JSON.parse(await readFile(join(worktrees[1], '.io/worktree.json'), 'utf8'));
    assert.equal(failed.state, 'active');
    assert.equal(failed.outcome, 'failed');
    assert.equal(git('status', '--short'), '');
    await finishWorkflowWorktree({ workspace_root: worktrees[1], repository_root: root, worktree_id: failed.worktree_id, outcome: 'failed' });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('installed compose uses the setup baseline and preserves workflow transitions', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'compose-unborn-'));
  const root = join(parent, 'project');
  let tree, secondTree;
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
    const selectedWorktrees = join(parent, 'selected worktrees');
    const selectedLink = join(parent, 'worktrees link');
    await mkdir(selectedWorktrees);
    await symlink(selectedWorktrees, selectedLink, 'dir');
    await writeFile(join(root, '.codex/harness.yaml'), `${await readFile(join(root, '.codex/harness.yaml'), 'utf8')}\nworktrees:\n  directory: ${JSON.stringify(selectedLink)}\n`);
    git('add', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs', '.harness/contracts.mjs');
    git('commit', '-m', 'setup baseline');
    const workflowBinding = { provider: 'codex', model: 'gpt-6-luna', reasoning_effort: 'medium' };
    const compose = (executionId) => JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-compose-workspace.mjs'), '--root', root, '--plan-set-id', 'calculator', '--request', '계산기', '--execution-id', executionId], { cwd: root, encoding: 'utf8', env: { ...process.env, HARNESS_WORKFLOW_BINDING: JSON.stringify(workflowBinding) } }));
    const validConfig = await readFile(join(root, '.codex/harness.yaml'), 'utf8');
    await writeFile(join(root, '.codex/harness.yaml'), validConfig.replace(JSON.stringify(selectedLink), '"relative/path"'));
    assert.throws(() => compose('compose-invalid'), /absolute directory path/);
    assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
    await writeFile(join(root, '.codex/harness.yaml'), validConfig);
    tree = compose('compose-1');
    secondTree = compose('compose-2');
    assert.equal(join(selectedWorktrees, tree.workspace.split('/').at(-1)), tree.workspace);
    assert.equal(join(selectedWorktrees, secondTree.workspace.split('/').at(-1)), secondTree.workspace);
    assert.match(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-progress.mjs')], { cwd: root, encoding: 'utf8' }), /workflow-compose/);
    const prepared = { input: await readExecutionInput({ root: tree.workspace, execution_id: 'compose-1' }) };
    const worktreeRecord = JSON.parse(await readFile(join(tree.session_directory, 'worktree.json'), 'utf8'));
    const secondWorktreeRecord = JSON.parse(await readFile(join(secondTree.session_directory, 'worktree.json'), 'utf8'));
    assert.match(worktreeRecord.plan_set_id, /^calculator-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(worktreeRecord.plan_set_id, secondWorktreeRecord.plan_set_id);
    assert.notEqual(tree.worktree_ref, secondTree.worktree_ref);
    assert.notEqual(tree.execution_id, secondTree.execution_id);
    assert.equal(tree.execution_id, 'compose-1');
    assert.equal(secondTree.execution_id, 'compose-2');
    assert.equal(worktreeRecord.plan_set_id, tree.plan_set_id);
    assert.equal(secondWorktreeRecord.plan_set_id, secondTree.plan_set_id);
    assert.deepEqual(worktreeRecord.workflow_binding, workflowBinding);
    assert.deepEqual(secondWorktreeRecord.workflow_binding, workflowBinding);
    assert.equal(tree.worktree_ref, join(tree.session_directory, 'worktree.json'));
    assert.equal(secondTree.worktree_ref, join(secondTree.session_directory, 'worktree.json'));
    assert.equal(JSON.parse(await readFile(join(tree.session_directory, 'runtime/executions/compose-1/result.json'), 'utf8')).worktree_ref, tree.worktree_ref);
    assert.equal(JSON.parse(await readFile(join(secondTree.session_directory, 'runtime/executions/compose-2/result.json'), 'utf8')).worktree_ref, secondTree.worktree_ref);
    assert.match(await readFile(join(tree.workspace, '.codex/internal-skills/workflow-compose/GUIDE.md'), 'utf8'), /slug에 UUID를 붙여 고유한 `plan_set_id`/);
    assert.equal(worktreeRecord.agent_sessions?.orchestrator, undefined);
    const resultRef = 'runtime/executions/compose-1/result.json';
    assert.equal(tree.status, 'completed');
    const composeProgress = JSON.parse(await readFile(join(tree.session_directory, 'runtime/orchestrator/progress.json'), 'utf8'));
    assert.equal(composeProgress.workspace_root, tree.workspace);
    assert.equal(composeProgress.worktree_ref, tree.worktree_ref);
    assert.equal(composeProgress.request, '계산기');
    assert.equal(composeProgress.stages.find((stage) => stage.id === 'workflow-compose').status, 'completed');
    assert.equal(composeProgress.total_stages, null);
    await writeFile(join(tree.workspace, 'user-draft.txt'), 'preserve me');
    const failedCompletion = spawnSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-workflow-complete.mjs'), '--root', tree.workspace, '--workflow', 'spec-me', '--worktree-id', tree.worktree_id, '--base-ref', tree.head, '--state', 'runtime/spec-me/missing.json'], { cwd: tree.workspace, encoding: 'utf8' });
    assert.notEqual(failedCompletion.status, 0);
    assert.equal(await readFile(join(tree.workspace, 'user-draft.txt'), 'utf8'), 'preserve me');
    assert.equal(JSON.parse(await readFile(join(tree.session_directory, 'worktree.json'), 'utf8')).state, 'active');
    const completionPath = execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-session-output.mjs'), '--root', tree.workspace, '--path', 'runtime/spec-me/completion-state.json'], { cwd: tree.workspace, encoding: 'utf8' }).trim();
    await writeFile(completionPath, JSON.stringify({ ticket_id: 'calculator', tracker_sync: { ticket_refs: [] } }));
    const blockedCompletion = spawnSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-workflow-complete.mjs'), '--root', tree.workspace, '--workflow', 'spec-me', '--worktree-id', tree.worktree_id, '--base-ref', tree.head, '--state', 'runtime/spec-me/completion-state.json'], { cwd: tree.workspace, encoding: 'utf8' });
    assert.notEqual(blockedCompletion.status, 0);
    assert.equal(JSON.parse(blockedCompletion.stdout).state, 'in-progress');
    // The gate finds the plan set's Architecture review in the review history itself; the state file need not carry it.
    const planSetId = JSON.parse(await readFile(join(tree.session_directory, 'worktree.json'), 'utf8')).plan_set_id;
    if (planSetId) {
      assert.match(JSON.parse(blockedCompletion.stdout).verdict.reason, /missing or for another ticket/);
      const { updateReviewAttempt } = await import(`file://${join(tree.workspace, '.harness/src/workflow/review-attempts.mjs')}`);
      const reviewInputs = { [`docs/specs/${planSetId}/architecture-spec.md`]: 'a'.repeat(64) };
      const scope = `spec-${planSetId}-architecture`;
      const admission = await updateReviewAttempt({ root: tree.workspace, scope, action: 'begin', inputs: reviewInputs });
      await updateReviewAttempt({ root: tree.workspace, scope, action: 'record', attemptId: admission.attempt_id, inputs: reviewInputs, review: { axis: 'architecture', ticket_id: planSetId, verdict: 'pass', findings: [], reviewer_id: 'reviewer', author_ids: ['author'], fork_turns: 'none' } });
      const withReview = spawnSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-workflow-complete.mjs'), '--root', tree.workspace, '--workflow', 'spec-me', '--worktree-id', tree.worktree_id, '--base-ref', tree.head], { cwd: tree.workspace, encoding: 'utf8' });
      assert.doesNotMatch(withReview.stdout, /missing or for another ticket/);
      await rm(join(tree.session_directory, `runtime/reviews/${scope}.json`), { force: true });
    }
    assert.equal(await readFile(join(tree.workspace, 'user-draft.txt'), 'utf8'), 'preserve me');
    assert.equal(JSON.parse(await readFile(join(tree.session_directory, 'worktree.json'), 'utf8')).state, 'active');
    assert.equal(execFileSync('git', ['check-ignore', '-q', '.io/runtime/spec-me/completion-state.json'], { cwd: tree.workspace }).length, 0);
    assert.equal(JSON.parse(await readFile(join(tree.session_directory, resultRef), 'utf8')).worktree_ref, tree.worktree_ref);
    const hook = join(root, '.codex/scripts/harness-orchestrator-hook.mjs');
    const context = JSON.parse(execFileSync(process.execPath, [hook], { cwd: root, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: record.worktree_id, prompt: '$orchestrator' }), encoding: 'utf8' })).hookSpecificOutput.additionalContext;
    const claudeHook = join(root, '.claude/harness/scripts/harness-claude-orchestrator-hook.mjs');
    assert.equal(await readFile(claudeHook, 'utf8'), await readFile(join(sourceRoot, '.claude/harness/scripts/harness-claude-orchestrator-hook.mjs'), 'utf8'));
    const claudeContext = JSON.parse(execFileSync(process.execPath, [claudeHook], { cwd: root, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: record.worktree_id, prompt: '$orchestrator' }), encoding: 'utf8' })).hookSpecificOutput.additionalContext;
    for (const startupContext of [context, claudeContext]) {
      assert.match(startupContext, /change directory to that worktree before invoking the orchestrator/);
      assert.match(startupContext, /change directory to its workspace_root/);
      assert.match(startupContext, /fresh execution ID/);
      assert.match(startupContext, /compose with a fresh execution ID/i);
      assert.match(startupContext, /Never select by newest record/);
    }
    assert.ok(context.includes('계산기'));
    assert.ok(context.includes(tree.worktree_ref));
    assert.ok(context.includes('worktree_candidates'));
    const { inspectStartupState } = await import('../.harness/src/workflow/startup-state.mjs');
    const startup = await inspectStartupState({ workspaceRoot: root, codexSessionId: record.worktree_id });
    assert.equal(startup.worktree_candidates.length, 2);
    assert.ok(startup.worktree_candidates.every((candidate) => candidate.request === '계산기'));
    const sourceOrchestrator = await readFile(join(sourceRoot, '.codex/skills/orchestrator/SKILL.md'), 'utf8');
    const installedOrchestrator = await readFile(join(root, '.agents/skills/orchestrator/SKILL.md'), 'utf8');
    assert.equal(installedOrchestrator, sourceOrchestrator);
    assert.match(installedOrchestrator, /workflow 명령은 현재 working directory가 소유 worktree일 때만 실행한다/);
    assert.match(installedOrchestrator, /여러 후보가 있거나 원래 요청을 확인할 수 없으면 후보 경로를 제시하고 사용할 worktree를 선택하게 한다/);
    assert.match(installedOrchestrator, /사용자가 그 디렉터리로 이동한 뒤 orchestrator를 다시 호출하도록 한다/);
    const sourceComposerGuide = await readFile(join(sourceRoot, '.codex/internal-skills/workflow-compose/GUIDE.md'), 'utf8');
    const installedComposerGuide = await readFile(join(root, '.codex/internal-skills/workflow-compose/GUIDE.md'), 'utf8');
    assert.equal(installedComposerGuide, sourceComposerGuide);
    assert.match(installedComposerGuide, /새로운 execution ID/);
    assert.match(installedComposerGuide, /생성 직전 Git에 등록된 worktree 목록/);
    assert.match(installedComposerGuide, /반환된 정본 `worktree.json`의 binding/);
    assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
    const installedComposerRuntime = join(root, '.harness/src/workflow/composer-workspace.mjs');
    const composerRuntime = await readFile(installedComposerRuntime, 'utf8');
    await unlink(installedComposerRuntime);
    const missingRuntime = await runDoctor({ root, sourceRoot });
    assert.ok(missingRuntime.diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path.endsWith('/.harness/src/workflow/composer-workspace.mjs')));
    await writeFile(installedComposerRuntime, composerRuntime);
    assert.match(await readFile(join(root, '.agents/skills/orchestrator/SKILL.md'), 'utf8'), /workflow_ref.*null/);
    await writeFile(join(root, 'application-change.txt'), 'preserved');
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'project-owned execution notes\n');
    const consumerStatus = git('status', '--short', '--untracked-files=all');
    assert.match(consumerStatus, /application-change\.txt/);
    assert.match(consumerStatus, /docs\/agents\/EXEC\.md/);
    assert.doesNotMatch(consumerStatus, /\.codex\/|\.harness\/|\.io\//);
    for (const path of ['.codex/internal-skills/workflow-compose/GUIDE.md', '.codex/scripts/harness-orchestrator-hook.mjs', '.harness/src/workflow/composer-workspace.mjs', '.io/worktree.json']) {
      execFileSync('git', ['check-ignore', '-v', path], { cwd: root });
    }
    assert.equal(await readFile(join(root, 'application-change.txt'), 'utf8'), 'preserved');
    await rm(join(root, 'application-change.txt'));
    await writeFile(join(root, 'docs/agents/EXEC.md'), '');
    const invalidStage = spawnSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'product'], { cwd: tree.workspace, encoding: 'utf8' });
    assert.notEqual(invalidStage.status, 0);
    assert.match(invalidStage.stderr, /Unregistered skill: product/);
    const next = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'spec-me'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(next.input.skill, 'spec-me');
    assert.equal(next.input.context.role, undefined);
    const stageInput = await findExecutionInput(tree.workspace, next.input.execution_id);
    const resultDir = join(tree.session_directory, 'runtime/executions', next.input.execution_id);
    await mkdir(resultDir, { recursive: true });
    const resultRefForQuestion = `runtime/executions/${next.input.execution_id}/result.json`;
    const generatedSchema = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-output-schema.mjs'), '--root', tree.workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', next.input.execution_id], { cwd: tree.workspace, encoding: 'utf8' }));
    const schema = JSON.parse(await readFile(generatedSchema.path, 'utf8'));
    const rawOutput = join(resultDir, 'codex-last-message.json');
    await writeFile(rawOutput, JSON.stringify({ status: 123 }));
    const formatCheck = spawnSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-output-format.mjs'), '--root', tree.workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', next.input.execution_id], { cwd: tree.workspace, encoding: 'utf8' });
    assert.equal(formatCheck.status, 1, formatCheck.stderr);
    const formatErrors = JSON.parse(formatCheck.stdout);
    assert.ok(formatErrors.errors.some((item) => item.path === '$.status' && item.value === 123));
    assert.ok(formatErrors.errors.some((item) => item.path === '$.result' && item.missing));
    await rm(rawOutput);
    assert.equal(Object.hasOwn(schema.properties.result.properties, 'required_subtasks'), false);
    assert.ok(schema.properties.result.properties.review_request);
    assert.equal(schema.properties.code.enum.includes('SUBTASK_REQUIRED'), false);
    assert.equal(schema.properties.result.properties.code.enum.includes('SUBTASK_REQUIRED'), false);
    const reviewRequest = schema.properties.result.properties.review_request.anyOf.find((shape) => shape.type === 'object');
    assert.ok(reviewRequest.properties.skill.enum.includes('architecture-review'));
    assert.ok(reviewRequest.properties.agent_profile.enum.includes('architecture_review_lead'));
    assert.ok(reviewRequest.properties.agent_profile.enum.includes('default'));
    assert.ok(reviewRequest.properties.agent_profile.enum.includes(null));
    const canonicalSpecDir = `docs/specs/${tree.plan_set_id}`;
    await mkdir(join(tree.workspace, canonicalSpecDir, 'architecture-reviews'), { recursive: true });
    await writeFile(join(tree.workspace, canonicalSpecDir, 'architecture-reviews/review.yaml'), 'review');
    const wrongId = tree.plan_set_id.replace(/[0-9a-f]{12}$/i, '000000000000');
    const questionResult = { schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '파일 정본', artifacts: [{ base: 'workspace', path: `docs/specs/${wrongId}/architecture-reviews/review.yaml`, kind: 'architecture-decision-review', sha256: 'a'.repeat(64) }], questions: [{ question_id: 'scope', title: '범위는?', options: [{ id: 'basic', label: '기본', consequence: '기본 계산' }, { id: 'scientific', label: '공학', consequence: '추가 계산' }], recommended_option_id: 'basic', rationale: '작은 범위' }], review_request: null };
    const { review_request: omittedReview, ...questionWithoutReview } = questionResult;
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(questionWithoutReview));
    const answerEnvelope = { schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: resultRefForQuestion, result: { ...questionResult, summary: '다르게 표현된 응답' } };
    await writeFile(join(resultDir, 'return.json'), JSON.stringify(answerEnvelope));
    const resultCommand = [join(tree.workspace, '.codex/scripts/harness-result.mjs'), '--root', tree.workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', next.input.execution_id, '--return', `runtime/executions/${next.input.execution_id}/return.json`];
    const validated = JSON.parse(execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, encoding: 'utf8' }));
    const rawResultPath = `runtime/executions/${next.input.execution_id}/codex-last-message.json`;
    await writeFile(join(resultDir, 'codex-last-message.json'), JSON.stringify({ ...answerEnvelope, execution_id: 'mistyped', result: { ...questionResult, execution_id: 'mistyped' } }));
    await writeFile(join(resultDir, 'result.json'), JSON.stringify({ ...questionWithoutReview, execution_id: 'mistyped' }));
    const rawCommand = [join(tree.workspace, '.codex/scripts/harness-result.mjs'), '--root', tree.workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', next.input.execution_id, '--source', rawResultPath];
    const normalizedResult = JSON.parse(execFileSync(process.execPath, rawCommand, { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(normalizedResult.execution_id, next.input.execution_id);
    assert.equal(normalizedResult.result.execution_id, next.input.execution_id);
    assert.equal(validated.result.summary, '파일 정본');
    assert.equal(validated.result.artifacts[0].path, `${canonicalSpecDir}/architecture-reviews/review.yaml`);
    // The runner fingerprints the returned file itself instead of trusting the model-typed hash.
    assert.equal(validated.result.artifacts[0].sha256, createHash('sha256').update(await readFile(join(tree.workspace, validated.result.artifacts[0].path))).digest('hex'));
    questionResult.artifacts = validated.result.artifacts;
    assert.equal(validated.result.review_request, null);
    assert.equal(Object.hasOwn(validated.result, 'question'), false);
    assert.equal(Object.hasOwn(schema.properties.result.properties, 'question'), false);
    assert.equal(validated.result.questions.length, 1);
    assert.equal(validated.result.questions[0].question_id, `${next.input.execution_id}:1`);
    assert.equal(validated.result.questions[0].title, '범위는?');
    assert.deepEqual(validated.result, JSON.parse(await readFile(join(resultDir, 'result.json'), 'utf8')));
    const { title, ...oldItem } = questionResult.questions[0];
    await writeFile(join(resultDir, 'result.json'), JSON.stringify({ ...questionResult, questions: [{ ...oldItem, question: title }] }));
    assert.throws(() => execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, stdio: 'pipe' }));
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(validated.result));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify({ ...answerEnvelope, status: 'completed', code: 'OK' }));
    assert.throws(() => execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, stdio: 'pipe' }));
    assert.deepEqual(JSON.parse(await readFile(join(resultDir, 'result.json'), 'utf8')), validated.result);
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'SUBTASK_REQUIRED', result_ref: resultRefForQuestion });
    const { prepareStageInput } = await import(`file://${join(tree.workspace, '.harness/src/workflow/stage-input.mjs')}`);
    await assert.rejects(prepareStageInput({ root: tree.workspace, session: tree.session_directory, worktreeRef: tree.worktree_ref, workflowRef: null, stageId: 'spec-me', codexSessionId: record.worktree_id }), /pending subagent identity and result are not recorded.*in-place recovery is unsupported/i);
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--subtask', '0'], { cwd: tree.workspace, stdio: 'pipe' }));
    const blockedStage = { ...questionResult, status: 'blocked', code: 'ENVIRONMENT_UNAVAILABLE', questions: [] };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(blockedStage));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify({ ...answerEnvelope, status: 'blocked', code: 'ENVIRONMENT_UNAVAILABLE', result: blockedStage }));
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'blocked', code: 'ENVIRONMENT_UNAVAILABLE', result_ref: resultRefForQuestion });
    await writeFile(join(resultDir, 'exec.stderr.json'), JSON.stringify({ thread_id: record.worktree_id }));
    const userRevision = { root: tree.workspace, session: tree.session_directory, worktreeRef: tree.worktree_ref, workflowRef: null, codexSessionId: record.worktree_id, userRevision: true };
    await assert.rejects(prepareStageInput({ ...userRevision, stageId: 'spec-me', feedback: '고쳐' }), /requires a completed stage or one waiting on its question/);
    await assert.rejects(prepareStageInput({ ...userRevision, stageId: 'implement-wrapper', feedback: '고쳐' }), /requires a plan, failure receipt and approval answer/);
    await assert.rejects(prepareStageInput({ ...userRevision, stageId: 'spec-me' }), /requires feedback/);
    const unblocked = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--feedback', '누락된 자료를 준비했습니다'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(unblocked.input.context.resume_session_id, record.worktree_id);
    assert.equal(unblocked.input.context.previous_result_ref, resultRefForQuestion);
    const conflicting = { ...questionResult, question: questionResult.questions[0] };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(conflicting));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify(answerEnvelope));
    assert.throws(() => execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, stdio: 'pipe' }));
    await writeFile(join(resultDir, 'findings.md'), '검토 지적');
    const findings = { base: 'session', path: `runtime/executions/${next.input.execution_id}/findings.md`, kind: 'review_findings', sha256: null };
    const reviewContextPath = `runtime/executions/${next.input.execution_id}/review-context.json`;
    await writeFile(join(tree.session_directory, reviewContextPath), JSON.stringify({ decision_ids: ['decision-1'] }));
    const review = { ...questionResult, code: 'REVIEW_REQUIRED', artifacts: [findings], review_request: { skill: 'architecture-review', agent_profile: 'architecture_review_lead', purpose: 'Review the settled architecture', context_path: reviewContextPath } };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(review));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify({ ...answerEnvelope, code: 'REVIEW_REQUIRED', result: review }));
    const reviewed = JSON.parse(execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(reviewed.result.questions.length, 1);
    assert.equal(reviewed.result.review_request.agent_profile, 'architecture_review_lead');
    // A null hash from the model is replaced by the runner's fingerprint of the session file.
    assert.deepEqual(reviewed.result.artifacts, [{ ...findings, sha256: createHash('sha256').update(await readFile(join(tree.session_directory, findings.path))).digest('hex') }]);
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'REVIEW_REQUIRED', result_ref: resultRefForQuestion });
    await writeFile(join(resultDir, 'exec.stderr.json'), JSON.stringify({ thread_id: record.worktree_id }));
    const reviewFeedback = 'Reviewer findings: address the mismatch in decision-1; see review report in the prior result.';
    const reviewResume = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--feedback', reviewFeedback], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(reviewResume.input.context.resume_session_id, record.worktree_id);
    assert.equal(reviewResume.input.context.previous_result_ref, resultRefForQuestion);
    assert.equal(await readFile(join(tree.session_directory, 'runtime/executions', reviewResume.input.execution_id, 'feedback.json'), 'utf8'), JSON.stringify({ feedback: reviewFeedback }, null, 2) + '\n');
    for (const agent_profile of ['default', null]) {
      const profileReview = { ...review, review_request: { ...review.review_request, agent_profile } };
      await writeFile(join(resultDir, 'result.json'), JSON.stringify(profileReview));
      await writeFile(join(resultDir, 'return.json'), JSON.stringify({ ...answerEnvelope, code: 'REVIEW_REQUIRED', result: profileReview }));
      const accepted = JSON.parse(execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, encoding: 'utf8' }));
      assert.equal(accepted.result.review_request.agent_profile, agent_profile);
    }
    const unstructuredReview = { ...review, review_request: null };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(unstructuredReview));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify({ ...answerEnvelope, code: 'REVIEW_REQUIRED', result: unstructuredReview }));
    assert.equal(JSON.parse(execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, encoding: 'utf8' })).result.review_request, null);
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'REVIEW_REQUIRED', result_ref: resultRefForQuestion });
    const implementationReviewResume = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--feedback', 'Implementation review findings: adjust behavior covered by test case A.'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(implementationReviewResume.input.context.resume_session_id, record.worktree_id);
    const multi = { ...questionResult, questions: [questionResult.questions[0], { ...questionResult.questions[0], question_id: 'input', title: '입력 방식은?' }] };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(multi));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify({ ...answerEnvelope, result: multi }));
    const normalized = JSON.parse(execFileSync(process.execPath, resultCommand, { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(normalized.result.questions.length, 2);
    await writeFile(join(resultDir, 'exec.stderr.json'), JSON.stringify({ thread_id: record.worktree_id, exit_code: 0, binding: { model: 'example', reasoning_effort: 'low' } }));
    const identity = await processIdentity(process.pid);
    const stopped = { ...identity, pid: 2147483647, start: 'stopped' };
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    const unknownProgress = JSON.parse(await readFile(join(tree.session_directory, 'runtime/orchestrator/progress.json'), 'utf8'));
    assert.equal(unknownProgress.status, 'unknown');
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running', owner: identity, child: stopped });
    const liveProgress = JSON.parse(await readFile(join(tree.session_directory, 'runtime/orchestrator/progress.json'), 'utf8'));
    assert.equal(liveProgress.status, 'running');
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me'], { cwd: tree.workspace, stdio: 'pipe' }), /Stage already running/);
    await assert.rejects(prepareStageInput({ root: tree.workspace, session: tree.session_directory, worktreeRef: tree.worktree_ref, workflowRef: null, stageId: 'spec-me', orchestratorSession: { provider: 'claude-code', session_id: '4c1483d6-c69d-4df3-a6c1-481c7ac4ff44' } }), /Stage already running/);
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running', owner: stopped, child: stopped });
    const progress = JSON.parse(await readFile(join(tree.session_directory, 'runtime/orchestrator/progress.json'), 'utf8'));
    assert.equal(progress.status, 'stopped');
    assert.equal(progress.stages.find((item) => item.id === 'spec-me').process_status, 'stopped');
    const stoppedContext = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-orchestrator-hook.mjs')], { cwd: tree.workspace, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: tree.workspace, session_id: record.worktree_id, prompt: '$orchestrator' }), encoding: 'utf8' })).hookSpecificOutput.additionalContext;
    assert.match(stoppedContext, /"process_status":"stopped"/);
    const prepare = [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me'];
    const earlierAnswers = [{ question_id: 'earlier:1', answer: 'prior' }];
    await writeFile(join(resultDir, 'answers.json'), JSON.stringify(earlierAnswers));
    await writeFile(join(resultDir, 'decision-answers.json'), JSON.stringify(earlierAnswers, null, 2) + '\n');
    const firstAnswer = JSON.stringify([{ question_id: `${next.input.execution_id}:1`, answer: 'basic' }]);
    await writeFile(join(resultDir, 'result.json'), JSON.stringify({ ...normalized.result, summary: '변조됨' }));
    assert.throws(() => execFileSync(process.execPath, [...prepare, '--answer', firstAnswer], { cwd: tree.workspace, stdio: 'pipe' }));
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(normalized.result));
    await symlink(join(resultDir, 'result.json'), join(resultDir, 'pending-answers.json'));
    assert.throws(() => execFileSync(process.execPath, [...prepare, '--answer', firstAnswer], { cwd: tree.workspace, stdio: 'pipe' }), /regular unshared file/);
    await unlink(join(resultDir, 'pending-answers.json'));
    const pending = JSON.parse(execFileSync(process.execPath, [...prepare, '--answer', firstAnswer], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(pending.waiting_for_answers, true);
    assert.throws(() => execFileSync(process.execPath, [...prepare, '--answer', JSON.stringify([{ question_id: 'stale', answer: 'basic' }])], { cwd: tree.workspace, stdio: 'pipe' }));
    assert.throws(() => execFileSync(process.execPath, [...prepare, '--answer', JSON.stringify([{ question_id: `${next.input.execution_id}:1`, answer: 'changed' }])], { cwd: tree.workspace, stdio: 'pipe' }));
    const secondAnswer = JSON.stringify([{ question_id: `${next.input.execution_id}:1`, answer: 'basic' }, { question_id: `${next.input.execution_id}:2`, answer: 'basic' }]);
    const continued = JSON.parse(execFileSync(process.execPath, [...prepare, '--answer', secondAnswer], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(continued.input.context.resume_session_id, record.worktree_id);
    assert.equal(continued.answer.length, 2);
    assert.deepEqual(JSON.parse(await readFile(join(resultDir, 'decision-answers.json'), 'utf8')), continued.answer);
    assert.deepEqual(JSON.parse(await readFile(join(tree.session_directory, 'runtime/executions', continued.input.execution_id, 'answers.json'), 'utf8')), continued.answer);
    assert.equal((await stat(join(tree.session_directory, 'runtime/executions', continued.input.execution_id, 'answers.json'))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(resultDir, 'answers.json'), 'utf8')), earlierAnswers);
    const configPath = join(tree.workspace, '.codex/harness.yaml');
    const existingConfig = await readFile(configPath, 'utf8');
    await writeFile(configPath, existingConfig.replace('agents:\n', 'agents:\n  claude-code:\n    high_performance_model: opus\n    high_performance_reasoning_effort: high\n'));
    const { bindOrchestratorSession } = await import(`file://${join(tree.workspace, '.harness/src/workflow/startup-state.mjs')}`);
    const claudeSession = '4c1483d6-c69d-4df3-a6c1-481c7ac4ff44';
    await bindOrchestratorSession({ root: tree.workspace, provider: 'claude-code', sessionId: claudeSession });
    const switched = JSON.parse(execFileSync(process.execPath, [...prepare, '--answer', secondAnswer], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(switched.input.context.provider, 'claude-code');
    assert.equal(switched.input.context.orchestrator_provider, 'claude-code');
    assert.equal(switched.input.context.resume_session_id, undefined, 'a Codex conversation is never resumed in Claude');
    assert.equal(switched.input.context.previous_result_ref, `runtime/executions/${next.input.execution_id}/result.json`);
    assert.deepEqual(switched.answer, continued.answer);
    const { resolveSkillBinding } = await import(`file://${join(tree.workspace, '.harness/src/workflow/skill-execution.mjs')}`);
    assert.equal((await resolveSkillBinding({ root: tree.workspace, skill: 'spec-me', executionProvider: 'claude-code' })).model, 'opus');
    const sessions = JSON.parse(await readFile(join(tree.session_directory, 'worktree.json'), 'utf8')).agent_sessions;
    assert.equal(sessions['orchestrator.claude-code'].session_id, claudeSession);
    assert.equal(sessions['orchestrator.codex'].session_id, record.worktree_id);
    const { recordWorkflowSession: recordProviderSession } = await import(`file://${join(tree.workspace, '.harness/src/workflow/worktrees.mjs')}`);
    await recordProviderSession({ workspace_root: tree.workspace, repository_root: root, key: 'test-stage', session_id: record.worktree_id, execution_id: 'prior-codex', provider: 'codex' });
    await recordProviderSession({ workspace_root: tree.workspace, repository_root: root, key: 'test-stage', session_id: claudeSession, execution_id: 'prior-claude', provider: 'claude-code' });
    const savedSessions = JSON.parse(await readFile(join(tree.session_directory, 'worktree.json'), 'utf8')).agent_sessions;
    assert.equal(savedSessions['test-stage.codex'].session_id, record.worktree_id);
    assert.equal(savedSessions['test-stage.claude-code'].session_id, claudeSession);
    await bindOrchestratorSession({ root: tree.workspace, provider: 'codex', sessionId: record.worktree_id });
    await writeFile(configPath, existingConfig);
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: `runtime/executions/${next.input.execution_id}/result.json` });
    const state = JSON.parse(await readFile(join(tree.session_directory, 'runtime/orchestrator/state.json'), 'utf8'));
    assert.equal(state.current_stage, 'spec-me');
    assert.equal(state.stages['spec-me'].status, 'waiting');
    // The user can redirect a stage waiting on its own question; the instruction replaces the question.
    const redirected = await prepareStageInput({ root: tree.workspace, session: tree.session_directory, worktreeRef: tree.worktree_ref, workflowRef: null, codexSessionId: record.worktree_id, userRevision: true, stageId: 'spec-me', feedback: '기술 결정을 출처를 붙인 후보 비교로 다시 물어봐' });
    assert.equal(redirected.input.context.user_revision, true);
    assert.equal(redirected.input.context.previous_result_ref, `runtime/executions/${next.input.execution_id}/result.json`);
    await rm(join(tree.session_directory, 'runtime/executions', redirected.input.execution_id), { recursive: true, force: true });
    const specResult = { schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: 'completed', code: 'OK', summary: '명세 준비 완료', artifacts: [], questions: [], review_request: null };
    const specRef = `runtime/executions/${next.input.execution_id}/result.json`;
    const sameStageRevision = { ...specResult, status: 'action_required', code: 'SPEC_REVISION_REQUIRED', summary: '리뷰 지적 수정' };
    await writeFile(join(tree.session_directory, specRef), JSON.stringify(sameStageRevision));
    await writeFile(join(tree.session_directory, `runtime/executions/${next.input.execution_id}/return.json`), JSON.stringify({ schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: sameStageRevision.status, code: sameStageRevision.code, result_ref: specRef, result: sameStageRevision }));
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'SPEC_REVISION_REQUIRED', result_ref: specRef });
    const revisionResume = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--feedback', '리뷰 지적을 수정하세요'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(revisionResume.input.context.resume_session_id, record.worktree_id);
    assert.equal(JSON.parse(await readFile(join(tree.session_directory, 'runtime/executions', revisionResume.input.execution_id, 'feedback.json'), 'utf8')).feedback, '리뷰 지적을 수정하세요');
    await writeFile(join(tree.session_directory, specRef), JSON.stringify(specResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${next.input.execution_id}/return.json`), JSON.stringify({ schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: 'completed', code: 'OK', result_ref: specRef, result: specResult }));
    await recordExecutionState({ root: tree.workspace, input: stageInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'completed', code: 'OK', result_ref: specRef });
    const planCommand = [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'to-ticket'];
    assert.throws(() => execFileSync(process.execPath, planCommand, { cwd: tree.workspace, stdio: 'pipe' }), /recorded passing Architecture review/);
    const ticketId = JSON.parse(await readFile(tree.worktree_ref, 'utf8')).plan_set_id;
    const specDir = join(tree.workspace, 'docs/specs', ticketId);
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, 'request.md'), '# request\n');
    await writeFile(join(specDir, 'product-spec.md'), '# Product Spec\n확정된 요구사항\n');
    await writeFile(join(specDir, 'architecture-spec.md'), '# Architecture Spec\n확정된 설계\n');
    const approved = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--spec-overwrite-approved', 'true'], { cwd: tree.workspace, encoding: 'utf8' }));
    for (const axis of ['product', 'architecture']) assert.equal(approved.input.context.approved_spec_overwrites[axis], createHash('sha256').update(await readFile(join(specDir, `${axis}-spec.md`))).digest('hex'));
    const { snapshotSpecReview } = await import(`file://${join(tree.workspace, '.harness/src/workflow/spec-review.mjs')}`);
    const { updateReviewAttempt } = await import(`file://${join(tree.workspace, '.harness/src/workflow/review-attempts.mjs')}`);
    const inputs = await snapshotSpecReview({ root: tree.workspace, ticketId });
    const scope = `spec-${ticketId}-architecture`;
    const admitted = await updateReviewAttempt({ root: tree.workspace, scope, action: 'begin', inputs });
    const architectureReview = { axis: 'architecture', ticket_id: ticketId, reviewer_id: 'reviewer', author_ids: ['writer'], fork_turns: 'none', verdict: 'pass', inputs, findings: [] };
    await updateReviewAttempt({ root: tree.workspace, scope, action: 'record', attemptId: admitted.attempt_id, inputs, review: architectureReview });
    const { validateSkillReturn } = await import(`file://${join(tree.workspace, '.harness/src/workflow/skill-execution.mjs')}`);
    const specEnvelope = { schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: 'completed', code: 'OK', result_ref: specRef, result: specResult };
    await validateSkillReturn({ root: tree.workspace, input: stageInput.input, envelope: specEnvelope });
    const invalidRevision = { ...specResult, status: 'action_required', code: 'IMPLEMENTATION_REVISION_REQUIRED' };
    await assert.rejects(validateSkillReturn({ root: tree.workspace, input: stageInput.input, envelope: { ...specEnvelope, status: invalidRevision.status, code: invalidRevision.code, result: invalidRevision } }), /spec-me cannot request implementation revision/);
    const architecturePath = join(specDir, 'architecture-spec.md');
    const reviewedSpec = await readFile(architecturePath, 'utf8');
    await writeFile(architecturePath, `${reviewedSpec}\n변경됨\n`);
    await assert.rejects(validateSkillReturn({ root: tree.workspace, input: stageInput.input, envelope: specEnvelope }), /Architecture review is not current/);
    assert.throws(() => execFileSync(process.execPath, planCommand, { cwd: tree.workspace, stdio: 'pipe' }), /Architecture review is not current/);
    await writeFile(architecturePath, reviewedSpec);
    assert.throws(() => execFileSync(process.execPath, [...planCommand, '--feedback', '허용되지 않는 전환 피드백'], { cwd: tree.workspace, stdio: 'pipe' }), /Feedback requires/);
    const plan = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'to-ticket'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(plan.input.context.transition.from_stage, 'spec-me');
    assert.equal(plan.input.context.transition.result_ref, specRef);
    const planInput = await findExecutionInput(tree.workspace, plan.input.execution_id);
    await recordExecutionState({ root: tree.workspace, input: planInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    const planRef = `runtime/executions/${plan.input.execution_id}/result.json`;
    const planResult = { schema_version: 1, execution_id: plan.input.execution_id, skill: 'to-ticket', status: 'action_required', code: 'SPEC_REVISION_REQUIRED', summary: '수용 조건 보완 필요', artifacts: [], questions: [], review_request: null };
    await writeFile(join(tree.session_directory, planRef), JSON.stringify(planResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${plan.input.execution_id}/return.json`), JSON.stringify({ schema_version: 1, execution_id: plan.input.execution_id, skill: 'to-ticket', status: 'action_required', code: 'SPEC_REVISION_REQUIRED', result_ref: planRef, result: planResult }));
    await recordExecutionState({ root: tree.workspace, input: planInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'SPEC_REVISION_REQUIRED', result_ref: planRef });
    const revision = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'spec-me', '--feedback', '수용 조건 보완'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(revision.input.context.transition.code, 'SPEC_REVISION_REQUIRED');
    assert.equal(revision.input.context.transition.result_ref, planRef);
    assert.equal(revision.input.context.previous_result_ref, planRef);
    assert.equal(revision.input.context.resume_session_id, record.worktree_id);
    const revisionInput = await findExecutionInput(tree.workspace, revision.input.execution_id);
    await recordExecutionState({ root: tree.workspace, input: revisionInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    const revisionRef = `runtime/executions/${revision.input.execution_id}/result.json`;
    const revisionResult = { schema_version: 1, execution_id: revision.input.execution_id, skill: 'spec-me', status: 'action_required', code: 'PLAN_REVISION_REQUIRED', summary: '계획 세분화 필요', artifacts: [], questions: [], review_request: null };
    await writeFile(join(tree.session_directory, revisionRef), JSON.stringify(revisionResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${revision.input.execution_id}/return.json`), JSON.stringify({ schema_version: 1, execution_id: revision.input.execution_id, skill: 'spec-me', status: 'action_required', code: 'PLAN_REVISION_REQUIRED', result_ref: revisionRef, result: revisionResult }));
    await recordExecutionState({ root: tree.workspace, input: revisionInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'PLAN_REVISION_REQUIRED', result_ref: revisionRef });
    const replan = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'to-ticket'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(replan.input.context.transition.code, 'PLAN_REVISION_REQUIRED');
    assert.equal(replan.input.context.transition.result_ref, revisionRef);
    const replanInput = await findExecutionInput(tree.workspace, replan.input.execution_id);
    await recordExecutionState({ root: tree.workspace, input: replanInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    const question = { question_id: `${replan.input.execution_id}:1`, title: '계획을 선택하세요', options: [{ id: 'a', label: 'A', consequence: 'A 적용' }, { id: 'b', label: 'B', consequence: 'B 적용' }], recommended_option_id: 'a', rationale: '테스트' };
    const waitingRef = `runtime/executions/${replan.input.execution_id}/result.json`;
    const waitingResult = { schema_version: 1, execution_id: replan.input.execution_id, skill: 'to-ticket', status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '사용자 선택 필요', artifacts: [], questions: [question], review_request: null };
    await writeFile(join(tree.session_directory, waitingRef), JSON.stringify(waitingResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${replan.input.execution_id}/return.json`), JSON.stringify({ schema_version: 1, execution_id: replan.input.execution_id, skill: 'to-ticket', status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: waitingRef, result: waitingResult }));
    await writeFile(join(tree.session_directory, `runtime/executions/${replan.input.execution_id}/exec.stderr.json`), JSON.stringify({ thread_id: record.worktree_id }));
    await recordExecutionState({ root: tree.workspace, input: replanInput.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'action_required', code: 'USER_DECISION_REQUIRED', result_ref: waitingRef });
    const resumed = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', join(tree.session_directory, 'worktree.json'), '--stage-id', 'to-ticket', '--answer', 'a'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(resumed.input.context.resume_session_id, record.worktree_id);
    assert.equal(resumed.answer[0].question_id, `${replan.input.execution_id}:1`);
    const authorInput = await readExecutionInput({ root: tree.workspace, execution_id: resumed.input.execution_id });
    await recordExecutionState({ root: tree.workspace, input: authorInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    const planDir = join(tree.workspace, 'docs/plans', ticketId);
    await mkdir(planDir, { recursive: true });
    await writeFile(join(planDir, 'plans.md'), '# Plans\n');
    await writeFile(join(planDir, 'slice.md'), '---\nstatus: planned\n---\n# Slice\n`calculator-community-e2e`\n');
    const { updatePlanReview } = await import(`file://${join(tree.workspace, '.harness/src/workflow/plan-review.mjs')}`);
    const savedEnvironment = Object.fromEntries(['HARNESS_WORKSPACE_ROOT', 'HARNESS_SKILL_EXECUTION_ID'].map((key) => [key, process.env[key]]));
    let reviewedResult, reviewedEnvelope, reviewRef, validateReviewedPlanReturn;
    try {
      process.env.HARNESS_WORKSPACE_ROOT = tree.workspace;
      process.env.HARNESS_SKILL_EXECUTION_ID = authorInput.execution_id;
      const planAdmission = await updatePlanReview({ root: tree.workspace, planSetId: ticketId, action: 'begin' });
      await readFile(join(tree.session_directory, 'runtime/reviews', `plan-${ticketId}.json`));
      await assert.rejects(readFile(join(root, '.io/runtime/reviews', `plan-${ticketId}.json`)), { code: 'ENOENT' });
      reviewRef = `runtime/executions/${authorInput.execution_id}/result.json`;
      reviewedResult = { schema_version: 1, execution_id: authorInput.execution_id, skill: 'to-ticket', status: 'completed', code: 'OK', summary: '계획 작성 및 독립 리뷰 완료', artifacts: [{ base: 'workspace', path: `docs/plans/${ticketId}/slice.md`, kind: 'split-plan', sha256: createHash('sha256').update(await readFile(join(planDir, 'slice.md'))).digest('hex') }], questions: [], review_request: null };
      reviewedEnvelope = { schema_version: 1, execution_id: authorInput.execution_id, skill: 'to-ticket', status: 'completed', code: 'OK', result_ref: reviewRef, result: reviewedResult };
      ({ validateSkillReturn: validateReviewedPlanReturn } = await import(`file://${join(tree.workspace, '.harness/src/workflow/skill-execution.mjs')}`));
      await assert.rejects(validateReviewedPlanReturn({ root: tree.workspace, input: authorInput, envelope: reviewedEnvelope }), /current passing independent plan review/i);
      const reviewHandoff = { ...reviewedResult, status: 'action_required', code: 'REVIEW_REQUIRED' };
      await assert.rejects(validateReviewedPlanReturn({ root: tree.workspace, input: authorInput, envelope: { ...reviewedEnvelope, status: 'action_required', code: 'REVIEW_REQUIRED', result: reviewHandoff } }), /complete its independent plan-review loop internally/i);
      await bindNativeReviewer({ root: tree.workspace, scope: `plan-${ticketId}`, attemptId: planAdmission.attempt_id, executionId: authorInput.execution_id, reviewerId: 'plan-reviewer', parentSessionId: 'plan-author' });
      await updatePlanReview({ root: tree.workspace, planSetId: ticketId, action: 'record', attemptId: planAdmission.attempt_id, review: { reviewer_id: 'plan-reviewer', author_ids: ['plan-author'], fork_turns: 'none', verdict: 'pass', inputs: planAdmission.inputs, findings: [] } });
    } finally {
      for (const [key, value] of Object.entries(savedEnvironment)) value === undefined ? delete process.env[key] : process.env[key] = value;
    }
    await writeFile(join(tree.session_directory, reviewRef), JSON.stringify(reviewedResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${authorInput.execution_id}/return.json`), JSON.stringify(reviewedEnvelope));
    assert.equal((await validateReviewedPlanReturn({ root: tree.workspace, input: authorInput, envelope: reviewedEnvelope })).valid, true);
    // In GitHub mode the same reviewed result cannot complete without the saved Issue drafts.
    const yamlPath = join(tree.workspace, '.codex/harness.yaml');
    const originalYaml = await readFile(yamlPath, 'utf8');
    await writeFile(yamlPath, `${originalYaml}\ntracker:\n  mode: github\n`);
    await assert.rejects(validateReviewedPlanReturn({ root: tree.workspace, input: authorInput, envelope: reviewedEnvelope }), /must save a GitHub Issue draft.*runtime\/to-ticket\/drafts\/parent\.md/);
    const draftsDirectory = join(tree.session_directory, 'runtime/to-ticket/drafts');
    // Reopening the completed result for a user revision must not demand the drafts it is about to create.
    assert.equal((await validateReviewedPlanReturn({ root: tree.workspace, input: authorInput, envelope: reviewedEnvelope, reopening: true })).valid, true);
    await mkdir(draftsDirectory, { recursive: true });
    for (const name of ['parent', 'slice']) await writeFile(join(draftsDirectory, `${name}.md`), `# ${name}\n`);
    assert.equal((await validateReviewedPlanReturn({ root: tree.workspace, input: authorInput, envelope: reviewedEnvelope })).valid, true);
    await writeFile(yamlPath, originalYaml);
    await recordExecutionState({ root: tree.workspace, input: authorInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'completed', code: 'OK', result_ref: reviewRef });
    await mkdir(join(tree.session_directory, 'runtime/to-ticket/drafts'), { recursive: true });
    for (const name of ['parent', 'slice']) await writeFile(join(tree.session_directory, `runtime/to-ticket/drafts/${name}.md`), `# ${name}\n`);
    // The orchestrator assigns the plan: a new implement-wrapper run without one, or with a plan outside the set, is refused.
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'implement-wrapper'], { cwd: tree.workspace, stdio: 'pipe' }), /needs --plan/);
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'implement-wrapper', '--plan', 'nope'], { cwd: tree.workspace, stdio: 'pipe' }), /not part of plan set/);
    let implementation = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'implement-wrapper', '--plan', 'slice'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(implementation.input.context.plan_id, 'slice');
    assert.equal(implementation.input.context.checkpoint_path, join(tree.session_directory, 'runtime/plans/slice/checkpoint.md'));
    const blockedRef = `runtime/executions/${implementation.input.execution_id}/result.json`;
    const blockedResult = { schema_version: 1, execution_id: implementation.input.execution_id, skill: 'implement-wrapper', status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: '계획 발행 후 구현을 시작할 수 있습니다.', artifacts: [], questions: [], review_request: null, unplanned_additions: [], commit_request: null };
    const blockedEnvelope = { schema_version: 1, execution_id: implementation.input.execution_id, skill: 'implement-wrapper', status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', result_ref: blockedRef, result: blockedResult };
    await writeFile(join(tree.session_directory, blockedRef), JSON.stringify(blockedResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${implementation.input.execution_id}/return.json`), JSON.stringify(blockedEnvelope));
    await recordExecutionState({ root: tree.workspace, input: implementation.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: implementation.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', result_ref: blockedRef });
    const { validateSkillReturn: validateImplementationReturn } = await import(`file://${join(tree.workspace, '.harness/src/workflow/skill-execution.mjs')}`);
    await validateImplementationReturn({ root: tree.workspace, input: implementation.input, envelope: blockedEnvelope });
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'tracker-publish'], { cwd: tree.workspace, encoding: 'utf8' }), /user publication approval are required/);
    const blockedStatePath = join(tree.session_directory, 'runtime/orchestrator/state.json');
    const blockedState = JSON.parse(await readFile(blockedStatePath, 'utf8'));
    blockedState.stages['implement-wrapper'].code = 'ENVIRONMENT_UNAVAILABLE';
    await writeFile(blockedStatePath, JSON.stringify(blockedState));
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'tracker-publish', '--publication-approved', 'true'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'to-ticket', '--feedback', 'draft 누락을 복구하세요.', '--user-revision', 'true'], { cwd: tree.workspace, encoding: 'utf8' }));
    blockedState.stages['implement-wrapper'].code = 'DEPENDENCY_INCOMPLETE';
    await writeFile(blockedStatePath, JSON.stringify(blockedState));
    const planRevision = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'to-ticket', '--feedback', '누락된 GitHub 초안을 정본 session 경로에 생성하세요.', '--user-revision', 'true'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(planRevision.input.context.user_revision, true);
    assert.equal(planRevision.input.context.previous_result_ref, reviewRef);
    assert.equal(JSON.parse(await readFile(blockedStatePath, 'utf8')).stages['to-ticket'].status, 'completed');
    const publisher = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'tracker-publish', '--publication-approved', 'true'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(publisher.input.context.transition.from_stage, 'to-ticket');
    assert.deepEqual(publisher.input.context.execution_workspace, { workspace_root: tree.workspace, workspace_branch: worktreeRecord.branch });
    assert.equal(publisher.input.context.publication_drafts.length, 2);
    const publisherInput = await readExecutionInput({ root: tree.workspace, execution_id: publisher.input.execution_id });
    await recordExecutionState({ root: tree.workspace, input: publisherInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    const publishingState = JSON.parse(await readFile(blockedStatePath, 'utf8'));
    publishingState.current_stage = 'implement-wrapper';
    await writeFile(blockedStatePath, JSON.stringify(publishingState));
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'to-ticket', '--feedback', 'draft 누락을 복구하세요.', '--user-revision', 'true'], { cwd: tree.workspace, encoding: 'utf8' }));
    publishingState.current_stage = 'tracker-publish';
    await writeFile(blockedStatePath, JSON.stringify(publishingState));
    const publisherRef = `runtime/executions/${publisherInput.execution_id}/result.json`;
    const publisherResult = { schema_version: 1, execution_id: publisherInput.execution_id, skill: 'tracker-publish', status: 'completed', code: 'OK', summary: '발행 완료', artifacts: [], questions: [], review_request: null };
    await writeFile(join(tree.session_directory, publisherRef), JSON.stringify(publisherResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${publisherInput.execution_id}/return.json`), JSON.stringify({ schema_version: 1, execution_id: publisherInput.execution_id, skill: 'tracker-publish', status: 'completed', code: 'OK', result_ref: publisherRef, result: publisherResult }));
    await recordExecutionState({ root: tree.workspace, input: publisherInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'completed', code: 'OK', result_ref: publisherRef });
    specResult.artifacts = await Promise.all(['product', 'architecture'].map(async (axis) => ({ base: 'workspace', path: `docs/specs/${ticketId}/${axis}-spec.md`, kind: `${axis}-spec`, sha256: createHash('sha256').update(await readFile(join(specDir, `${axis}-spec.md`))).digest('hex') })));
    await writeFile(join(tree.session_directory, specRef), JSON.stringify(specResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${next.input.execution_id}/return.json`), JSON.stringify(specEnvelope));
    const implementationStatePath = join(tree.session_directory, 'runtime/orchestrator/state.json');
    const implementationState = JSON.parse(await readFile(implementationStatePath, 'utf8'));
    implementationState.stages['spec-me'] = { ...implementationState.stages['spec-me'], status: 'completed', code: 'OK', execution_id: next.input.execution_id, result_ref: specRef };
    await writeFile(implementationStatePath, JSON.stringify(implementationState));
    implementation = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'implement-wrapper', '--plan', 'slice'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.ok(implementation.input.input_refs.some((item) => item.path === `docs/plans/${ticketId}/slice.md`));
    for (const axis of ['product', 'architecture']) assert.ok(implementation.input.input_refs.some((item) => item.path === `docs/specs/${ticketId}/${axis}-spec.md`));
    assert.equal(implementation.input.context.producer_result_refs['to-ticket'].path, reviewRef);
    const implementationRef = `runtime/executions/${implementation.input.execution_id}/result.json`;
    const implementationResult = { schema_version: 1, execution_id: implementation.input.execution_id, skill: 'implement-wrapper', status: 'completed', code: 'OK', summary: 'Done', artifacts: [], questions: [], review_request: null, unplanned_additions: [], commit_request: null };
    await writeFile(join(tree.session_directory, implementationRef), JSON.stringify(implementationResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${implementation.input.execution_id}/return.json`), JSON.stringify({ schema_version: 1, execution_id: implementation.input.execution_id, skill: 'implement-wrapper', status: 'completed', code: 'OK', result_ref: implementationRef, result: implementationResult }));
    await writeFile(join(tree.session_directory, `runtime/executions/${implementation.input.execution_id}/exec.stderr.json`), JSON.stringify({ thread_id: record.worktree_id }));
    await recordExecutionState({ root: tree.workspace, input: implementation.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: implementation.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'completed', code: 'OK', result_ref: implementationRef });
    const receiptRef = 'runtime/execution/failure-1/receipt.json';
    await mkdir(join(tree.session_directory, 'runtime/execution/failure-1'), { recursive: true });
    const profilePath = join(tree.workspace, 'docs/agents/execution.json');
    await mkdir(join(tree.workspace, 'docs/agents'), { recursive: true });
    const previousProfile = await readFile(profilePath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    const profileContent = JSON.stringify({ profiles: { 'calculator-community-e2e': { purpose: 'e2e', timeout_ms: 300000 } } });
    await writeFile(profilePath, profileContent);
    await writeFile(join(tree.session_directory, receiptRef), JSON.stringify({ status: 'blocked', profile_id: 'calculator-community-e2e', finished_at: '2026-01-01T00:00:00Z', config_hashes: { 'docs/agents/execution.json': createHash('sha256').update(profileContent).digest('hex') } }));
    await writeFile(join(tree.session_directory, 'runtime/reviews/implementation-slice-evidence.json'), JSON.stringify({ review_input: { implementation_commit_sha: git('rev-parse', 'HEAD').trim() } }));
    await writeFile(join(tree.session_directory, 'runtime/orchestrator/user-inputs.jsonl'), JSON.stringify({ at: '2026-01-02T00:00:00Z', session_id: record.worktree_id, text: '승인' }) + '\n');
    const revisionArgs = [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'implement-wrapper', '--plan', 'slice', '--user-revision', 'true', '--feedback', '설정을 수정하세요', '--repair-receipt', receiptRef, '--approval-answer', '승인'];
    assert.throws(() => execFileSync(process.execPath, [...revisionArgs.slice(0, -1), '네'], { cwd: tree.workspace, stdio: 'pipe' }), /approval was not recorded/);
    const implementationRevision = JSON.parse(execFileSync(process.execPath, revisionArgs, { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(implementationRevision.input.context.plan_id, 'slice');
    assert.equal(implementationRevision.input.context.e2e_failure_receipt, receiptRef);
    assert.equal(implementationRevision.input.context.resume_session_id, record.worktree_id);
    assert.equal(JSON.parse(await readFile(join(tree.session_directory, 'runtime/executions', implementationRevision.input.execution_id, 'feedback.json'), 'utf8')).feedback, '설정을 수정하세요');
    await writeFile(join(tree.session_directory, 'runtime/reviews/implementation-slice-evidence.json'), JSON.stringify({ review_input: { implementation_commit_sha: '0'.repeat(40) } }));
    assert.throws(() => execFileSync(process.execPath, revisionArgs, { cwd: tree.workspace, stdio: 'pipe' }), /target commit is stale/);
    await writeFile(join(tree.session_directory, 'runtime/reviews/implementation-slice-evidence.json'), JSON.stringify({ review_input: { implementation_commit_sha: git('rev-parse', 'HEAD').trim() } }));
    const e2eRequestRef = 'runtime/e2e/requests/test.json';
    await mkdir(join(tree.session_directory, 'runtime/e2e/requests'), { recursive: true });
    const e2eRequest = { target_commit: git('rev-parse', 'HEAD').trim(), profile_id: 'calculator-community-e2e', timeout_ms: 300000, scenarios: ['E2E-01'], approval_answer: '승인', manifest_sha256: createHash('sha256').update(profileContent).digest('hex') };
    await writeFile(join(tree.session_directory, e2eRequestRef), JSON.stringify(e2eRequest));
    const e2eArgs = [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'e2e-test'];
    assert.throws(() => execFileSync(process.execPath, e2eArgs, { cwd: tree.workspace, stdio: 'pipe' }), /requires an approved request/);
    const e2e = JSON.parse(execFileSync(process.execPath, [...e2eArgs, '--e2e-request', e2eRequestRef], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(e2e.input.context.agent_profile, 'e2e_test_runner');
    assert.equal(e2e.input.input_refs.find((item) => item.kind === 'approved_e2e_request').path, e2eRequestRef);
    await writeFile(join(tree.session_directory, e2eRequestRef), JSON.stringify({ ...e2eRequest, target_commit: '0'.repeat(40) }));
    assert.throws(() => execFileSync(process.execPath, [...e2eArgs, '--e2e-request', e2eRequestRef], { cwd: tree.workspace, stdio: 'pipe' }), /E2E request target/);
    await writeFile(join(tree.session_directory, e2eRequestRef), JSON.stringify({ ...e2eRequest, manifest_sha256: '0'.repeat(64) }));
    assert.throws(() => execFileSync(process.execPath, [...e2eArgs, '--e2e-request', e2eRequestRef], { cwd: tree.workspace, stdio: 'pipe' }), /execution profile has changed/);
    const fastReceiptRef = 'runtime/execution/failure-2/receipt.json';
    const fastFailureRef = 'runtime/e2e/run-2/failure.json';
    const fastReceipt = { status: 'failed', phase: 'command', profile_id: 'calculator-community-e2e', head: git('rev-parse', 'HEAD').trim(), started_at: '2026-01-03T00:00:00Z', finished_at: '2026-01-03T00:01:00Z', config_hashes: { 'docs/agents/execution.json': createHash('sha256').update(profileContent).digest('hex') } };
    await mkdir(join(tree.session_directory, 'runtime/execution/failure-2'), { recursive: true });
    await mkdir(join(tree.session_directory, 'runtime/e2e/run-2'), { recursive: true });
    await writeFile(join(tree.session_directory, fastReceiptRef), JSON.stringify(fastReceipt));
    await writeFile(join(tree.session_directory, 'runtime/e2e/run-2/receipt.json'), JSON.stringify(fastReceipt));
    await writeFile(join(tree.session_directory, fastFailureRef), JSON.stringify({ status: 'failed', profile_id: fastReceipt.profile_id, target_commit: fastReceipt.head, failures: [{ scenario: 'E2E-01', observed: 'Comment is visible' }] }));
    const fastArgs = [...revisionArgs.slice(0, -4), '--repair-receipt', fastReceiptRef, '--approval-answer', '승인', '--test-defect-failure', fastFailureRef];
    const fast = JSON.parse(execFileSync(process.execPath, fastArgs, { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(fast.input.context.e2e_test_defect_failure, fastFailureRef);
    await writeFile(join(tree.session_directory, e2eRequestRef), JSON.stringify(e2eRequest));
    const stateBeforeE2e = await readFile(implementationStatePath, 'utf8');
    const e2eRef = `runtime/executions/${e2e.input.execution_id}/result.json`;
    const artifactHash = async (path) => createHash('sha256').update(await readFile(join(tree.session_directory, path))).digest('hex');
    const e2eResult = { schema_version: 1, execution_id: e2e.input.execution_id, skill: 'e2e-test', status: 'failed', code: 'EXECUTION_ERROR', summary: 'E2E failed', artifacts: [{ base: 'session', path: fastReceiptRef, kind: 'e2e_receipt', sha256: await artifactHash(fastReceiptRef) }, { base: 'session', path: fastFailureRef, kind: 'e2e_failure', sha256: await artifactHash(fastFailureRef) }], questions: [], review_request: null };
    await writeFile(join(tree.session_directory, e2eRef), JSON.stringify(e2eResult));
    await writeFile(join(tree.session_directory, `runtime/executions/${e2e.input.execution_id}/return.json`), JSON.stringify({ schema_version: 1, execution_id: e2e.input.execution_id, skill: 'e2e-test', status: 'failed', code: 'EXECUTION_ERROR', result_ref: e2eRef, result: e2eResult }));
    await recordExecutionState({ root: tree.workspace, input: e2e.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await recordExecutionState({ root: tree.workspace, input: e2e.input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'failed', code: 'EXECUTION_ERROR', result_ref: e2eRef });
    const afterStageFailure = JSON.parse(execFileSync(process.execPath, fastArgs, { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(afterStageFailure.input.context.e2e_test_defect_failure, fastFailureRef);
    await writeFile(implementationStatePath, stateBeforeE2e);
    await writeFile(join(tree.session_directory, 'runtime/e2e/run-2/receipt.json'), JSON.stringify({ ...fastReceipt, profile_id: 'other' }));
    assert.throws(() => execFileSync(process.execPath, fastArgs, { cwd: tree.workspace, stdio: 'pipe' }), /does not match the failed E2E run/);
    await writeFile(profilePath, '{"changed":true}');
    assert.throws(() => execFileSync(process.execPath, revisionArgs, { cwd: tree.workspace, stdio: 'pipe' }), /receipt is stale/);
    if (previousProfile === null) await rm(profilePath); else await writeFile(profilePath, previousProfile);
    assert.equal(JSON.parse(await readFile(join(tree.session_directory, 'runtime/orchestrator/state.json'), 'utf8')).stages['to-ticket'].status, 'completed');
    await assert.rejects(readFile(join(tree.session_directory, 'runtime/orchestrator/workflow.json')), { code: 'ENOENT' });
    assert.match(git('ls-tree', '-r', '--name-only', 'HEAD'), /CONTEXT.md/);
    const status = git('status', '--short');
    assert.equal(status, '');
    git('check-ignore', '-v', '.codex/scripts/harness-compose-workspace.mjs');
    const statePath = join(tree.session_directory, 'runtime/orchestrator/state.json');
    const failedState = JSON.parse(await readFile(statePath, 'utf8'));
    failedState.current_stage = 'spec-me';
    failedState.status = 'failed';
    failedState.stages['spec-me'] = { status: 'failed', execution_id: next.input.execution_id, skill: 'spec-me', code: 'EXECUTION_ERROR', result_ref: null, reason: 'Result execution_id mismatch' };
    await writeFile(statePath, JSON.stringify(failedState));
    const failedPrefix = join(tree.session_directory, 'runtime/executions', next.input.execution_id);
    const invalidResult = { schema_version: 1, execution_id: 'spec-me-invalid-id', skill: 'spec-me', status: 'failed', code: 'ARTIFACT_WRITE_FAILED', summary: '재생성 필요', artifacts: [], questions: [], review_request: null };
    const invalidEnvelope = { schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: 'failed', code: 'ARTIFACT_WRITE_FAILED', result_ref: null, result: invalidResult };
    await writeFile(join(failedPrefix, 'codex-last-message.json'), JSON.stringify(invalidEnvelope));
    await writeFile(join(failedPrefix, 'exec.stderr.json'), JSON.stringify({ provider: 'codex', exit_code: 0, session_id: record.worktree_id, thread_id: record.worktree_id }));
    const repair = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--feedback', '반환 최상위와 중첩 execution_id를 일치시켜 다시 반환하세요.'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(repair.input.context.resume_session_id, record.worktree_id);
    assert.equal(JSON.parse(await readFile(join(tree.session_directory, 'runtime/executions', repair.input.execution_id, 'feedback.json'), 'utf8')).feedback, '반환 최상위와 중첩 execution_id를 일치시켜 다시 반환하세요.');
    failedState.stages['spec-me'].reason = 'Return status/code mismatch';
    await writeFile(statePath, JSON.stringify(failedState));
    const rejectedRevision = { ...invalidResult, execution_id: next.input.execution_id, status: 'blocked', code: 'SPEC_REVISION_REQUIRED' };
    const rawRevision = { schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: rejectedRevision.status, code: rejectedRevision.code, result: rejectedRevision };
    const rawPath = join(failedPrefix, 'codex-last-message.json');
    await writeFile(rawPath, JSON.stringify(rawRevision));
    const revisionRepair = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--feedback', '상태와 코드를 계약에 맞게 반환하세요.'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(revisionRepair.input.context.resume_session_id, record.worktree_id);
    assert.deepEqual(JSON.parse(await readFile(rawPath, 'utf8')), rawRevision);
    failedState.stages['spec-me'].owner = await processIdentity(process.pid);
    await writeFile(statePath, JSON.stringify(failedState));
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--feedback', '재개'], { cwd: tree.workspace, stdio: 'pipe' }));
    delete failedState.stages['spec-me'].owner;
    failedState.stages['spec-me'].reason = 'Stage provider exited with code 1';
    await writeFile(statePath, JSON.stringify(failedState));
    await writeFile(join(failedPrefix, 'exec.stderr.json'), JSON.stringify({ provider: 'codex', exit_code: 1, session_id: record.worktree_id, thread_id: record.worktree_id }));
    const failedResume = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--feedback', '재개'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(failedResume.input.context.resume_session_id, record.worktree_id);
    const preservedReturn = { schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: 'action_required', code: 'PLAN_REVISION_REQUIRED', summary: '계획 수정', artifacts: [], questions: [], review_request: null };
    await writeFile(join(resultDir, 'result.json'), JSON.stringify(preservedReturn));
    await writeFile(join(resultDir, 'return.json'), JSON.stringify({ schema_version: 1, execution_id: next.input.execution_id, skill: 'spec-me', status: 'action_required', code: 'PLAN_REVISION_REQUIRED', result_ref: `runtime/executions/${next.input.execution_id}/result.json`, result: preservedReturn }));
    const failedResumeInput = await readExecutionInput({ root: tree.workspace, execution_id: failedResume.input.execution_id });
    await recordExecutionState({ root: tree.workspace, input: failedResumeInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    await writeFile(join(tree.session_directory, 'runtime/executions', failedResume.input.execution_id, 'exec.stderr.json'), JSON.stringify({ exit_code: 1, session_id: record.worktree_id, thread_id: record.worktree_id }));
    await recordExecutionState({ root: tree.workspace, input: failedResumeInput, binding: { model: 'example', reasoning_effort: 'low' }, status: 'failed', code: 'EXECUTION_ERROR', reason: 'resume failed' });
    const recovered = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-execution-state.mjs'), '--root', tree.workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', failedResume.input.execution_id, '--recover-from-execution-id', next.input.execution_id], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(recovered.stages['spec-me'].execution_id, next.input.execution_id);
    assert.equal(recovered.stages['spec-me'].status, 'waiting');
    assert.ok(recovered.stages['spec-me'].attempts.some((attempt) => attempt.execution_id === failedResume.input.execution_id && attempt.status === 'failed'));
    const mismatchRecovery = spawnSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-execution-state.mjs'), '--root', tree.workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', failedResume.input.execution_id, '--recover-from-execution-id', 'missing-execution'], { cwd: tree.workspace, encoding: 'utf8' });
    assert.notEqual(mismatchRecovery.status, 0);
    await writeFile(join(failedPrefix, 'exec.stderr.json'), JSON.stringify({ provider: 'codex', exit_code: 1, session_id: 'invalid', thread_id: 'invalid' }));
    const missingSessionRecord = JSON.parse(await readFile(tree.worktree_ref, 'utf8'));
    delete missingSessionRecord.agent_sessions;
    await writeFile(tree.worktree_ref, JSON.stringify(missingSessionRecord));
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', tree.worktree_ref, '--stage-id', 'spec-me', '--feedback', '재개'], { cwd: tree.workspace, stdio: 'pipe' }));
  } finally {
    if (secondTree) await finishWorkflowWorktree({ workspace_root: secondTree.workspace, repository_root: root });
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
    await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  provider: codex\n  codex:\n    high_performance_model: gpt-6-luna\n    high_performance_reasoning_effort: medium\n    low_performance_model: gpt-6-luna-mini\n    low_performance_reasoning_effort: medium\n');
    git('add', 'application.txt', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs', '.harness/contracts.mjs');
    git('-c', 'user.name=Contract', '-c', 'user.email=contract@example.test', 'commit', '-m', 'Application');
    const workflowBinding = { provider: 'codex', model: 'gpt-6-luna', reasoning_effort: 'medium' };
    // A binding for a different provider than the current orchestrator is refused before creating a worktree.
    const claudeConfig = await readFile(join(root, '.codex/harness.yaml'), 'utf8');
    await writeFile(join(root, '.codex/harness.yaml'), 'agents:\n  provider: claude-code\n  claude-code:\n    high_performance_model: haiku\n    high_performance_reasoning_effort: medium\n    low_performance_model: haiku\n    low_performance_reasoning_effort: medium\n');
    const mixed = spawnSync(process.execPath, [join(root, '.codex/scripts/harness-compose-workspace.mjs'), '--root', root, '--plan-set-id', 'calculator-web-app', '--request', '작은 계산기 웹 앱', '--execution-id', 'compose-mixed', '--orchestrator-provider', 'claude-code', '--orchestrator-session-id', record.worktree_id], { cwd: root, encoding: 'utf8', env: { ...process.env, HARNESS_WORKFLOW_BINDING: JSON.stringify(workflowBinding) } });
    assert.notEqual(mixed.status, 0);
    assert.match(mixed.stderr, /Workflow binding provider must match the current orchestrator provider/);
    assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: root, encoding: 'utf8' }).trim().split('\n').length, 1);
    await writeFile(join(root, '.codex/harness.yaml'), claudeConfig);
    tree = JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-compose-workspace.mjs'), '--root', root, '--plan-set-id', 'calculator-web-app', '--request', '작은 계산기 웹 앱', '--execution-id', 'compose-1', '--orchestrator-provider', 'codex', '--orchestrator-session-id', record.worktree_id], { cwd: root, encoding: 'utf8', env: { ...process.env, HARNESS_WORKFLOW_BINDING: JSON.stringify(workflowBinding) } }));
    assert.deepEqual(tree.workflow_binding, workflowBinding);
    const found = await findExecutionInput(tree.workspace, 'compose-1');
    assert.equal(found.workspace, tree.workspace);
    assert.equal(found.input.workspace_root, undefined);
    assert.equal(found.input.session_directory, undefined);
    assert.equal(found.input.context.codex_session_id, undefined);
    assert.equal(found.input.context.orchestrator_provider, 'codex');
    assert.equal(found.input.context.orchestrator_session_id, record.worktree_id);
    assert.equal(found.input.scope, '작은 계산기 웹 앱');
    assert.equal(found.input.context.control_session_directory, undefined);
    assert.deepEqual(found.input.input_refs, []);
    const { resolveSkillSession, validateSkillInput, validateSkillReturn, resolveSkillBinding } = await import(`file://${join(tree.workspace, '.harness/src/workflow/skill-execution.mjs')}`);
    await validateSkillInput({ root: tree.workspace, input: found.input });
    await assert.rejects(validateSkillInput({ root: tree.workspace, input: { ...found.input, context: { worktree_ref: found.input.context.worktree_ref } } }), /required/);
    const foreign = join(parent, 'foreign');
    await mkdir(foreign);
    execFileSync('git', ['init', '-q', foreign]);
    await mkdir(join(foreign, '.io'));
    await assert.rejects(resolveSkillSession(tree.workspace, join(foreign, '.io')), /must share the workspace Git common directory/);
    const result = { schema_version: 1, execution_id: 'compose-1', skill: 'workflow-compose', status: 'completed', code: 'OK', summary: '준비 완료', artifacts: [], worktree_ref: join(tree.session_directory, 'worktree.json'), questions: [] };
    const envelope = { schema_version: 1, execution_id: 'compose-1', skill: 'workflow-compose', status: 'completed', code: 'OK', result_ref: 'runtime/executions/compose-1/result.json', result };
    assert.equal((await validateSkillReturn({ root: tree.workspace, input: found.input, envelope })).valid, true);
    const next = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--worktree-ref', result.worktree_ref, '--stage-id', 'spec-me'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(next.input.context.orchestrator_provider, 'codex');
    assert.equal(next.input.context.provider, workflowBinding.provider);
    assert.deepEqual(next.input.context.workflow_binding, workflowBinding);
    // A sub-agent's model is asked for through the binding command, never carried in the stage input.
    assert.equal(Object.hasOwn(next.input.context, 'subagent_binding'), false);
    assert.deepEqual(await resolveSkillBinding({ root: tree.workspace, skill: 'spec-me', workflowBinding: next.input.context.workflow_binding }), { skill: 'spec-me', provider: 'codex', model_tier: 'high_performance', model: 'gpt-6-luna', reasoning_effort: 'medium' });
    assert.deepEqual(await resolveSkillBinding({ root: tree.workspace, skill: 'plantuml-diagrams' }), { skill: 'plantuml-diagrams', provider: 'codex', model_tier: 'low_performance', model: 'gpt-6-luna', reasoning_effort: 'medium' });
    const roleBinding = JSON.parse(execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-skill-execution.mjs'), 'binding', '--root', tree.workspace, '--skill', 'plantuml-diagrams'], { cwd: tree.workspace, encoding: 'utf8' }));
    assert.equal(roleBinding.provider, 'codex');
    assert.equal(roleBinding.model, 'gpt-6-luna');
    assert.equal(roleBinding.reasoning_effort, 'medium');
    assert.equal(next.input.context.orchestrator_session_id, record.worktree_id);
    assert.equal(next.input.shared_guidance_root, undefined);
    const mismatched = { ...next.input, execution_id: 'provider-mismatch', context: { ...next.input.context, orchestrator_provider: 'claude-code' } };
    await writeExecutionInput(tree.workspace, mismatched, tree.plan_set_id);
    assert.throws(() => execFileSync(process.execPath, [join(tree.workspace, '.codex/scripts/harness-native-stage.mjs'), 'start', '--root', tree.workspace, '--worktree-ref', result.worktree_ref, '--execution-id', 'provider-mismatch'], { cwd: tree.workspace, stdio: 'pipe' }), /Execution provider must match/);
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

test('workflow binding is validated and retained on canonical worktree records', () => {
  const workflow_binding = { provider: 'codex', model: 'gpt-6-luna', reasoning_effort: 'medium' };
  assert.deepEqual(parse({ ...record, workflow_binding }).workflow_binding, workflow_binding);
  assert.deepEqual(parseWorkflowBinding(JSON.stringify(workflow_binding)), workflow_binding);
  assert.throws(() => parse({ ...record, workflow_binding: { ...workflow_binding, provider: 'unknown' } }), /Invalid HARNESS_WORKFLOW_BINDING/);
  assert.throws(() => parseWorkflowBinding(JSON.stringify({ ...workflow_binding, model: 'haiku with spaces' })), /Invalid HARNESS_WORKFLOW_BINDING/);
  assert.throws(() => parseWorkflowBinding(JSON.stringify({ ...workflow_binding, extra: true })), /Invalid HARNESS_WORKFLOW_BINDING/);
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

test('installed compose starts in an existing linked worktree without replacing project changes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'compose-existing-worktree-'));
  const root = join(parent, 'project'), workspace = join(parent, 'existing');
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    await mkdir(root);
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Contract');
    git(root, 'config', 'user.email', 'contract@example.test');
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await seedSetup(root);
    git(root, 'add', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs', '.harness/contracts.mjs');
    git(root, 'commit', '-qm', 'setup baseline');
    git(root, 'worktree', 'add', '-qb', 'existing', workspace);
    await updateProject({ sourceRoot, targetRoot: workspace, initialize: true });
    await seedSetup(workspace);
    await writeFile(join(workspace, 'app.mjs'), 'project change\n');
    await writeFile(join(workspace, 'docs/contracts/project.md'), 'project-owned contract\n');
    assert.equal((await runDoctor({ root: workspace, sourceRoot })).diagnostics.some(({ code }) => code === 'execution_asset_missing'), false);
    const before = git(root, 'worktree', 'list', '--porcelain');
    const { inspectStartupState } = await import('../.harness/src/workflow/startup-state.mjs');
    assert.equal((await inspectStartupState({ workspaceRoot: workspace })).decision_hint, 'compose_candidate');
    const remote = spawnSync(process.execPath, [join(root, '.codex/scripts/harness-compose-workspace.mjs'), '--root', workspace, '--plan-set-id', 'calculator', '--request', '계산기 UI', '--execution-id', 'remote-compose'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(remote.status, 0);
    assert.match(remote.stderr, /inside the current linked worktree/);
    const compose = (id) => JSON.parse(execFileSync(process.execPath, [join(workspace, '.codex/scripts/harness-compose-workspace.mjs'), '--root', workspace, '--plan-set-id', 'calculator', '--request', '계산기 UI', '--execution-id', id, '--orchestrator-provider', 'codex', '--orchestrator-session-id', record.worktree_id], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const result = compose('compose-existing');
    assert.equal(result.workspace, await realpath(workspace));
    assert.equal(result.workspace_ownership, 'existing');
    const hook = join(workspace, '.codex/scripts/harness-orchestrator-hook.mjs');
    const send = (prompt, session_id = record.worktree_id) => execFileSync(process.execPath, [hook], { cwd: workspace, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: workspace, session_id, prompt }), encoding: 'utf8' });
    assert.equal(send('계속 진행해').trim(), '');
    const inputLog = join(workspace, '.io/runtime/orchestrator/user-inputs.jsonl');
    const captured = await readFile(inputLog, 'utf8');
    assert.match(captured, /계속 진행해/);
    assert.equal(send('하네스 업데이트해').trim(), '');
    assert.equal(send('$setup').trim(), '');
    assert.equal(send('다른 세션의 요청', 'b77aaa03-329c-4d59-b4c5-269746a893f2').trim(), '');
    assert.equal(await readFile(inputLog, 'utf8'), captured);

    assert.equal(git(root, 'worktree', 'list', '--porcelain'), before);
    assert.equal(await readFile(join(workspace, 'app.mjs'), 'utf8'), 'project change\n');
    const visible = git(workspace, 'status', '--short', '--untracked-files=all');
    assert.match(visible, /app\.mjs/);
    assert.match(visible, /docs\/contracts\/project\.md/);
    git(workspace, 'check-ignore', '-v', '.io/worktree.json');
    assert.throws(() => compose('compose-again'), /already has workflow state/);
    assert.equal((await finishWorkflowWorktree({ workspace_root: workspace, repository_root: root, worktree_id: result.worktree_id })).state, 'preserved');
    assert.equal(await readFile(join(workspace, 'app.mjs'), 'utf8'), 'project change\n');
    const next = JSON.parse(execFileSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--stage-id', 'spec-me'], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.equal(next.input.context.execution_workspace.workspace_root, await realpath(workspace));
    const native = [join(workspace, '.codex/scripts/harness-native-stage.mjs')];
    const nativeArgs = ['--root', workspace, '--worktree-ref', result.worktree_ref, '--execution-id', next.input.execution_id];
    const started = JSON.parse(execFileSync(process.execPath, [...native, 'start', ...nativeArgs], { cwd: workspace, encoding: 'utf8' }));
    assert.equal(started.workspace, workspace);
    const bound = JSON.parse(execFileSync(process.execPath, [...native, 'bind', ...nativeArgs, '--agent-id', 'agent-1'], { cwd: workspace, encoding: 'utf8' }));
    assert.equal(bound.agent_id, 'agent-1');
    const commandRunner = join(workspace, '.codex/scripts/harness-native-command.mjs');
    const environment = JSON.parse(execFileSync(process.execPath, [commandRunner, '--root', workspace, '--execution-id', next.input.execution_id, '--agent-id', 'agent-1', '--', process.execPath, '-e', 'process.stdout.write(JSON.stringify({ id: process.env.HARNESS_SKILL_EXECUTION_ID, root: process.env.HARNESS_WORKSPACE_ROOT, session: process.env.HARNESS_SESSION_DIR }))'], { cwd: workspace, encoding: 'utf8' }));
    assert.deepEqual(environment, { id: next.input.execution_id, root: workspace, session: result.session_directory });
    assert.throws(() => execFileSync(process.execPath, [commandRunner, '--root', workspace, '--execution-id', next.input.execution_id, '--agent-id', 'wrong', '--', process.execPath, '-e', ''], { cwd: workspace, stdio: 'pipe' }), /bound running subagent/);
    assert.throws(() => execFileSync(process.execPath, [...native, 'bind', ...nativeArgs, '--agent-id', 'another-agent'], { cwd: workspace, stdio: 'pipe' }), /binding mismatch/);
    assert.throws(() => execFileSync(process.execPath, [...native, 'start', ...nativeArgs], { cwd: workspace, stdio: 'pipe' }), /already running/);
    const missing = spawnSync(process.execPath, [...native, 'finish', ...nativeArgs], { cwd: workspace, encoding: 'utf8' });
    assert.equal(missing.status, 1, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout).errors[0], { path: '$', rule: 'required', expected: 'output file', value: null, missing: true });
    const received = spawnSync(process.execPath, [...native, 'receive', ...nativeArgs, '--agent-id', 'agent-1'], { cwd: workspace, encoding: 'utf8', input: JSON.stringify({ status: 4 }) });
    assert.equal(received.status, 0, received.stderr);
    const forged = spawnSync(process.execPath, [...native, 'receive', ...nativeArgs, '--agent-id', 'another-agent'], { cwd: workspace, encoding: 'utf8', input: '{}' });
    assert.notEqual(forged.status, 0);
    assert.match(forged.stderr, /binding mismatch/);
    const invalid = spawnSync(process.execPath, [...native, 'finish', ...nativeArgs], { cwd: workspace, encoding: 'utf8' });
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.ok(JSON.parse(invalid.stdout).errors.some(({ path, value }) => path === '$.status' && value === 4));
    const resultValue = { schema_version: 1, skill: 'spec-me', status: 'blocked', code: 'INPUT_MISSING', summary: 'missing input', artifacts: [], questions: [], review_request: null };
    await writeFile(started.output_path, JSON.stringify({ schema_version: 1, skill: 'spec-me', status: 'blocked', code: 'INPUT_MISSING', result: resultValue }));
    const finish = JSON.parse(execFileSync(process.execPath, [...native, 'finish', ...nativeArgs], { cwd: workspace, encoding: 'utf8' }));
    assert.equal(finish.status, 'blocked');
    assert.throws(() => execFileSync(process.execPath, [...native, 'finish', ...nativeArgs], { cwd: workspace, stdio: 'pipe' }), /not running/);
    const resume = JSON.parse(execFileSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--stage-id', 'spec-me', '--feedback', 'missing input is provided'], { cwd: workspace, encoding: 'utf8' }));
    assert.equal(resume.input.context.resume_session_id, undefined);
    assert.ok(resume.input.input_refs.some(({ kind }) => kind === 'previous_execution_result'));
    const retryArgs = ['--root', workspace, '--worktree-ref', result.worktree_ref, '--execution-id', resume.input.execution_id];
    execFileSync(process.execPath, [...native, 'start', ...retryArgs], { cwd: workspace, encoding: 'utf8' });
    const failure = JSON.parse(execFileSync(process.execPath, [...native, 'fail', ...retryArgs, '--reason', 'native tool failed'], { cwd: workspace, encoding: 'utf8' }));
    assert.equal(failure.status, 'failed');
    const afterFailure = JSON.parse(execFileSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--stage-id', 'spec-me', '--feedback', 'retry after tool failure'], { cwd: workspace, encoding: 'utf8' }));
    assert.ok(afterFailure.input.input_refs.some(({ kind }) => kind === 'previous_execution_input'));
    const configPath = join(workspace, '.codex/harness.yaml');
    const originalConfig = await readFile(configPath, 'utf8');
    await writeFile(configPath, originalConfig.replace('agents:\n', 'agents:\n  claude-code:\n    high_performance_model: opus\n    high_performance_reasoning_effort: high\n'));
    const { bindOrchestratorSession } = await import(`file://${join(workspace, '.harness/src/workflow/startup-state.mjs')}`);
    await bindOrchestratorSession({ root: workspace, provider: 'claude-code', sessionId: '4c1483d6-c69d-4df3-a6c1-481c7ac4ff44' });
    const claudeNext = JSON.parse(execFileSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--stage-id', 'spec-me', '--feedback', 'resume with Claude'], { cwd: workspace, encoding: 'utf8' }));
    assert.equal(claudeNext.input.context.provider, 'claude-code');
    const claudeArgs = ['--root', workspace, '--worktree-ref', result.worktree_ref, '--execution-id', claudeNext.input.execution_id];
    const claudeStart = JSON.parse(execFileSync(process.execPath, [...native, 'start', ...claudeArgs], { cwd: workspace, encoding: 'utf8' }));
    assert.equal(claudeStart.binding.provider, 'claude-code');
    assert.equal(claudeStart.binding.model, 'opus');
    assert.equal(claudeNext.input.context.resume_session_id, undefined);
    execFileSync(process.execPath, [...native, 'fail', ...claudeArgs, '--reason', 'native tool unavailable in fixture'], { cwd: workspace, encoding: 'utf8' });
    await bindOrchestratorSession({ root: workspace, provider: 'codex', sessionId: record.worktree_id });
    const questionNext = JSON.parse(execFileSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--stage-id', 'spec-me', '--feedback', 'resume with Codex'], { cwd: workspace, encoding: 'utf8' }));
    const questionArgs = ['--root', workspace, '--worktree-ref', result.worktree_ref, '--execution-id', questionNext.input.execution_id];
    const questionStart = JSON.parse(execFileSync(process.execPath, [...native, 'start', ...questionArgs], { cwd: workspace, encoding: 'utf8' }));
    execFileSync(process.execPath, [...native, 'bind', ...questionArgs, '--agent-id', 'question-agent'], { cwd: workspace, encoding: 'utf8' });
    const eventHook = join(workspace, '.codex/scripts/harness-agent-event.mjs');
    const childEvent = { hook_event_name: 'SubagentStart', cwd: workspace, session_id: 'question-agent', agent_id: 'child-agent', agent_type: 'code_researcher' };
    execFileSync(process.execPath, [eventHook], { cwd: workspace, input: JSON.stringify(childEvent), encoding: 'utf8' });
    const subagentsPath = join(workspace, '.io/runtime/executions', questionNext.input.execution_id, 'subagents.jsonl');
    assert.match(await readFile(subagentsPath, 'utf8'), /child-agent/);
    const priorEvents = await readFile(subagentsPath, 'utf8');
    execFileSync(process.execPath, [eventHook], { cwd: workspace, input: JSON.stringify({ ...childEvent, agent_id: 'unrelated', session_id: 'other-session' }), encoding: 'utf8' });
    assert.equal(await readFile(subagentsPath, 'utf8'), priorEvents);
    const question = { question_id: 'temporary', title: '범위는?', decision_kind: null, options: [{ id: 'basic', label: '기본', consequence: '기본', evidence: [] }, { id: 'full', label: '전체', consequence: '전체', evidence: [] }], recommended_option_id: 'basic', rationale: '기본 범위' };
    const questionResult = { schema_version: 1, skill: 'spec-me', status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '질문', artifacts: [], questions: [question], review_request: null };
    await writeFile(questionStart.output_path, JSON.stringify({ schema_version: 1, skill: 'spec-me', status: 'action_required', code: 'USER_DECISION_REQUIRED', result: questionResult }));
    const asked = JSON.parse(execFileSync(process.execPath, [...native, 'finish', ...questionArgs], { cwd: workspace, encoding: 'utf8' }));
    assert.equal(asked.status, 'action_required');
    const answer = JSON.stringify([{ question_id: asked.result.questions[0].question_id, answer: 'basic' }]);
    const answered = JSON.parse(execFileSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--stage-id', 'spec-me', '--answer', answer], { cwd: workspace, encoding: 'utf8' }));
    assert.equal(answered.input.context.resume_session_id, undefined);
    assert.ok(answered.input.input_refs.some(({ kind }) => kind === 'previous_execution_result'));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('installed hooks route a Harness update to maintenance without composing a workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-update-routing-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'base');
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await rm(join(root, '.harness/src/workflow/request-routing.mjs'));
    assert.ok((await runDoctor({ root, sourceRoot })).diagnostics.some(({ code, path }) => code === 'execution_asset_missing' && path?.endsWith('request-routing.mjs')));
    await updateProject({ sourceRoot, targetRoot: root });
    await writeFile(join(root, 'app.mjs'), 'application owned\n');
    await mkdir(join(root, 'docs/contracts'), { recursive: true });
    await writeFile(join(root, 'docs/contracts/project.md'), 'project contract\n');
    const before = git('worktree', 'list', '--porcelain');
    for (const path of ['.codex/scripts/harness-orchestrator-hook.mjs', '.claude/harness/scripts/harness-claude-orchestrator-hook.mjs']) {
      for (const prompt of ['하네스 업데이트해', '일반적인 질문', '$setup']) {
        const output = execFileSync(process.execPath, [join(root, path)], { cwd: root, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: record.worktree_id, prompt }), encoding: 'utf8' });
        assert.equal(output.trim(), '', `${path} must not invoke orchestrator for ${prompt}`);
      }
      const response = JSON.parse(execFileSync(process.execPath, [join(root, path)], { cwd: root, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: record.worktree_id, prompt: '$orchestrator 계산기 만들어' }), encoding: 'utf8' }));
      assert.match(response.hookSpecificOutput.additionalContext, /orchestrator/);
    }
    const result = spawnSync(process.execPath, [join(root, '.codex/scripts/harness-compose-workspace.mjs'), '--root', root, '--plan-set-id', 'harness-update', '--request', '하네스 업데이트해', '--execution-id', 'update-attempt'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Harness update is maintenance/);
    assert.equal(git('worktree', 'list', '--porcelain'), before);
    assert.equal(await readFile(join(root, 'app.mjs'), 'utf8'), 'application owned\n');
    const status = git('status', '--short', '--untracked-files=all');
    assert.match(status, /app\.mjs/);
    assert.match(status, /docs\/contracts\/project\.md/);
    assert.doesNotMatch(status, /request-routing\.mjs/);
    git('check-ignore', '-v', '.harness/src/workflow/request-routing.mjs');
    assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some(({ code, path }) => code === 'execution_asset_missing' && path?.endsWith('request-routing.mjs')), false);
    const { isHarnessUpdateRequest } = await import('../.harness/src/workflow/request-routing.mjs');
    for (const request of ['하네스 업데이트해', 'Harness 업데이트 해줘', 'update the harness', 'refresh harness runtime']) assert.equal(isHarnessUpdateRequest(request), true, request);
    assert.equal(isHarnessUpdateRequest('하네스 업데이트 기능을 구현해'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
