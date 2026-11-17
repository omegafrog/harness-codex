import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotPlanSet, updatePlanReview, inspectPlanSet, inspectPlanSetImpact } from '../.harness/src/workflow/plan-review.mjs';

// A plan set is reviewed against the tactical design and the implementation decisions; no Product or Architecture Spec is
// needed. A plan index line that mentions another document never adds it to the review inputs.
test('plan review inputs are the tactical design documents, never a Spec and never an index mention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-design-paths-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const plans = join(root, 'docs/plans/set'), specs = join(root, 'docs/specs/set'), decisions = join(root, 'docs/implementation/set');
    for (const directory of [plans, specs, decisions, join(root, 'docs/agents')]) await mkdir(directory, { recursive: true });
    await writeFile(join(specs, 'requirements.md'), '# requirements\n');
    await writeFile(join(specs, 'tactical-design.md'), '# tactical design\n');
    for (const name of ['technology', 'ui-handoff', 'api', 'data']) await writeFile(join(decisions, `${name}.md`), `# ${name}\n`);
    await writeFile(join(root, 'CONTEXT.md'), '# Context\n');
    await writeFile(join(root, 'docs/agents/EXEC.md'), '');
    await writeFile(join(plans, 'first.md'), '---\nstatus: planned\n---\n# first\n');
    await writeFile(join(plans, 'plans.md'), '# Plans\n\n| [first](first.md) | Architecture Spec 12.7 환경, 실행 안내는 `docs/agents/EXEC.md` | 없음 |\n');
    const snapshot = await snapshotPlanSet({ root, planSetId: 'set' });
    assert.deepEqual(snapshot.spec_paths, [], 'no Spec exists and none is required');
    assert.deepEqual(snapshot.design_paths, ['docs/specs/set/requirements.md', 'docs/specs/set/tactical-design.md', 'CONTEXT.md', ...['technology', 'ui-handoff', 'api', 'data'].map((name) => `docs/implementation/set/${name}.md`)]);
    assert.deepEqual(Object.keys(snapshot.inputs).sort(), [...snapshot.design_paths, 'docs/plans/set/first.md', 'docs/plans/set/plans.md'].sort());
    assert.ok(!Object.keys(snapshot.inputs).includes('docs/agents/EXEC.md'));

    // A decision document is part of the review basis, so a change to it affects every ticket.
    await writeFile(join(decisions, 'data.md'), '# data changed\n');
    const impact = await inspectPlanSetImpact({ root, planSetId: 'set' });
    assert.ok(impact.changed_paths.includes('docs/implementation/set/data.md'));
    assert.deepEqual(impact.affected_plan_ids, ['first']);

    // Legacy Spec files of an earlier release stay in the basis when both exist; they are never required.
    await writeFile(join(specs, 'product-spec.md'), '# product\n');
    assert.deepEqual((await snapshotPlanSet({ root, planSetId: 'set' })).spec_paths, [], 'one Spec alone is not a pair');
    await writeFile(join(specs, 'architecture-spec.md'), '# architecture\n');
    const legacy = await snapshotPlanSet({ root, planSetId: 'set' });
    assert.deepEqual(legacy.spec_paths, ['docs/specs/set/product-spec.md', 'docs/specs/set/architecture-spec.md']);
    assert.ok(Object.keys(legacy.inputs).includes('docs/specs/set/architecture-spec.md'));
    await rm(join(specs, 'product-spec.md')); await rm(join(specs, 'architecture-spec.md'));

    // Without any design document there is nothing to review the tickets against.
    for (const path of [join(specs, 'requirements.md'), join(specs, 'tactical-design.md'), join(root, 'CONTEXT.md'), ...['technology', 'ui-handoff', 'api', 'data'].map((name) => join(decisions, `${name}.md`))]) await rm(path);
    await assert.rejects(snapshotPlanSet({ root, planSetId: 'set' }), /no design basis/);
    await writeFile(join(specs, 'requirements.md'), '# requirements\n');

    await mkdir(join(root, '.codex'));
    await mkdir(join(root, '.harness'), { recursive: true });
    await writeFile(join(root, '.harness/harness.yaml'), 'tracker:\n  mode: github\n');
    await mkdir(join(root, '.io'));
    await assert.rejects(updatePlanReview({ root, planSetId: 'set', action: 'begin' }), /missing or empty:.*parent.md.*first.md/);
    const blocked = await inspectPlanSet({ root, planSetId: 'set', phase: 'planning' });
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.reason, /missing or empty:/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
