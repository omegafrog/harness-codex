import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecution } from '../.harness/src/workflow/execution.mjs';

async function createWorkspace({ prepareCode = 0, commandCode = 0, cleanupCode = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harness-profile-cleanup-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-qm', 'baseline']);
  await mkdir(join(root, '.io'), { recursive: true });
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await writeFile(join(root, 'docs/agents/EXEC.md'), 'execution contract\n');
  const cleanupMarker = join(root, 'cleanup-ran');
  const script = (code, marker) => [process.execPath, '-e', `process.exitCode=${code};${marker ? `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done')` : ''}`];
  await writeFile(join(root, 'docs/agents/execution.json'), JSON.stringify({
    schema_version: 1,
    profiles: {
      test: {
        purpose: 'e2e',
        command: script(commandCode),
        required_env: ['DATABASE_NAME'],
        config_inputs: ['docs/agents/EXEC.md'],
        prepare: [script(prepareCode)],
        verify_config: [script(0)],
        cleanup: [script(cleanupCode), script(0, cleanupMarker)],
        dependencies: [],
        timeout_ms: 5_000,
        readiness_timeout_ms: 2_000,
        poll_interval_ms: 10,
      },
    },
  }, null, 2));
  return { root, cleanupMarker };
}

test('runs profile cleanup after command failure and reports a cleanup failure after command success', async () => {
  const originalCwd = process.cwd();
  const { root, cleanupMarker } = await createWorkspace({ commandCode: 1 });
  try {
    process.chdir(root);
    const result = await runExecution({ workspace_root: root, profile_id: 'test', environment: { ...process.env, DATABASE_NAME: 'test' } });
    assert.equal(result.status, 'failed');
    assert.equal(result.cleanup_status, 'passed');
    assert.equal(await readFile(cleanupMarker, 'utf8'), 'done');
    assert.equal(result.steps.at(-1).phase, 'cleanup');
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }

  const failedCleanup = await createWorkspace({ cleanupCode: 1 });
  try {
    process.chdir(failedCleanup.root);
    const result = await runExecution({ workspace_root: failedCleanup.root, profile_id: 'test', environment: { ...process.env, DATABASE_NAME: 'test' } });
    assert.equal(result.status, 'failed');
    assert.equal(result.cleanup_status, 'failed');
    assert.match(result.cleanup_error, /Cleanup command failed/);
    await assert.rejects(readFile(failedCleanup.cleanupMarker), { code: 'ENOENT' });
  } finally {
    process.chdir(originalCwd);
    await rm(failedCleanup.root, { recursive: true, force: true });
  }
});

test('runs profile cleanup when preparation fails', async () => {
  const originalCwd = process.cwd();
  const { root, cleanupMarker } = await createWorkspace({ prepareCode: 1 });
  try {
    process.chdir(root);
    const result = await runExecution({ workspace_root: root, profile_id: 'test', environment: { ...process.env, DATABASE_NAME: 'test' } });
    assert.equal(result.status, 'blocked');
    assert.equal(result.cleanup_status, 'passed');
    assert.equal(await readFile(cleanupMarker, 'utf8'), 'done');
    assert.equal(result.steps.at(-1).phase, 'cleanup');
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});
