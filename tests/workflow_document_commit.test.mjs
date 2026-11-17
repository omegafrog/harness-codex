import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitWorkflowDocuments, migrateLegacyTacticalDesign, restartDocuments } from '../.harness/src/workflow/stage-commit.mjs';
import { LEGACY_TACTICAL_DESIGN_DOCUMENT, PRE_SPEC_STAGES, REQUIREMENTS_STAGES, TACTICAL_DESIGN_DOCUMENT, TACTICAL_DESIGN_STAGES, currentTacticalDesignPath } from '../.harness/src/workflow/worktree-stages.mjs';

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

// The analysis is a plan set document; the stakeholder cards it read belong to the project and are never committed by the runner.
test('stakeholder-analysis commits only its plan set document and leaves project stakeholder cards visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stakeholder-docs-'));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    await writeFile(join(root, 'CONTEXT.md'), '# Context\n');
    git('add', '.'); git('commit', '-qm', 'base');
    for (const dir of ['docs/specs/set', 'docs/domain/stakeholders']) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, 'docs/specs/set/stakeholder-analysis.md'), '# Stakeholder 분석\n');
    await writeFile(join(root, 'docs/domain/stakeholders/SH-01.md'), '---\nid: SH-01\n---\n');
    await writeFile(join(root, 'CONTEXT.md'), '# Context\n\n- Account\n');
    const raw = join(root, '..', `${Date.now()}-stakeholder-raw.json`);
    const result = async (status, planSetId = 'set') => { await writeFile(raw, JSON.stringify({ status })); return commitWorkflowDocuments({ root, input: { skill: 'stakeholder-analysis', context: { plan_set_id: planSetId } }, rawPath: raw }); };
    assert.equal(await result('action_required'), null, 'a stage waiting for the user commits nothing');
    assert.equal(await result('completed', '../escape'), null, 'a plan set ID that is not a plain name is refused');
    assert.match(await result('completed'), /^[0-9a-f]{40}$/);
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['docs/specs/set/stakeholder-analysis.md']);
    assert.equal(git('log', '-1', '--format=%s'), 'stakeholder-analysis: set');
    // The card and the glossary stay untracked or modified for their owner.
    const status = git('status', '--short', '--untracked-files=all');
    assert.match(status, /\?\? docs\/domain\/stakeholders\/SH-01\.md/);
    assert.match(status, /^M CONTEXT\.md/m);
    assert.equal(await result('completed'), null, 'nothing to commit is not an error');
    await rm(raw, { force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Every requirements stage commits the plan set's documents when it completes; only ubiquitous-language also commits the glossary.
test('each requirements stage commits docs/specs of its plan set, bounded-context also commits CONTEXT-MAP.md, ubiquitous-language CONTEXT.md, and project cards stay visible', async () => {
  assert.deepEqual(REQUIREMENTS_STAGES, ['stakeholder-analysis', 'subdomain-candidates', 'ubiquitous-language', 'event-storming', 'subdomain-classification', 'bounded-context', 'requirements-fix']);
  const root = await mkdtemp(join(tmpdir(), 'requirements-docs-'));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    await writeFile(join(root, 'CONTEXT.md'), '# Context\n');
    await writeFile(join(root, 'CONTEXT-MAP.md'), '# Context map\n');
    await writeFile(join(root, 'app.txt'), 'app\n');
    git('add', '.'); git('commit', '-qm', 'base');
    for (const dir of ['docs/specs/set/diagrams/events', 'docs/domain/stakeholders']) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, 'docs/domain/stakeholders/SH-01.md'), '---\nid: SH-01\n---\n');
    const raw = join(root, '..', `${Date.now()}-requirements-raw.json`);
    const run = async (skill, status = 'completed', artifacts = []) => { await writeFile(raw, JSON.stringify({ status, result: { artifacts } })); return commitWorkflowDocuments({ root, input: { skill, context: { plan_set_id: 'set' } }, rawPath: raw }); };
    const lastFiles = () => git('show', '--name-only', '--format=', 'HEAD').split('\n').sort();
    const lastSubject = () => git('log', '-1', '--format=%s');

    await writeFile(join(root, 'docs/specs/set/requirements.md'), '# 요구사항 명세\n\n- 상태: draft\n');
    await writeFile(join(root, 'docs/specs/set/stakeholder-analysis.md'), '# Stakeholder 분석\n');
    await writeFile(join(root, 'CONTEXT.md'), '# Context\n\n- 게시글\n');
    await writeFile(join(root, 'app.txt'), 'app in progress\n');
    assert.equal(await run('subdomain-candidates', 'action_required'), null, 'a stage waiting for the user commits nothing');
    assert.match(await run('stakeholder-analysis'), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['docs/specs/set/requirements.md', 'docs/specs/set/stakeholder-analysis.md']);
    assert.equal(lastSubject(), 'stakeholder-analysis: set');

    await writeFile(join(root, 'docs/specs/set/requirements.md'), '# 요구사항 명세\n\n- 상태: draft\n\n## 1. 서브도메인 후보\n');
    assert.match(await run('subdomain-candidates'), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['docs/specs/set/requirements.md']);
    assert.equal(lastSubject(), 'subdomain-candidates: set');

    await writeFile(join(root, 'docs/specs/set/requirements.md'), '# 요구사항 명세\n\n- 상태: draft\n\n## 3. 용어\n');
    assert.match(await run('ubiquitous-language'), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['CONTEXT.md', 'docs/specs/set/requirements.md']);
    assert.equal(lastSubject(), 'ubiquitous-language: set');

    // Diagrams are plan set documents, so the event stage commits the sources and renders together.
    await writeFile(join(root, 'docs/specs/set/diagrams/events/SD-01.events.puml'), '@startuml\n@enduml\n');
    await writeFile(join(root, 'docs/specs/set/diagrams/events/SD-01.events.svg'), '<svg/>\n');
    assert.match(await run('event-storming'), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['docs/specs/set/diagrams/events/SD-01.events.puml', 'docs/specs/set/diagrams/events/SD-01.events.svg']);

    // The classification and the context decision change the plan set's documents; only the context decision also settles the map.
    await writeFile(join(root, 'CONTEXT-MAP.md'), '# Context map\n\n| 커뮤니티 |\n');
    await writeFile(join(root, 'docs/specs/set/requirements.md'), '# 요구사항 명세\n\n- 상태: draft\n\n## 1. 서브도메인 후보\n\n| SD-01 | 확정 |\n');
    assert.match(await run('subdomain-classification'), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['docs/specs/set/requirements.md'], 'a stage that does not own the context map leaves it for the bounded-context stage');
    assert.equal(lastSubject(), 'subdomain-classification: set');
    await writeFile(join(root, 'docs/specs/set/requirements.md'), '# 요구사항 명세\n\n- 상태: draft\n\n### 1.1 바운디드 컨텍스트\n');
    await writeFile(join(root, 'CONTEXT.md'), '# Context\n\n- 게시글 (커뮤니티)\n');
    assert.match(await run('bounded-context'), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['CONTEXT-MAP.md', 'docs/specs/set/requirements.md'], 'an unreferenced project glossary stays uncommitted');
    assert.match(git('status', '--short'), /M CONTEXT\.md/);
    await writeFile(join(root, 'docs/specs/set/requirements.md'), '# 요구사항 명세\n\n- 상태: draft\n\n### 1.1 바운디드 컨텍스트\n\n커뮤니티\n');
    await writeFile(join(root, 'CONTEXT-MAP.md'), '# Context map\n\n| 커뮤니티 확정 |\n');
    assert.match(await run('bounded-context', 'completed', [{ base: 'workspace', path: 'CONTEXT.md' }]), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['CONTEXT-MAP.md', 'CONTEXT.md', 'docs/specs/set/requirements.md']);
    assert.equal(lastSubject(), 'bounded-context: set');

    // Other stages leave the glossary and the map to their owners even when they changed.
    await writeFile(join(root, 'CONTEXT.md'), '# Context\n\n- 게시글\n- 댓글\n');
    await writeFile(join(root, 'CONTEXT-MAP.md'), '# Context map\n\n| 커뮤니티 |\n| 신고 |\n');
    await writeFile(join(root, 'docs/specs/set/requirements.md'), '# 요구사항 명세\n\n- 상태: fixed\n');
    assert.match(await run('requirements-fix'), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['docs/specs/set/requirements.md']);
    assert.equal(lastSubject(), 'requirements-fix: set');
    assert.equal(await run('requirements-fix'), null, 'nothing to commit is not an error');

    const status = git('status', '--short', '--untracked-files=all');
    assert.match(status, /\?\? docs\/domain\/stakeholders\/SH-01\.md/, 'cards are never committed by a requirements stage');
    assert.match(status, /M app\.txt$/m, 'application changes stay visible and untouched');
    assert.match(status, /M CONTEXT\.md$/m, 'the glossary changed after its stage stays visible');
    assert.match(status, /M CONTEXT-MAP\.md$/m, 'the context map changed after its stage stays visible');
    await rm(raw, { force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// The tactical design stages commit the plan set's documents; the project's model rows and glossary only when the stage
// reports them, so the project's own edits to those files are never swept into a stage commit.
test('each tactical design stage commits docs/specs of its plan set, project documents only when reported, and a block that kept a rule commits that rule', async () => {
  assert.deepEqual(TACTICAL_DESIGN_STAGES, ['domain-model', 'aggregate-design', 'domain-service', 'application-service', 'integration-design']);
  assert.deepEqual(PRE_SPEC_STAGES, [...REQUIREMENTS_STAGES, ...TACTICAL_DESIGN_STAGES], 'one ordered list covers the flow before spec-me');
  const root = await mkdtemp(join(tmpdir(), 'tactical-docs-'));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    await mkdir(join(root, 'docs/architecture'), { recursive: true });
    await mkdir(join(root, 'docs/specs/set'), { recursive: true });
    await writeFile(join(root, 'CONTEXT.md'), '# Context\n');
    await writeFile(join(root, 'CONTEXT-MAP.md'), '# Context map\n');
    await writeFile(join(root, 'docs/architecture/domain-model.md'), '# 모델 색인\n');
    await writeFile(join(root, 'docs/specs/set/requirements.md'), '# 요구사항 명세\n\n- 상태: fixed\n');
    await writeFile(join(root, 'app.txt'), 'app\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const raw = join(root, '..', `${Date.now()}-tactical-raw.json`);
    const run = async (skill, status = 'completed', artifacts = [], code = 'OK') => { await writeFile(raw, JSON.stringify({ status, code, result: { artifacts } })); return commitWorkflowDocuments({ root, input: { skill, context: { plan_set_id: 'set' } }, rawPath: raw }); };
    const lastFiles = () => git('show', '--name-only', '--format=', 'HEAD').split('\n').sort();
    const lastSubject = () => git('log', '-1', '--format=%s');
    const listed = (...paths) => paths.map((path) => ({ base: 'workspace', path }));

    // The project edits its own model rows and glossary; a stage that did not report them leaves those edits alone.
    await writeFile(join(root, 'docs/architecture/domain-model.md'), '# 모델 색인\n\n프로젝트가 직접 고친 행\n');
    await writeFile(join(root, 'CONTEXT.md'), '# Context\n\n- 프로젝트가 직접 고친 용어\n');
    await writeFile(join(root, 'docs/specs/set/tactical-design.md'), '# 전술 설계\n\n## 1. 모델 후보\n');
    await writeFile(join(root, 'app.txt'), 'app in progress\n');
    assert.equal(await run('domain-model', 'action_required', [], 'USER_DECISION_REQUIRED'), null, 'a stage waiting for the user commits nothing');
    assert.equal(await run('domain-model', 'blocked', [], 'INPUT_MISSING'), null, 'a block for missing evidence commits nothing');
    assert.match(await run('domain-model'), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['docs/specs/set/tactical-design.md']);
    assert.equal(lastSubject(), 'domain-model: set');
    assert.match(git('status', '--short'), /M docs\/architecture\/domain-model\.md/);
    assert.match(git('status', '--short'), /M CONTEXT\.md/);

    // Reported project documents join the commit.
    await writeFile(join(root, 'docs/specs/set/tactical-design.md'), '# 전술 설계\n\n## 1. 모델 후보\n\n## 2. Aggregate\n');
    assert.match(await run('aggregate-design', 'completed', listed('docs/architecture/domain-model.md', 'CONTEXT.md')), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['CONTEXT.md', 'docs/architecture/domain-model.md', 'docs/specs/set/tactical-design.md']);
    assert.equal(lastSubject(), 'aggregate-design: set');

    // A stage never commits the context map: its owner is bounded-context.
    await writeFile(join(root, 'CONTEXT-MAP.md'), '# Context map\n\n| 바뀐 관계 |\n');
    await writeFile(join(root, 'docs/specs/set/tactical-design.md'), '# 전술 설계\n\n## 3. Domain Service\n');
    assert.match(await run('domain-service', 'completed', listed('CONTEXT-MAP.md')), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['docs/specs/set/tactical-design.md']);
    assert.match(git('status', '--short'), /M CONTEXT-MAP\.md/);

    // A tactical stage that stops on an invalidated earlier decision keeps only the rule it added to requirements.md.
    await writeFile(join(root, 'docs/specs/set/requirements.md'), '# 요구사항 명세\n\n- 상태: fixed\n\n  - INV-07 신고는 하루 안에 닫힌다 — 출처: answers.json `q-1`\n');
    await writeFile(join(root, 'docs/specs/set/tactical-design.md'), '# 전술 설계\n\n## 4. 반쯤 쓴 절\n');
    assert.match(await run('integration-design', 'blocked', [], 'DEPENDENCY_INCOMPLETE'), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['docs/specs/set/requirements.md']);
    assert.equal(lastSubject(), 'integration-design: set');
    assert.match(git('status', '--short'), /M docs\/specs\/set\/tactical-design\.md/, 'the half-written section is not committed');
    assert.equal(await run('requirements-fix', 'blocked', [], 'DEPENDENCY_INCOMPLETE'), null, 'only tactical stages keep a rule when they block');

    const status = git('status', '--short', '--untracked-files=all');
    assert.match(status, /M app\.txt$/m, 'application changes stay visible and untouched');
    await rm(raw, { force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A plan set that an earlier Harness started holds the tactical design as domain-model.md. The runner renames it before a tactical
// stage runs, as `git mv` does, and the stage commit that follows carries the rename, even when the stage blocks.
test('migrateLegacyTacticalDesign renames only a legacy plan set document as git mv does, and a block commits the pending rename', async () => {
  assert.equal(TACTICAL_DESIGN_DOCUMENT, 'tactical-design.md');
  assert.equal(LEGACY_TACTICAL_DESIGN_DOCUMENT, 'domain-model.md');
  assert.deepEqual(restartDocuments('aggregate-design', 'set'), ['docs/specs/set/tactical-design.md', 'docs/specs/set/domain-model.md', 'docs/architecture/domain-model.md', 'CONTEXT.md']);
  const legacy = 'docs/specs/set/domain-model.md';
  const current = 'docs/specs/set/tactical-design.md';
  assert.equal(currentTacticalDesignPath(legacy), current, 'a recorded artifact path follows the rename');
  assert.equal(currentTacticalDesignPath('docs/architecture/domain-model.md'), 'docs/architecture/domain-model.md', 'the project model index is not a plan set document');
  assert.equal(currentTacticalDesignPath('docs/specs/set/nested/domain-model.md'), 'docs/specs/set/nested/domain-model.md');
  const document = '# 전술 설계\n\n## 1. 모델 후보\n';
  const directories = [];
  const fixture = async (files) => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-tactical-'));
    directories.push(root);
    const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    for (const [path, content] of Object.entries({ 'app.txt': 'app\n', 'docs/architecture/domain-model.md': '# 모델 색인\n', 'docs/specs/set/requirements.md': '# 요구사항 명세\n\n- 상태: fixed\n', ...files })) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    }
    git('add', '.'); git('commit', '-qm', 'base');
    return { root, git };
  };
  try {
    // A tracked legacy document is renamed in the working tree and in the index: history follows the file.
    const { root, git } = await fixture({ [legacy]: document });
    assert.deepEqual(await migrateLegacyTacticalDesign({ root, planSetId: 'set' }), { from: legacy, to: current });
    assert.equal(git('status', '--short', '--untracked-files=all'), `R  ${legacy} -> ${current}`, 'the rename is staged and nothing else changed');
    assert.equal(await readFile(join(root, current), 'utf8'), document);
    assert.equal(await readFile(join(root, 'docs/architecture/domain-model.md'), 'utf8'), '# 모델 색인\n', 'the project model index is never renamed');
    assert.equal(await migrateLegacyTacticalDesign({ root, planSetId: 'set' }), null, 'a second preparation has nothing to rename');

    // The stage blocks on an earlier decision: the commit keeps the rule it added and the rename, so the tree is clean for the restart.
    const raw = join(root, '..', `${Date.now()}-legacy-raw.json`);
    await writeFile(join(root, 'docs/specs/set/requirements.md'), '# 요구사항 명세\n\n- 상태: fixed\n\n  - INV-07 신고는 하루 안에 닫힌다 — 출처: answers.json `q-1`\n');
    await writeFile(raw, JSON.stringify({ status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', result: { artifacts: [] } }));
    const sha = await commitWorkflowDocuments({ root, input: { skill: 'aggregate-design', context: { plan_set_id: 'set' } }, rawPath: raw });
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.deepEqual(git('show', '--name-status', '-M', '--format=', 'HEAD').split('\n').sort(), [`M\tdocs/specs/set/requirements.md`, `R100\t${legacy}\t${current}`]);
    assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'the tree is clean');
    assert.deepEqual(git('log', '--follow', '--format=%s', '--', current).split('\n'), ['aggregate-design: set', 'base']);
    await rm(raw, { force: true });

    // Nothing to rename: no legacy document, or the current name already exists (the plan set is never merged by guesswork).
    const none = await fixture({ [current]: document });
    assert.equal(await migrateLegacyTacticalDesign({ root: none.root, planSetId: 'set' }), null);
    const both = await fixture({ [legacy]: 'old\n', [current]: document });
    assert.equal(await migrateLegacyTacticalDesign({ root: both.root, planSetId: 'set' }), null);
    assert.equal(await readFile(join(both.root, legacy), 'utf8'), 'old\n');
    assert.equal(await readFile(join(both.root, current), 'utf8'), document);
    assert.equal(both.git('status', '--short'), '');
    const empty = await fixture({});
    assert.equal(await migrateLegacyTacticalDesign({ root: empty.root, planSetId: 'set' }), null);

    // After a restart the checkpoint's legacy file is back in the working tree without the index, while HEAD holds the current name.
    const restarted = await fixture({ [current]: 'committed after the rename\n' });
    await rm(join(restarted.root, current));
    await writeFile(join(restarted.root, legacy), document);
    assert.deepEqual(await migrateLegacyTacticalDesign({ root: restarted.root, planSetId: 'set' }), { from: legacy, to: current });
    assert.equal(restarted.git('diff', '--name-status'), `M\t${current}`, 'the document is an unstaged modification of the committed one, as for any document the stage rewrites');
    assert.equal(restarted.git('diff', '--cached', '--name-status'), '', 'nothing is staged');
    assert.equal(await readFile(join(restarted.root, current), 'utf8'), document);

    // A legacy name that is not a regular file is refused, as is an invalid plan set.
    const linked = await fixture({ 'outside.md': 'outside\n' });
    await symlink(join(linked.root, 'outside.md'), join(linked.root, legacy));
    await assert.rejects(migrateLegacyTacticalDesign({ root: linked.root, planSetId: 'set' }), /regular file/);
    await assert.rejects(migrateLegacyTacticalDesign({ root, planSetId: '../set' }), /Invalid plan_set_id/);
  } finally { for (const directory of directories) await rm(directory, { recursive: true, force: true }); }
});
