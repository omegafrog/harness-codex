import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('update can replace managed skills without creating backups when explicitly requested', async () => {
  const sourceRoot = process.cwd();
  const session = resolve(sourceRoot, '.io/runtime/legacy-installer-tests');
  await mkdir(session, { recursive: true });
  const root = await mkdtemp(`${session}/no-backup-`);
  try {
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const path = '.agents/skills/spec-me/SKILL.md';
    await writeFile(resolve(root, path), 'local content to replace');
    await writeFile(resolve(root, '.codex/hooks.json'), '{}');
    await writeFile(resolve(root, '.claude/settings.local.json'), '{}');
    const result = await updateProject({ sourceRoot, targetRoot: root, noBackup: true });
    assert.equal(result.backup_directory, null);
    assert.deepEqual(await readFile(resolve(root, path)), await readFile(resolve(sourceRoot, '.codex/skills/spec-me/SKILL.md')));
    await assert.rejects(readFile(resolve(root, '.codex/installer-backups'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(resolve(root, '.claude/installer-backups'), 'utf8'), { code: 'ENOENT' });
    assert.match(await readFile(resolve(root, '.codex/hooks.json'), 'utf8'), /harness-orchestrator-hook\.mjs/);
    assert.match(await readFile(resolve(root, '.claude/settings.local.json'), 'utf8'), /harness-claude-orchestrator-hook\.mjs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
