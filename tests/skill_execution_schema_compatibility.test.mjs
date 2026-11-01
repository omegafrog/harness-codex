import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateProject, discoverManagedAssetPaths } from '../src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../src/installer/local-exclude.mjs';
import { runDoctor } from '../src/doctor/doctor.mjs';
import { join } from 'node:path';
import test from 'node:test';
import { writeOutputSchema } from '../src/workflow/output-schema.mjs';

const schemas = '.codex/internal-skills/skill-execution/schemas';
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('flow schemas retain legacy question validation', async () => {
  const files = await readdir(join(schemas, 'flows'));
  for (const file of files.filter((name) => name.endsWith('.schema.json'))) {
    const schema = await readJson(join(schemas, 'flows', file));
    assert.ok(schema.properties.question, `${file} accepts legacy question records`);
    assert.ok(schema.properties.questions);
    assert.ok(schema.required.includes('questions'));
  }
});

test('generated output schemas omit optional legacy question but preserve required question', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-output-schema-'));
  try {
    for (const [skill, expected] of [['spec-me', false], ['workflow-compose', true]]) {
      const path = join(directory, `${skill}.schema.json`);
      await writeOutputSchema({ root: process.cwd(), input: { execution_id: 'check', skill }, prefix: 'runtime/executions/check', path });
      const schema = await readJson(path);
      assert.equal(Object.hasOwn(schema.properties.result.properties, 'question'), expected);
      assert.equal(schema.properties.result.required.includes('question'), expected);
      if (skill === 'spec-me') assert.ok(Object.hasOwn(schema.properties.result.properties, 'questions'));
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
    for (const name of ['common.schema.json', 'plan-review.schema.json', 'spec-review.schema.json']) await readFile(join(root, '.codex/internal-skills/skill-execution/schemas/flows', name));
    const doctor = await runDoctor({ root, sourceRoot });
    assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
