import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitWorkflowDocuments } from '../.harness/src/workflow/stage-commit.mjs';
import { PRE_SPEC_STAGES, REQUIREMENTS_STAGES, TACTICAL_DESIGN_STAGES } from '../.harness/src/workflow/worktree-stages.mjs';

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
    await writeFile(join(root, 'docs/specs/set/domain-model.md'), '# 도메인 모델\n\n## 1. 모델 후보\n');
    await writeFile(join(root, 'app.txt'), 'app in progress\n');
    assert.equal(await run('domain-model', 'action_required', [], 'USER_DECISION_REQUIRED'), null, 'a stage waiting for the user commits nothing');
    assert.equal(await run('domain-model', 'blocked', [], 'INPUT_MISSING'), null, 'a block for missing evidence commits nothing');
    assert.match(await run('domain-model'), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['docs/specs/set/domain-model.md']);
    assert.equal(lastSubject(), 'domain-model: set');
    assert.match(git('status', '--short'), /M docs\/architecture\/domain-model\.md/);
    assert.match(git('status', '--short'), /M CONTEXT\.md/);

    // Reported project documents join the commit.
    await writeFile(join(root, 'docs/specs/set/domain-model.md'), '# 도메인 모델\n\n## 1. 모델 후보\n\n## 2. Aggregate\n');
    assert.match(await run('aggregate-design', 'completed', listed('docs/architecture/domain-model.md', 'CONTEXT.md')), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['CONTEXT.md', 'docs/architecture/domain-model.md', 'docs/specs/set/domain-model.md']);
    assert.equal(lastSubject(), 'aggregate-design: set');

    // A stage never commits the context map: its owner is bounded-context.
    await writeFile(join(root, 'CONTEXT-MAP.md'), '# Context map\n\n| 바뀐 관계 |\n');
    await writeFile(join(root, 'docs/specs/set/domain-model.md'), '# 도메인 모델\n\n## 3. Domain Service\n');
    assert.match(await run('domain-service', 'completed', listed('CONTEXT-MAP.md')), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['docs/specs/set/domain-model.md']);
    assert.match(git('status', '--short'), /M CONTEXT-MAP\.md/);

    // A tactical stage that stops on an invalidated earlier decision keeps only the rule it added to requirements.md.
    await writeFile(join(root, 'docs/specs/set/requirements.md'), '# 요구사항 명세\n\n- 상태: fixed\n\n  - INV-07 신고는 하루 안에 닫힌다 — 출처: answers.json `q-1`\n');
    await writeFile(join(root, 'docs/specs/set/domain-model.md'), '# 도메인 모델\n\n## 4. 반쯤 쓴 절\n');
    assert.match(await run('integration-design', 'blocked', [], 'DEPENDENCY_INCOMPLETE'), /^[0-9a-f]{40}$/);
    assert.deepEqual(lastFiles(), ['docs/specs/set/requirements.md']);
    assert.equal(lastSubject(), 'integration-design: set');
    assert.match(git('status', '--short'), /M docs\/specs\/set\/domain-model\.md/, 'the half-written section is not committed');
    assert.equal(await run('requirements-fix', 'blocked', [], 'DEPENDENCY_INCOMPLETE'), null, 'only tactical stages keep a rule when they block');

    const status = git('status', '--short', '--untracked-files=all');
    assert.match(status, /M app\.txt$/m, 'application changes stay visible and untouched');
    await rm(raw, { force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
