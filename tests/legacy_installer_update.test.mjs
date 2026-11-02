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
    await writeFile(resolve(root, '.codex/harness-lock.json'), JSON.stringify({ schema_version: 1, files: {} }));
    await writeFile(resolve(root, 'docs/agents/EXEC.md'), 'project owned');
    const schemaPath = '.codex/internal-skills/skill-execution/schemas/flows/to-ticket-plan_finalize.schema.json';
    await mkdir(resolve(root, '.codex/internal-skills/skill-execution/schemas/flows'), { recursive: true });
    const schema = await readFile(resolve(sourceRoot, 'tests/fixtures/legacy/to-ticket-plan.schema.json'));
    await writeFile(resolve(root, schemaPath), schema);
    const unknownSchema = '.codex/internal-skills/skill-execution/schemas/flows/to-ticket-plan_revision.schema.json';
    await writeFile(resolve(root, unknownSchema), 'user schema');
    const retiredPath = '.codex/scripts/old-managed.mjs';
    const modifiedPath = '.codex/scripts/old-modified.mjs';
    const oldHash = createHash('sha256').update('old managed').digest('hex');
    await writeFile(resolve(root, retiredPath), 'old managed');
    await writeFile(resolve(root, modifiedPath), 'user modified');
    await writeFile(resolve(root, '.codex/harness-lock.json'), JSON.stringify({ schema_version: 1, files: Object.fromEntries([retiredPath, modifiedPath].map((path) => [path, { installed_sha256: oldHash, upstream_sha256: oldHash, source_path: path }])) }));
    const result = await updateProject({ sourceRoot, targetRoot: root });
    await protectLocalInstallArtifacts(root, sourceRoot);
    assert.deepEqual(await readFile(resolve(result.backup_directory, '.codex/scripts/harness-doctor.mjs')), legacy);
    assert.deepEqual(await readFile(resolve(result.backup_directory, schemaPath)), schema);
    await assert.rejects(readFile(resolve(root, schemaPath)), { code: 'ENOENT' });
    assert.equal(await readFile(resolve(result.backup_directory, retiredPath), 'utf8'), 'old managed');
    await assert.rejects(readFile(resolve(root, retiredPath)), { code: 'ENOENT' });
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
    assert.doesNotMatch(status, /\.codex\/scripts\/harness-doctor/);
    await writeFile(resolve(root, '.codex/scripts/harness-doctor.mjs'), 'custom doctor');
    const lock = JSON.parse(await readFile(resolve(root, '.codex/harness-lock.json'), 'utf8'));
    delete lock.files['.codex/scripts/harness-doctor.mjs'];
    await writeFile(resolve(root, '.codex/harness-lock.json'), JSON.stringify(lock));
    const second = await updateProject({ sourceRoot, targetRoot: root });
    assert.equal(await readFile(resolve(root, '.codex/scripts/harness-doctor.mjs'), 'utf8'), 'custom doctor');
    assert.ok(second.skipped.some((item) => item.path === '.codex/scripts/harness-doctor.mjs' && item.status === 'unlocked'));
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
