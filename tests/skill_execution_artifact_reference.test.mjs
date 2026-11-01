import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';

test('installed skill execution accepts a changed input with its original snapshot hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-mutable-input-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    const runtime = `file://${join(root, '.harness/src/workflow')}`;
    const { validateSkillInput } = await import(`${runtime}/skill-execution.mjs`);
    const { sessionDirectory } = await import(`${runtime}/session-output.mjs`);
    const inputPath = 'docs/specs/calculator/product-spec.md';
    await mkdir(join(root, inputPath, '..'), { recursive: true });
    await writeFile(join(root, inputPath), 'revised after review');
    const input = {
      schema_version: 1,
      execution_id: 'spec-me-1',
      skill: 'spec-me',
      workspace_root: root,
      session_directory: sessionDirectory(root),
      scope: 'calculator',
      input_refs: [{ base: 'workspace', path: inputPath, sha256: createHash('sha256').update('original').digest('hex') }],
    };
    await validateSkillInput({ root, input });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
