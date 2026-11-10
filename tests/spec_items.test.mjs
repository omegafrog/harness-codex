import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSpecCoverage, extractSpecContractItems } from '../.harness/src/wrapper/spec-items.mjs';
import { assembleReviews } from '../.harness/src/wrapper/review-input.mjs';

const SPEC = `# Architecture Spec

## 6.5 API Contracts

| Path | Method | Access | Behaviour |
| --- | --- | --- | --- |
| \`/calculator\` | GET/POST | Public | calculator |
| \`/posts/{postId}\` | POST (edit) | Member | edit own post |

## 6.6 Asynchronous Communication

| a | b |
| - | - |
| not | listed |

## 9.1 Authentication and Authorization

- Writes require an authenticated member
- Reads are public
  - nested detail is not an item

### Notes

- still in 9.1

# 10. Observability

- not a contract item
`;

// A Spec review answers each contract item of the Architecture Spec instead of reporting the first mismatch it notices.
test('contract sections of the Architecture Spec are listed item by item', () => {
  const items = extractSpecContractItems(SPEC);
  assert.deepEqual(items.map((item) => item.id), ['S6.5-1', 'S6.5-2', 'S9.1-1', 'S9.1-2', 'S9.1-3']);
  assert.match(items[1].text, /\/posts\/\{postId\}/);
  assert.equal(items[0].line, 7);
  assert.deepEqual(extractSpecContractItems('# Nothing\n\ntext\n'), []);
});

test('a Spec review that skips an item, lacks evidence or leaves a mismatch without a finding is refused', () => {
  const items = extractSpecContractItems(SPEC);
  const entry = (id, verdict = 'match') => ({ id, verdict, evidence: 'src/App.java:1' });
  const all = items.map((item) => entry(item.id));
  assert.doesNotThrow(() => assertSpecCoverage(items, { findings: [], checked: all }));
  assert.doesNotThrow(() => assertSpecCoverage([], { findings: [] }));
  assert.throws(() => assertSpecCoverage(items, { findings: [] }), /must return report\.checked/);
  assert.throws(() => assertSpecCoverage(items, { findings: [], checked: all.slice(1) }), /did not answer 1 of 5 Spec items \(S6\.5-1\)/);
  assert.throws(() => assertSpecCoverage(items, { findings: [], checked: [...all, entry('S9.9-1')] }), /not a listed Spec item/);
  assert.throws(() => assertSpecCoverage(items, { findings: [], checked: all.map((item, index) => index ? item : { ...item, evidence: ' ' }) }), /needs evidence/);
  const mismatch = all.map((item, index) => index === 1 ? entry(item.id, 'mismatch') : item);
  assert.throws(() => assertSpecCoverage(items, { findings: [], checked: mismatch }), /no finding that lists them in spec_items: S6\.5-2/);
  assert.doesNotThrow(() => assertSpecCoverage(items, { findings: [{ id: 'F', spec_items: ['S6.5-2'] }], checked: mismatch }));
});

test('assembling reviews applies the coverage rule to the Spec reviewer only', () => {
  const items = extractSpecContractItems(SPEC);
  const reviewInput = { implementation_commit_sha: 'c1' };
  const raw = (report) => JSON.stringify({ state: 'passed', report });
  const standards = { contextId: 'std-1', raw: raw({ findings: [] }) };
  assert.throws(() => assembleReviews({ reviewInput, standards, spec: { contextId: 'spec-1', raw: raw({ findings: [] }) }, specItems: items }), /must return report\.checked/);
  const checked = items.map((item) => ({ id: item.id, verdict: 'match', evidence: 'x:1' }));
  const evidence = assembleReviews({ reviewInput, standards, spec: { contextId: 'spec-1', raw: raw({ findings: [], checked }) }, specItems: items });
  assert.equal(evidence.reviews.length, 2);
});

// Reviewers run `spec-items` before the Spec review; it works from the worktree without a plan ID.
test('harness-code-review spec-items lists the Architecture Spec items of the worktree plan set', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../.codex/scripts/harness-code-review.mjs', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'spec-items-'));
  const primary = join(directory, 'primary'), root = join(directory, 'workspace');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', primary]);
    execFileSync('git', ['-C', primary, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '--allow-empty', '-qm', 'base']);
    execFileSync('git', ['-C', primary, 'worktree', 'add', '-qb', 'feature/test', root]);
    await mkdir(join(root, 'docs/specs/set'), { recursive: true });
    await mkdir(join(root, '.io'), { recursive: true });
    await writeFile(join(root, 'docs/specs/set/architecture-spec.md'), SPEC);
    await writeFile(join(root, '.io/worktree.json'), JSON.stringify({ schema_version: 1, worktree_id: 'c5c669a2-2967-4831-98db-63a24954e857', workspace: root, common: join(primary, '.git'), return_root: primary, session_directory: join(root, '.io'), branch: 'feature/test', state: 'active', plan_set_id: 'set' }));
    const result = JSON.parse(execFileSync(process.execPath, [script, 'spec-items'], { cwd: root, encoding: 'utf8' }));
    assert.equal(result.spec_path, 'docs/specs/set/architecture-spec.md');
    assert.deepEqual(result.items.map((item) => item.id), ['S6.5-1', 'S6.5-2', 'S9.1-1', 'S9.1-2', 'S9.1-3']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// A mistyped path to evidence the stage does not own must not fail a stage whose work is done.
test('a missing artifact that the stage does not declare as an output is dropped, a declared one is kept', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { dropMissingUndeclaredArtifacts } = await import('../.harness/src/workflow/result-artifacts.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'artifacts-'));
  try {
    await writeFile(join(directory, 'real.json'), '{}');
    const result = { summary: 'done', artifacts: [
      { base: 'workspace', path: 'real.json', kind: 'prior_evidence' },
      { base: 'workspace', path: 'e2e/01cc65fd-f0f5f73e0e3d/failure.json', kind: 'prior_evidence' },
      { base: 'workspace', path: 'missing-output.md', kind: 'checkpoint' },
    ] };
    const dropped = dropMissingUndeclaredArtifacts({ result, outputs: [{ id: 'checkpoint' }], baseDirectory: () => directory });
    assert.deepEqual(dropped, ['prior_evidence:e2e/01cc65fd-f0f5f73e0e3d/failure.json']);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.path), ['real.json', 'missing-output.md']);
    assert.match(result.summary, /dropped 1 undeclared artifact/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// A failing E2E whose evidence shows only a test-code defect is fixed and rerun without a user decision round.
test('the orchestrator and the E2E guide point at the test-defect fast path', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const path = '.codex/internal-skills/e2e-test/references/test-defect-fast-path.md';
  const fast = await read(path);
  assert.match(fast, /단언을 약하게 만들지 않는다/);
  assert.match(fast, /3회 미만/);
  assert.match(await read('.codex/internal-skills/e2e-test/GUIDE.md'), /references\/test-defect-fast-path\.md/);
  assert.match(await read('.codex/skills/orchestrator/SKILL.md'), /test-defect-fast-path\.md/);
});

// Ending the orchestrator's turn aborts the sub-agents it started, so the E2E runner reported nothing.
test('the orchestrator waits for sub-agents instead of ending the turn on them', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.match(await read('.codex/skills/orchestrator/references/implementation.md'), /최종 보고를 돌려줄 때까지 이 턴 안에서 기다린다/);
  assert.match(await read('.codex/skills/orchestrator/SKILL.md'), /하위 agent는 결과를 받을 때까지 이 턴에서 기다린다/);
});
