import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { processIdentity } from '../.harness/src/workflow/execution-state.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

test('installed harness-progress summarizes a session and flags a running stage whose process is gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-progress-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true, provider: 'codex' });
    const session = join(root, '.io');
    await mkdir(join(session, 'runtime/orchestrator'), { recursive: true });
    const self = await processIdentity(process.pid);
    const state = {
      schema_version: 1, status: 'running', current_stage: 'implement-wrapper', updated_at: '2026-01-01T00:00:00.000Z',
      stages: {
        'spec-me': { status: 'completed', code: 'OK', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:02:00.000Z', attempts: [{}, {}] },
        'to-ticket': { status: 'waiting', code: 'USER_DECISION_REQUIRED', started_at: '2026-01-01T00:02:00.000Z', finished_at: '2026-01-01T00:03:00.000Z' },
        'implement-wrapper': { status: 'running', started_at: '2026-01-01T00:03:00.000Z', owner: { ...self, start: '1' } },
      },
    };
    await writeFile(join(session, 'runtime/orchestrator/state.json'), JSON.stringify(state));
    const script = join(root, '.codex/scripts/harness-progress.mjs');
    const output = execFileSync(process.execPath, [script, '--session', session], { cwd: root, encoding: 'utf8' });
    assert.match(output, /기록된 단계 1\/3 완료/);
    assert.match(output, /✓ spec-me\s+완료 00:02:00 · 2회차/);
    assert.match(output, /⏸ to-ticket\s+대기 .*사용자 답변 필요/);
    assert.match(output, /✗ implement-wrapper\s+정지됨 .*프로세스가 없음/);
    // Same session found without --session from the project directory.
    assert.match(execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' }), /spec-me/);
    assert.equal(execFileSync('git', ['-C', root, 'check-ignore', '-q', '.codex/scripts/harness-progress.mjs'], { stdio: 'pipe' }).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
