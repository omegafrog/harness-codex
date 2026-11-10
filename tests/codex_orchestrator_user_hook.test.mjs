import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexOrchestratorHook } from '../.harness/src/workflow/providers/codex.mjs';

// The user-level hook runs the orchestrator hook of the session's own workspace, so a new worktree needs no
// project hook and no new Codex hook review; where the project's hooks.json already has the hook it steps aside.
test('the user-level Codex orchestrator hook runs the workspace script unless the project hook already does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-user-hook-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    await mkdir(join(root, '.codex/scripts'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, '.codex/scripts/harness-orchestrator-hook.mjs'), "import { writeFileSync } from 'node:fs'; let t=''; for await (const c of process.stdin) t+=c; writeFileSync(new URL('../../ran.json', import.meta.url), t);\n");
    const run = () => spawnSync('sh', ['-c', codexOrchestratorHook().command], { cwd: join(root, 'src'), input: '{"hook_event_name":"Stop"}', encoding: 'utf8' });
    assert.equal(run().status, 0);
    assert.ok(existsSync(join(root, 'ran.json')), 'runs from a subdirectory of the workspace');
    await rm(join(root, 'ran.json'));
    await writeFile(join(root, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${join(root, '.codex/scripts/harness-orchestrator-hook.mjs')}` }] }] } }));
    assert.equal(run().status, 0);
    assert.equal(existsSync(join(root, 'ran.json')), false, 'the project hook already runs it');
    // Outside a Harness workspace it does nothing.
    assert.equal(spawnSync('sh', ['-c', codexOrchestratorHook().command], { cwd: tmpdir(), input: '{}', encoding: 'utf8' }).status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
