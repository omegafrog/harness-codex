import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';

test('legacy Doctor is backed up and updated while project files remain visible', async () => {
  const sourceRoot = process.cwd();
  const session = resolve(sourceRoot, '.io/runtime/legacy-installer-tests');
  await mkdir(session, { recursive: true });
  const root = await mkdtemp(`${session}/consumer-`);
  try {
    execFileSync('git', ['init', '-q', root]);
    await mkdir(resolve(root, '.codex/scripts'), { recursive: true });
    await mkdir(resolve(root, 'docs/agents'), { recursive: true });
    const legacy = await readFile(resolve(sourceRoot, 'tests/fixtures/legacy/harness-doctor.mjs'));
    await writeFile(resolve(root, '.codex/scripts/harness-doctor.mjs'), legacy);
    await mkdir(resolve(root, '.harness/src/workflow'), { recursive: true });
    for (const [fixture, path] of [['project-readiness.mjs', '.harness/src/workflow/project-readiness.mjs'], ['harness-codex-run.mjs', '.codex/scripts/harness-codex-run.mjs']]) {
      await writeFile(resolve(root, path), await readFile(resolve(sourceRoot, `tests/fixtures/legacy/${fixture}`)));
    }
    await writeFile(resolve(root, '.codex/harness-lock.json'), JSON.stringify({ schema_version: 1, files: {} }));
    await writeFile(resolve(root, 'docs/agents/EXEC.md'), 'project owned');
    const schemaPath = '.codex/internal-skills/skill-execution/schemas/flows/to-ticket-plan_finalize.schema.json';
    await mkdir(resolve(root, '.codex/internal-skills/skill-execution/schemas/flows'), { recursive: true });
    const schema = await readFile(resolve(sourceRoot, 'tests/fixtures/legacy/to-ticket-plan.schema.json'));
    await writeFile(resolve(root, schemaPath), schema);
    const unknownSchema = '.codex/internal-skills/skill-execution/schemas/flows/to-ticket-plan_revision.schema.json';
    await writeFile(resolve(root, unknownSchema), 'user schema');
    const releasedSchema = '.codex/internal-skills/skill-execution/schemas/flows/to-ticket-plan_split.schema.json';
    const releasedContent = await readFile(resolve(sourceRoot, 'tests/fixtures/legacy/to-ticket-plan-released.schema.json'));
    await writeFile(resolve(root, releasedSchema), releasedContent);
    const retiredPath = '.codex/scripts/old-managed.mjs';
    const modifiedPath = '.codex/scripts/old-modified.mjs';
    const retiredClaudePath = '.claude/agents/architecture_review_lead.md';
    const oldHash = createHash('sha256').update('old managed').digest('hex');
    await writeFile(resolve(root, retiredPath), 'old managed');
    await writeFile(resolve(root, modifiedPath), 'user modified');
    await mkdir(resolve(root, '.claude/agents'), { recursive: true });
    await writeFile(resolve(root, retiredClaudePath), 'old managed');
    const files = Object.fromEntries([retiredPath, modifiedPath].map((path) => [path, { installed_sha256: oldHash, upstream_sha256: oldHash, source_path: path }]));
    files[retiredClaudePath] = { installed_sha256: oldHash, upstream_sha256: oldHash, source_path: '.codex/agents/architecture_review_lead.toml', source_transform: 'claude-agent-v1' };
    await writeFile(resolve(root, '.codex/harness-lock.json'), JSON.stringify({ schema_version: 1, files }));
    const result = await updateProject({ sourceRoot, targetRoot: root });
    await protectLocalInstallArtifacts(root, sourceRoot);
    for (const path of ['.codex/internal-skills/grill-with-docs/GUIDE.md', '.codex/internal-skills/product-spec/GUIDE.md']) {
      assert.equal(await readFile(resolve(root, path), 'utf8'), await readFile(resolve(sourceRoot, path), 'utf8'));
      execFileSync('git', ['-C', root, 'check-ignore', '-q', path]);
    }
    const specPathScript = '.codex/scripts/harness-spec-path.mjs';
    assert.equal(await readFile(resolve(root, specPathScript), 'utf8'), await readFile(resolve(sourceRoot, specPathScript), 'utf8'));
    execFileSync('git', ['-C', root, 'check-ignore', '-q', specPathScript]);
    assert.deepEqual(await readFile(resolve(result.backup_directory, '.codex/scripts/harness-doctor.mjs')), legacy);
    assert.ok(result.updated.includes('.harness/src/workflow/project-readiness.mjs'));
    assert.ok(result.updated.includes('.codex/scripts/harness-codex-run.mjs'));
    assert.match(await readFile(resolve(root, '.harness/src/workflow/project-readiness.mjs'), 'utf8'), /export async function inspectSetupConfiguration/);
    assert.deepEqual(await readFile(resolve(result.backup_directory, schemaPath)), schema);
    await assert.rejects(readFile(resolve(root, schemaPath)), { code: 'ENOENT' });
    assert.deepEqual(await readFile(resolve(result.backup_directory, releasedSchema)), releasedContent);
    await assert.rejects(readFile(resolve(root, releasedSchema)), { code: 'ENOENT' });
    assert.equal(await readFile(resolve(result.backup_directory, retiredPath), 'utf8'), 'old managed');
    await assert.rejects(readFile(resolve(root, retiredPath)), { code: 'ENOENT' });
    assert.ok(result.updated.includes(retiredClaudePath));
    assert.match(await readFile(resolve(root, retiredClaudePath), 'utf8'), /name: architecture_review_lead/);
    assert.equal(await readFile(resolve(root, modifiedPath), 'utf8'), 'user modified');
    assert.equal(JSON.parse(await readFile(resolve(root, '.codex/harness-lock.json'), 'utf8')).files[modifiedPath].retired, true);
    assert.equal(await readFile(resolve(root, unknownSchema), 'utf8'), 'user schema');
    assert.ok(result.skipped.some((item) => item.path === unknownSchema && item.status === 'legacy_unrecognized'));
    let diagnostics;
    try { diagnostics = execFileSync('node', [resolve(root, '.codex/scripts/harness-doctor.mjs'), '--project', root, '--json'], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (error) { diagnostics = error.stdout; }
    assert.ok(JSON.parse(diagnostics).diagnostics.some((item) => item.code === 'installer_retired_file' && item.path === resolve(root, modifiedPath)));
    assert.equal(execFileSync('node', [resolve(root, '.codex/scripts/harness-doctor.mjs'), '--help'], { encoding: 'utf8' }).includes('Usage:'), true);
    const status = execFileSync('git', ['-C', root, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' });
    assert.match(status, /docs\/agents\/EXEC.md/);
    assert.match(status, /\.harness\/contracts\.mjs/);
    assert.match(status, /to-ticket-plan_revision\.schema\.json/);
    assert.doesNotMatch(status, /\.codex\/scripts\/harness-doctor/);
    await writeFile(resolve(root, '.codex/scripts/harness-doctor.mjs'), 'custom doctor');
    const lock = JSON.parse(await readFile(resolve(root, '.codex/harness-lock.json'), 'utf8'));
    delete lock.files['.codex/scripts/harness-doctor.mjs'];
    await writeFile(resolve(root, '.codex/harness-lock.json'), JSON.stringify(lock));
    const second = await updateProject({ sourceRoot, targetRoot: root });
    assert.equal(await readFile(resolve(root, '.codex/scripts/harness-doctor.mjs'), 'utf8'), 'custom doctor');
    assert.ok(second.skipped.some((item) => item.path === '.codex/scripts/harness-doctor.mjs' && item.status === 'unlocked'));
    await writeFile(resolve(root, '.codex/scripts/harness-doctor.mjs'), await readFile(resolve(sourceRoot, 'bin/harness-doctor.mjs')));
    const runtime = '.harness/src/workflow/skill-execution.mjs';
    const secondLock = JSON.parse(await readFile(resolve(root, '.codex/harness-lock.json'), 'utf8'));
    delete secondLock.files[runtime];
    await writeFile(resolve(root, '.codex/harness-lock.json'), JSON.stringify(secondLock));
    let report;
    try { report = execFileSync('node', [resolve(root, '.codex/scripts/harness-doctor.mjs'), '--project', root, '--json'], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (error) { report = error.stdout; }
    assert.ok(JSON.parse(report).diagnostics.some((item) => item.code === 'installer_unlocked_file' && item.severity === 'error' && item.path === resolve(root, runtime)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Doctor reports a missing runtime without throwing', async () => {
  const session = resolve(process.cwd(), '.io/runtime/legacy-installer-tests');
  await mkdir(session, { recursive: true });
  const root = await mkdtemp(`${session}/broken-`);
  try {
    await mkdir(resolve(root, '.codex/scripts'), { recursive: true });
    await writeFile(resolve(root, '.codex/scripts/harness-doctor.mjs'), await readFile(resolve(process.cwd(), 'bin/harness-doctor.mjs')));
    let output;
    try { execFileSync('node', [resolve(root, '.codex/scripts/harness-doctor.mjs'), '--json'], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (error) { assert.equal(error.status, 1); output = error.stdout; }
    assert.equal(JSON.parse(output).diagnostics[0].code, 'doctor_runtime_unavailable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed E2E cleanup preserves session evidence and removes new external artifacts', async () => {
  const session = resolve(process.cwd(), '.io/runtime/legacy-installer-tests');
  await mkdir(session, { recursive: true });
  const root = await mkdtemp(`${session}/guard-`);
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, process.cwd());
    await updateProject({ sourceRoot: process.cwd(), targetRoot: root, initialize: true });
    await mkdir(resolve(root, 'docs/agents'), { recursive: true });
    await writeFile(resolve(root, 'docs/agents/EXEC.md'), 'project owned');
    await updateProject({ sourceRoot: process.cwd(), targetRoot: root });
    for (const [path, pattern] of [
      // Question criteria are owned by the Product Spec guide; spec-me links to them.
      ['.codex/internal-skills/spec-me/GUIDE.md', /무엇을 언제 묻는지는 \[Product Spec 절차\]\(\.\.\/product-spec\/GUIDE\.md\)의 질문 기준/],
      ['.codex/internal-skills/product-spec/GUIDE.md', /Ask about an ambiguity only when it is necessary to deliver the requested core behavior/],
      ['.codex/internal-skills/product-spec/GUIDE.md', /collect all currently answerable independent material decisions/],
      ['.codex/internal-skills/grill-with-docs/GUIDE.md', /gather all currently identifiable material decisions/],
    ]) {
      assert.match(await readFile(resolve(root, path), 'utf8'), pattern);
      execFileSync('git', ['-C', root, 'check-ignore', '-q', path]);
    }
    assert.equal(await readFile(resolve(root, 'docs/agents/EXEC.md'), 'utf8'), 'project owned');
    assert.match(execFileSync('git', ['-C', root, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' }), /docs\/agents\/EXEC\.md/);
    const dir = resolve(root, '.io/runtime/e2e/run');
    await mkdir(dir, { recursive: true });
    const manifest = resolve(dir, 'artifacts.json');
    const guard = resolve(root, '.codex/internal-skills/e2e-test/scripts/artifact-guard.mjs');
    await writeFile(resolve(root, 'existing.txt'), 'existing');
    execFileSync('node', [guard, 'snapshot', '--root', root, '--manifest', manifest]);
    await writeFile(resolve(dir, 'receipt.json'), 'evidence');
    const generatedDoc = 'docs/agents/generated-workflow-spec.md';
    await mkdir(resolve(root, 'docs/agents'), { recursive: true });
    await writeFile(resolve(root, generatedDoc), 'project workflow output');
    await writeFile(resolve(root, 'temporary.txt'), 'temporary');
    await writeFile(resolve(root, 'owned.tmp'), 'owned');
    const result = JSON.parse(execFileSync('node', [guard, 'cleanup', '--root', root, '--manifest', manifest], { encoding: 'utf8' }));
    assert.equal(result.status, 'passed');
    assert.equal(await readFile(resolve(dir, 'receipt.json'), 'utf8'), 'evidence');
    assert.equal(await readFile(resolve(root, 'existing.txt'), 'utf8'), 'existing');
    assert.equal(await readFile(resolve(root, generatedDoc), 'utf8'), 'project workflow output');
    assert.equal(await readFile(resolve(root, 'temporary.txt'), 'utf8'), 'temporary');
    assert.ok(result.preserved.includes(generatedDoc));
    const status = execFileSync('git', ['-C', root, 'status', '--short', '--untracked-files=all'], { encoding: 'utf8' });
    assert.match(status, /docs\/agents\/generated-workflow-spec\.md/);
    const cleanup = (path) => execFileSync('node', [guard, 'cleanup', '--root', root, '--manifest', manifest, '--owned', path], { encoding: 'utf8' });
    const removed = JSON.parse(cleanup('owned.tmp'));
    assert.deepEqual(removed.removed, ['owned.tmp']);
    await assert.rejects(readFile(resolve(root, 'owned.tmp')), { code: 'ENOENT' });
    assert.throws(() => cleanup('existing.txt'), /newly created untracked path/);
    assert.throws(() => cleanup('../outside.txt'), /outside worktree/);
    assert.equal(await readFile(resolve(root, 'existing.txt'), 'utf8'), 'existing');
    assert.equal(await readFile(resolve(root, generatedDoc), 'utf8'), 'project workflow output');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('update can replace managed skills without creating backups when explicitly requested', async () => {
  const sourceRoot = process.cwd();
  const session = resolve(sourceRoot, '.io/runtime/legacy-installer-tests');
  await mkdir(session, { recursive: true });
  const root = await mkdtemp(`${session}/no-backup-`);
  try {
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const path = '.codex/internal-skills/spec-me/GUIDE.md';
    await writeFile(resolve(root, path), 'local content to replace');
    await writeFile(resolve(root, '.codex/hooks.json'), '{}');
    await writeFile(resolve(root, '.claude/settings.local.json'), '{}');
    const result = await updateProject({ sourceRoot, targetRoot: root, noBackup: true });
    assert.equal(result.backup_directory, null);
    assert.deepEqual(await readFile(resolve(root, path)), await readFile(resolve(sourceRoot, '.codex/internal-skills/spec-me/GUIDE.md')));
    await assert.rejects(readFile(resolve(root, '.codex/installer-backups'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(resolve(root, '.claude/installer-backups'), 'utf8'), { code: 'ENOENT' });
    assert.match(await readFile(resolve(root, '.codex/hooks.json'), 'utf8'), /harness-orchestrator-hook\.mjs/);
    assert.match(await readFile(resolve(root, '.claude/settings.local.json'), 'utf8'), /harness-claude-orchestrator-hook\.mjs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('update deletes retired skill files with their empty directories and keeps project files', async () => {
  const sourceRoot = process.cwd();
  const session = resolve(sourceRoot, '.io/runtime/legacy-installer-tests');
  await mkdir(session, { recursive: true });
  const root = await mkdtemp(`${session}/retired-dirs-`);
  const exists = (path) => stat(resolve(root, path)).then(() => true, () => false);
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    // A retired public skill file that is still in the lock.
    const retiredFile = '.agents/skills/code-review/references/old.md';
    await mkdir(resolve(root, '.agents/skills/code-review/references'), { recursive: true });
    await writeFile(resolve(root, retiredFile), 'old managed');
    const lockPath = resolve(root, '.codex/harness-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const oldHash = createHash('sha256').update('old managed').digest('hex');
    lock.files[retiredFile] = { installed_sha256: oldHash, upstream_sha256: oldHash, source_path: '.codex/skills/code-review/references/old.md', source_transform: 'project-local-paths-v1' };
    await writeFile(lockPath, JSON.stringify(lock));
    // Empty directories left by earlier updates, plus project-owned skills that must survive.
    await mkdir(resolve(root, '.claude/skills/spec-me/references'), { recursive: true });
    await mkdir(resolve(root, '.codex/internal-skills/static-caller'), { recursive: true });
    await mkdir(resolve(root, '.agents/skills/my-skill'), { recursive: true });
    await mkdir(resolve(root, '.agents/skills/my-notes'), { recursive: true });
    await writeFile(resolve(root, '.agents/skills/my-notes/SKILL.md'), 'project owned');
    await writeFile(resolve(root, 'app.txt'), 'app');

    const result = await updateProject({ sourceRoot, targetRoot: root });

    assert.deepEqual(result.retired, [retiredFile]);
    assert.equal(await readFile(resolve(result.backup_directory, retiredFile), 'utf8'), 'old managed');
    for (const path of ['.agents/skills/code-review', '.claude/skills/spec-me', '.codex/internal-skills/static-caller']) assert.equal(await exists(path), false, path);
    assert.ok(result.removed_directories.includes('.agents/skills/code-review'));
    assert.equal(await exists('.agents/skills/my-skill'), true, 'unknown empty skill directories are not Harness-owned');
    assert.equal(await readFile(resolve(root, '.agents/skills/my-notes/SKILL.md'), 'utf8'), 'project owned');
    assert.equal(await exists('.agents/skills/orchestrator/SKILL.md'), true);
    const status = execFileSync('git', ['-C', root, 'status', '--short', '-uall', '.agents', '.claude', '.codex', 'app.txt'], { encoding: 'utf8' });
    assert.equal(status, '?? .agents/skills/my-notes/SKILL.md\n?? app.txt\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('update to the latest release backs up and removes locally modified retired files and the legacy runtime root', async () => {
  const sourceRoot = process.cwd();
  const session = resolve(sourceRoot, '.io/runtime/legacy-installer-tests');
  await mkdir(session, { recursive: true });
  const root = await mkdtemp(`${session}/latest-`);
  const exists = (path) => stat(resolve(root, path)).then(() => true, () => false);
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const retired = '.codex/scripts/old-modified.mjs';
    await writeFile(resolve(root, retired), 'user modified');
    const lockPath = resolve(root, '.codex/harness-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const oldHash = createHash('sha256').update('old managed').digest('hex');
    lock.files[retired] = { installed_sha256: oldHash, upstream_sha256: oldHash, source_path: retired };
    await writeFile(lockPath, JSON.stringify(lock));
    const guide = '.codex/internal-skills/implement/GUIDE.md';
    const installedGuide = await readFile(resolve(root, guide), 'utf8');
    await writeFile(resolve(root, guide), 'local edit');
    await mkdir(resolve(root, '.codex/harness-runtime/src/workflow'), { recursive: true });

    const result = await updateProject({ sourceRoot, targetRoot: root, force: true });

    assert.equal(await exists(retired), false);
    assert.equal(await readFile(resolve(result.backup_directory, retired), 'utf8'), 'user modified');
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).files[retired], undefined);
    assert.equal(await readFile(resolve(root, guide), 'utf8'), installedGuide);
    assert.equal(await readFile(resolve(result.backup_directory, guide), 'utf8'), 'local edit');
    assert.equal(await exists('.codex/harness-runtime'), false);
    assert.ok(result.skipped.every((item) => item.status === 'legacy_unrecognized'), JSON.stringify(result.skipped));
    const cli = await readFile(resolve(sourceRoot, 'bin/harness-install.mjs'), 'utf8');
    assert.match(cli, /updateProject\(\{ sourceRoot: packageRoot, targetRoot: projectRoot, force: true, noBackup/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
