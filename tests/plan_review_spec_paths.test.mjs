import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotPlanSet, updatePlanReview, inspectPlanSet } from '../.harness/src/workflow/plan-review.mjs';

// A plan index line can mention "Architecture Spec" next to another document; the review inputs still are the two
// Specs spec-me wrote, so a plan reviewer always receives the Architecture Spec.
test('plan review inputs are the fixed Spec paths even when the index mentions other documents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-spec-paths-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const plans = join(root, 'docs/plans/set'), specs = join(root, 'docs/specs/set');
    await mkdir(plans, { recursive: true }); await mkdir(specs, { recursive: true }); await mkdir(join(root, 'docs/agents'), { recursive: true });
    for (const name of ['product', 'architecture']) await writeFile(join(specs, `${name}-spec.md`), `# ${name}\n`);
    await writeFile(join(root, 'docs/agents/EXEC.md'), '');
    await writeFile(join(plans, 'e2e.md'), '# e2e\n');
    await writeFile(join(plans, 'plans.md'), '# Plans\n\n| [e2e](e2e.md) | Architecture Spec 12.7 환경, 실행 안내는 `docs/agents/EXEC.md` | 없음 |\n');
    const snapshot = await snapshotPlanSet({ root, planSetId: 'set' });
    assert.deepEqual(snapshot.spec_paths, ['docs/specs/set/product-spec.md', 'docs/specs/set/architecture-spec.md']);
    assert.ok(Object.keys(snapshot.inputs).includes('docs/specs/set/architecture-spec.md'));
    assert.ok(!Object.keys(snapshot.inputs).includes('docs/agents/EXEC.md'));
    await mkdir(join(root, '.codex'));
    await writeFile(join(root, '.codex/harness.yaml'), 'tracker:\n  mode: github\n');
    await mkdir(join(root, '.io'));
    await assert.rejects(updatePlanReview({ root, planSetId: 'set', action: 'begin' }), /missing or empty:.*parent.md.*e2e.md/);
    const blocked = await inspectPlanSet({ root, planSetId: 'set', phase: 'planning' });
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.reason, /missing or empty:/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
