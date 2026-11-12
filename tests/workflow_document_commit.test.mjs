import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitWorkflowDocuments } from '../.harness/src/workflow/stage-commit.mjs';

// Workflow-owned documents are committed by their stage; unrelated project files stay visible and uncommitted.
test('spec-me, to-ticket and sync-contracts commit only their own documents when they complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-docs-'));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    await writeFile(join(root, 'CONTEXT.md'), '# Context\n');
    git('add', '.'); git('commit', '-qm', 'base');
    for (const dir of ['docs/specs/set', 'docs/plans/set', 'docs/contracts/diagrams', 'docs/agents']) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, 'docs/specs/set/product-spec.md'), '# Product\n');
    await writeFile(join(root, 'CONTEXT.md'), '# Context\n\n- Account\n');
    await writeFile(join(root, 'docs/plans/set/auth.md'), '# auth\n');
    await writeFile(join(root, 'docs/contracts/product.md'), '# Product contract\n');
    await writeFile(join(root, 'docs/contracts/diagrams/domain.svg'), '<svg/>\n');
    await writeFile(join(root, 'docs/agents/EXEC.md'), 'run\n');
    const raw = join(root, '..', `${Date.now()}-raw.json`);
    const result = async (skill, status) => { await writeFile(raw, JSON.stringify({ status })); return commitWorkflowDocuments({ root, input: { skill, context: { plan_set_id: 'set' } }, rawPath: raw }); };
    assert.equal(await result('spec-me', 'action_required'), null, 'only a completed stage commits');
    assert.match(await result('spec-me', 'completed'), /^[0-9a-f]{40}$/);
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['CONTEXT.md', 'docs/specs/set/product-spec.md']);
    assert.match(await result('to-ticket', 'completed'), /^[0-9a-f]{40}$/);
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['docs/plans/set/auth.md']);
    assert.equal(await result('to-ticket', 'completed'), null, 'nothing to commit is not an error');
    assert.equal(await result('sync-contracts', 'action_required'), null, 'only a completed stage commits');
    assert.match(await result('sync-contracts', 'completed'), /^[0-9a-f]{40}$/);
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['docs/contracts/diagrams/domain.svg', 'docs/contracts/product.md']);
    // Implementation-owned files stay visible and uncommitted, even when something else already staged them.
    assert.match(git('status', '--short'), /\?\? docs\/agents\//);
    git('add', 'docs/agents/EXEC.md');
    await writeFile(join(root, 'docs/plans/set/auth.md'), '# auth\n\nrevised\n');
    git('add', 'docs/plans/set/auth.md');
    await writeFile(join(root, 'docs/specs/set/product-spec.md'), '# Product\n\nrevised\n');
    assert.match(await result('spec-me', 'completed'), /^[0-9a-f]{40}$/);
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['docs/specs/set/product-spec.md']);
    assert.deepEqual(git('diff', '--cached', '--name-only').split('\n').sort(), ['docs/agents/EXEC.md', 'docs/plans/set/auth.md']);
    await rm(raw, { force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
