import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { PRE_SPEC_STAGES, REQUIREMENTS_STAGES, TACTICAL_DESIGN_STAGES, WORKTREE_STAGE } from '../.harness/src/workflow/worktree-stages.mjs';
import { MODELS, SETUP, STAGE_TIERS, consumerWorkflow, gitIn, sourceRoot } from './support/consumer-workflow.mjs';
import { REQUIREMENTS, templateDocument, upTo } from './support/domain-model-fixture.mjs';

const TEMPLATE = '.codex/internal-skills/domain-model/references/template.md';
const DEEPENING = '.codex/internal-skills/domain-model/references/deepening.md';
const GATE = '.codex/scripts/harness-domain-model-check.mjs';
const TACTICAL_TIERS = { 'domain-model': 'high_performance', 'aggregate-design': 'high_performance', 'domain-service': 'implementation', 'application-service': 'implementation', 'integration-design': 'high_performance' };
const ASKING = ['aggregate-design', 'integration-design'];
const read = (path) => readFile(join(sourceRoot, path), 'utf8');

test('the tactical stages follow the requirements flow in one ordered list, and the orchestrator, the map, the README and every guide agree on it', async () => {
  assert.deepEqual(TACTICAL_DESIGN_STAGES, ['domain-model', 'aggregate-design', 'domain-service', 'application-service', 'integration-design']);
  assert.deepEqual(PRE_SPEC_STAGES, [...REQUIREMENTS_STAGES, ...TACTICAL_DESIGN_STAGES]);
  assert.equal(PRE_SPEC_STAGES.at(REQUIREMENTS_STAGES.length - 1), 'requirements-fix');
  for (const stage of TACTICAL_DESIGN_STAGES) assert.ok(Object.values(WORKTREE_STAGE).includes(stage), `${stage} is a worktree stage`);
  assert.deepEqual(Object.keys(STAGE_TIERS).sort(), [...PRE_SPEC_STAGES].sort(), 'every stage of the flow before spec-me has a declared tier in the shared fixture');

  const orchestrator = await read('.codex/skills/orchestrator/SKILL.md');
  assert.ok(orchestrator.includes(TACTICAL_DESIGN_STAGES.map((stage) => `\`${stage}\``).join(' → ')), 'the orchestrator names the tactical flow in order');
  assert.match(orchestrator, /전술 설계 흐름에서 완료되지 않은 첫 stage/);
  assert.match(orchestrator, /요구사항 흐름과 전술 설계 흐름이 모두 완료됐거나 이미 `spec-me`가 시작됨/);
  assert.match(orchestrator, /`DEPENDENCY_INCOMPLETE`/);
  assert.match(orchestrator, /restart를 먼저 하고 요구사항 수정은 그 뒤에 한다/);
  const map = await read('.codex/internal-skills/skill-execution/references/workflow-map.md');
  const positions = PRE_SPEC_STAGES.map((stage) => map.indexOf(`\`${stage}\``));
  assert.ok(positions.every((position) => position >= 0) && positions.every((position, index) => index === 0 || position > positions[index - 1]), 'the workflow map names every stage before spec-me in order');
  assert.match(map, /harness-domain-model-check\.mjs/);
  const readme = await read('README.md');
  assert.ok(readme.includes(TACTICAL_DESIGN_STAGES.map((stage) => `\`${stage}\``).join(' → ')));
  assert.match(readme, /#### 전술 설계 흐름/);
  for (const stage of TACTICAL_DESIGN_STAGES) assert.ok(readme.includes(`| \`${stage}\` |`), `${stage} has a README row`);
  const exec = await read('docs/agents/EXEC.md');
  assert.ok(exec.includes(TACTICAL_DESIGN_STAGES.map((stage) => `\`${stage}\``).join('→')), 'the E2E procedure names the tactical flow');
  assert.match(await read('docs/architecture/enforcement.md'), /TACTICAL_DESIGN_STAGES[\s\S]*harness-domain-model-check\.mjs/);
  assert.match(await read('CONTEXT.md'), /\| Consistency Decision \| 일관성 결정 \|/);
  assert.match(await read('.codex/internal-skills/skill-execution/references/dispatch.md'), /요구사항·전술 설계 stage의 문서를 고치라고 지시하면/);
  assert.match(await read('.codex/internal-skills/skill-execution/references/input.md'), /요구사항 또는 전술 설계 stage부터 다시 시작/);

  // The requirements template points at the tactical documents and lets only the asking stages add a rule from a user's answer.
  const requirementsTemplate = await read('.codex/internal-skills/requirements-fix/references/template.md');
  assert.match(requirementsTemplate, /\| `domain-model`부터 `integration-design`까지 \|/);
  assert.match(requirementsTemplate, /질문을 하는 stage\(`aggregate-design`, `integration-design`\)/);

  // The template owns the document shape the gate reads.
  const document = await templateDocument(sourceRoot);
  assert.deepEqual([...document.matchAll(/^## (.+)$/gm)].map((match) => match[1]), ['1. 모델 후보', '2. Aggregate', '3. Domain Service', '4. Application Service', '5. 통합 설계', '6. 결정 이력']);
  assert.match(document, /^\| 모델 \| 종류 \| BC \| 정체성·생애주기 또는 값의 의미 \| 현재 상태 \| 근거 \|$/m);
  assert.match(document, /^\| 요구 \| BC \| 소유 모델 \| 근거 \|$/m);
  assert.match(document, /^\| CON \| 규칙 \| 걸친 Aggregate \| 일관성 \| 결정 \| 근거·출처 \|$/m);
  assert.match(document, /^\| DEC \| stage \| 대상 \| 결정 \| 비교한 대안 \| 출처 \|$/m);
  const template = await read(TEMPLATE);
  assert.match(template, /^\| Context \/ 모델 ID \| 상태 \| Root \/ 소유 코드 \| 규칙 ID → enforcement \| 데이터 \/ transaction \| 공개 계약 \/ 통신 \| deployment \/ extraction trigger \| 근거 \|$/m, 'the project model row format is the model-continuity one');
  assert.match(template, /`accepted-target`/);
  assert.doesNotMatch(template, /classDiagram|@startuml/, 'no class diagram yet');

  // Each stage guide links the shared documents, keeps its own boundary and returns through the common contract.
  for (const stage of TACTICAL_DESIGN_STAGES) {
    const guide = await read(`.codex/internal-skills/${stage}/GUIDE.md`);
    assert.match(guide, new RegExp(`^---\\nmodel_tier: ${TACTICAL_TIERS[stage]}\\n---\\n<!-- 내부 workflow 전용`), `${stage} declares its tier and stays internal`);
    assert.match(guide, /domain-model\/references\/template\.md|\(references\/template\.md\)/, `${stage} links the template`);
    assert.match(guide, /domain-model\/references\/deepening\.md|\(references\/deepening\.md\)/, `${stage} links the shared rules`);
    for (const part of ['## Purpose', '## Inputs', '## Prohibited', '## Process', '## Deepening', '## Completion']) assert.ok(guide.includes(part), `${stage} has ${part}`);
    assert.match(guide, /harness-workspace-preflight\.mjs/, `${stage} runs the preflight`);
    assert.match(guide, /harness-spec-path\.mjs/, `${stage} resolves paths with the helper`);
    assert.match(guide, /`판정: 생략`/, `${stage} records a skip`);
    assert.match(guide, new RegExp(`harness-domain-model-check\\.mjs --workspace-root <workspace_root> --stage ${stage}\``), `${stage} runs its gate before it completes`);
    assert.match(guide, /The runner commits `docs\/specs\/<plan-set-id>\/`/, `${stage} says what the runner commits`);
    assert.match(guide, /`DEPENDENCY_INCOMPLETE`|`INPUT_MISSING`/, `${stage} says how it blocks`);
    assert.match(guide, /requirements\.md/, `${stage} reads the requirements`);
    assert.doesNotMatch(guide, /ddd-design|spec-me\/GUIDE|architecture-spec/, `${stage} does not depend on the older design guides`);
    if (ASKING.includes(stage)) {
      assert.match(guide, /`action_required` \/ `USER_DECISION_REQUIRED`/, `${stage} may ask`);
      assert.match(guide, /in Korean/, `${stage} asks in Korean`);
      assert.match(guide, /a recommended option/, `${stage} recommends an option`);
      assert.match(guide, /one batch/, `${stage} asks in one batch`);
      assert.match(guide, /`answers\.json`/, `${stage} records the answer source`);
      assert.match(guide, /`INV` or `EX` with its `AC`/, `${stage} adds a discovered rule to the requirements`);
    } else {
      assert.doesNotMatch(guide, /`USER_DECISION_REQUIRED`/, `${stage} never asks`);
      assert.match(guide, /never adds a business rule|never add|Asking the user/, `${stage} adds no rule and asks nothing`);
    }
    if (stage === 'domain-model') assert.match(guide, /code-research\/GUIDE\.md/); else assert.doesNotMatch(guide, /code-research/, `${stage} does not run code-research`);
  }
  const model = await read('.codex/internal-skills/domain-model/GUIDE.md');
  assert.match(model, /기존 모델 없음/);
  assert.match(model, /`core` gets a rich model, `supporting` only what its rules need, `generic` a minimal model or an `외부 시스템` marker/);
  assert.match(model, /build-versus-buy undecided/);
  assert.match(model, /language lifecycle/);
  assert.match(model, /`accepted-target`/);
  const aggregate = await read('.codex/internal-skills/aggregate-design/GUIDE.md');
  assert.match(aggregate, /Mapping one `BIZ` to one Aggregate mechanically/);
  assert.match(aggregate, /merge and record it/);
  assert.match(aggregate, /referenced by ID only, and one transaction changes one Aggregate/);
  assert.match(aggregate, /the business consequence/);
  const service = await read('.codex/internal-skills/domain-service/GUIDE.md');
  assert.match(service, /Orchestration, transaction boundaries, persistence, repository calls, publishing events or any external effect/);
  const application = await read('.codex/internal-skills/application-service/GUIDE.md');
  assert.match(application, /Making a domain decision/);
  assert.match(application, /One transaction that changes more than one Aggregate/);
  const integration = await read('.codex/internal-skills/integration-design/GUIDE.md');
  assert.match(integration, /Saga or Outbox/);
  assert.match(integration, /`판단 소유자`/);
  assert.match(integration, /whether the caller must get a confirmed answer at once/);
  const deepening = await read(DEEPENING);
  for (const text of ['`--restart-requirements true`', '`--user-revision true --feedback', '`blocked` / `DEPENDENCY_INCOMPLETE`', '`blocked` / `INPUT_MISSING`', 'harness-domain-model-check.mjs', '`영향받는 이후 stage`', 'language-lifecycle.md']) assert.ok(deepening.includes(text), `the shared rules say ${text}`);

  // Only the flow list decides the order: the package runs the tests that guard it.
  const scripts = JSON.parse(await read('package.json')).scripts.test;
  for (const file of ['tests/domain_model_check.test.mjs', 'tests/tactical_design_stages.test.mjs']) assert.ok(scripts.includes(file), `npm test runs ${file}`);
});

test('installed consumers get the tactical design assets, Git ignores them and keeps the plan set and project model documents visible', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tactical-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = gitIn(root);
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, 'docs/architecture'), { recursive: true });
  await writeFile(join(root, 'app.txt'), 'original application\n');
  await writeFile(join(root, 'CONTEXT.md'), '# 프로젝트 컨텍스트\n');
  await writeFile(join(root, 'CONTEXT-MAP.md'), '# 소비자 소유 관계\n');
  await writeFile(join(root, 'docs/architecture/domain-model.md'), '# 소비자 모델 색인\n');
  git('add', 'app.txt', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
  await writeFile(join(root, 'app.txt'), 'ongoing application change\n');
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  await writeFile(join(root, '.harness/harness.yaml'), SETUP);

  const managed = [
    ...TACTICAL_DESIGN_STAGES.map((name) => `.codex/internal-skills/${name}/GUIDE.md`),
    TEMPLATE, DEEPENING, GATE,
    '.harness/src/workflow/worktree-stages.mjs',
    '.harness/src/workflow/stage-commit.mjs',
    '.harness/src/workflow/stage-input.mjs',
    '.harness/src/workflow/requirements-restart.mjs',
    '.codex/scripts/harness-result.mjs',
    '.codex/skills/setup/assets/CONTEXT-MAP.md',
  ].map((path) => path.replace('.codex/skills/setup', '.agents/skills/setup'));
  const lock = JSON.parse(await readFile(join(root, '.codex/harness-lock.json'), 'utf8'));
  for (const path of managed) {
    assert.ok(existsSync(join(root, path)), `installed: ${path}`);
    assert.ok(lock.files[path], `lock inventory: ${path}`);
    assert.match(git('check-ignore', '-v', path), /info\/exclude/, `ignored: ${path}`);
    assert.equal(await readFile(join(root, path), 'utf8'), await read(lock.files[path].source_path), `same content as its source: ${path}`);
  }

  // The tiers resolve from the installed guides, and the installed gate and flow lists are the source ones.
  const binding = (skill) => JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-skill-execution.mjs'), 'binding', '--root', root, '--skill', skill], { cwd: root, encoding: 'utf8' }));
  for (const [stage, tier] of Object.entries(TACTICAL_TIERS)) assert.deepEqual(binding(stage), { skill: stage, provider: 'codex', model_tier: tier, model: MODELS[tier], reasoning_effort: tier === 'high_performance' ? 'high' : 'medium' }, stage);
  const installedStages = await import(pathToFileURL(join(root, '.harness/src/workflow/worktree-stages.mjs')));
  assert.deepEqual([...installedStages.PRE_SPEC_STAGES], PRE_SPEC_STAGES);
  const installedCommit = await import(pathToFileURL(join(root, '.harness/src/workflow/stage-commit.mjs')));
  assert.deepEqual(installedCommit.restartDocuments('domain-model', 'x'), ['docs/specs/x/domain-model.md', 'docs/architecture/domain-model.md', 'CONTEXT.md']);
  assert.deepEqual(installedCommit.restartDocuments('bounded-context', 'x'), ['docs/specs/x', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/architecture/domain-model.md']);

  // The installed gate runs from the consumer on the template's own example.
  const document = await templateDocument(sourceRoot);
  await mkdir(join(root, 'docs/specs/community'), { recursive: true });
  await writeFile(join(root, 'docs/specs/community/requirements.md'), REQUIREMENTS);
  await writeFile(join(root, 'docs/specs/community/domain-model.md'), document);
  const gate = (stage) => spawnSync(process.execPath, [join(root, GATE), '--stage', stage, '--requirements', join(root, 'docs/specs/community/requirements.md'), '--domain-model', join(root, 'docs/specs/community/domain-model.md')], { cwd: root, encoding: 'utf8' });
  assert.equal(gate('integration-design').status, 0, gate('integration-design').stdout);
  await writeFile(join(root, 'docs/specs/community/domain-model.md'), document.replace('| BIZ-03 | 신고 | 신고 | 신고를 접수한다 |\n', ''));
  assert.equal(gate('domain-model').status, 1);
  assert.match(JSON.parse(gate('domain-model').stdout).errors[0].message, /BIZ-03 maps to no model/);
  await writeFile(join(root, 'docs/specs/community/domain-model.md'), document);

  // Plan set documents, the project's model rows and the glossary are project-owned and stay visible next to application changes.
  await writeFile(join(root, 'docs/architecture/domain-model.md'), '# 소비자 모델 색인\n\n| 커뮤니티 / 게시글 | accepted-target |\n');
  await writeFile(join(root, 'CONTEXT.md'), '# 프로젝트 컨텍스트\n\n- 신고\n');
  const status = git('status', '--short', '--untracked-files=all');
  assert.match(status, /\?\? docs\/specs\/community\/domain-model\.md/);
  assert.match(status, /\?\? docs\/specs\/community\/requirements\.md/);
  assert.match(status, /^ M docs\/architecture\/domain-model\.md$/m, 'the project model document is project-owned');
  assert.match(status, /^ M CONTEXT\.md$/m, 'the glossary is project-owned');
  assert.match(status, /^ M app\.txt$/m, 'application changes stay visible and untouched');
  assert.doesNotMatch(status, /\.codex\/|\.harness\/|\.claude\/|\.agents\/|\.io\//, 'Harness-managed files stay out of commits');
  for (const path of ['docs/specs/community/domain-model.md', 'docs/architecture/domain-model.md', 'CONTEXT.md', 'CONTEXT-MAP.md']) assert.throws(() => git('check-ignore', '-q', path), `not ignored: ${path}`);

  // Doctor accepts the installation, reports a missing tactical asset, and update restores it without touching project documents.
  let doctor = await runDoctor({ root, sourceRoot });
  assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  const removed = [TEMPLATE, DEEPENING, GATE, '.codex/internal-skills/aggregate-design/GUIDE.md'];
  for (const path of removed) await unlink(join(root, path));
  await writeFile(join(root, '.codex/internal-skills/integration-design/GUIDE.md'), 'outdated guide\n');
  doctor = await runDoctor({ root, sourceRoot });
  for (const path of removed) assert.ok(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path === join(root, path)), `missing: ${path}`);
  await updateProject({ sourceRoot, targetRoot: root });
  for (const path of [...removed, '.codex/internal-skills/integration-design/GUIDE.md']) assert.equal(await readFile(join(root, path), 'utf8'), await read(path), `restored: ${path}`);
  for (const path of managed) assert.match(git('check-ignore', '-v', path), /info\/exclude/, `still ignored after update: ${path}`);
  assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  assert.equal(await readFile(join(root, 'docs/specs/community/domain-model.md'), 'utf8'), document);
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'ongoing application change\n');
  assert.equal(await readFile(join(root, 'CONTEXT-MAP.md'), 'utf8'), '# 소비자 소유 관계\n');
  assert.match(git('status', '--short', '--untracked-files=all'), /\?\? docs\/specs\/community\/domain-model\.md/);
});

const draft = (marker) => `# 요구사항 명세\n\n- 상태: draft\n\n<!-- ${marker} -->\n`;
const projectModel = (version) => `# 모델 색인\n\n| Context / 모델 ID | 상태 | Root / 소유 코드 | 규칙 ID → enforcement | 데이터 / transaction | 공개 계약 / 통신 | deployment / extraction trigger | 근거 |\n|---|---|---|---|---|---|---|---|\n| 커뮤니티 / 게시글 | accepted-target | ${version} | - | - | - | - | docs/specs |\n`;
const question = (id, title) => ({ question_id: id, title, options: [{ id: 'a', label: '첫째', consequence: '첫째 결과', evidence: [] }, { id: 'b', label: '둘째', consequence: '둘째 결과', evidence: [] }], recommended_option_id: 'a', rationale: '요구사항이 그렇게 말한다', decision_kind: null });
// The rule a design answer adds to the owning BIZ, and the rows that map it.
const NEW_RULE = '  - INV-05 신고는 접수한 뒤 하루 안에 닫힌다 — 출처: answers.json `q-deadline`\n';
const withNewRule = (document) => document
  .replace('| EX-01 | 인증 | 인증 시스템 | 방문자 판별은 외부 시스템이 한다 |\n', (row) => `${row}| INV-05 | 신고 | 신고 | 닫는 기한은 신고의 규칙이다 |\n`)
  .replace('| INV-04 | 신고 | Domain Service | Aggregate 안 |\n', (row) => `${row}| INV-05 | 신고 | \`신고.닫기()\` | Aggregate 안 |\n`);

test('the tactical stages run after requirements-fix, gate their sections, deepen the requirements and restart without losing the added rule', async (t) => {
  const flow = await consumerWorkflow(t, '게시글 삭제 기능을 추가해줘');
  const { workspace, treeGit, invoke, runStage, planSetId, specDirectory, specPath } = flow;
  const requirements = specPath('requirements.md');
  const analysis = specPath('stakeholder-analysis.md');
  const domainModel = specPath('domain-model.md');
  const art = (path, kind) => ({ path, kind });
  const gate = (stage) => invoke(workspace, 'harness-domain-model-check.mjs', ['--workspace-root', workspace, '--stage', stage]);
  const document = await templateDocument(sourceRoot);

  // The requirements flow ends with a fixed requirements.md that carries the rules the design maps.
  const markers = { 'stakeholder-analysis': { [analysis]: '# Stakeholder 분석\n', [requirements]: draft('stakeholder-analysis') } };
  for (const stage of REQUIREMENTS_STAGES) {
    const files = stage === 'stakeholder-analysis' ? markers[stage] : { [requirements]: stage === 'requirements-fix' ? REQUIREMENTS : draft(stage) };
    await runStage(stage, { files, artifacts: [art(requirements, 'requirements')] });
  }
  assert.deepEqual(treeGit('log', '--format=%s', '-7').trim().split('\n'), [...REQUIREMENTS_STAGES].reverse().map((stage) => `${stage}: ${planSetId}`));

  // 1. domain-model follows requirements-fix, writes section 1 and the project rows, and the runner commits them with the reported glossary.
  const first = await runStage('domain-model', {
    files: { [domainModel]: upTo(document, 1), 'docs/architecture/domain-model.md': projectModel('v1'), 'CONTEXT.md': '# 프로젝트 컨텍스트\n\n| Post | 게시글 |\n' },
    artifacts: [art(domainModel, 'domain_model'), art('docs/architecture/domain-model.md', 'model_index'), art('CONTEXT.md', 'glossary')],
  });
  assert.equal(first.prepared.input.context.transition.from_stage, 'requirements-fix');
  assert.ok(first.prepared.input.input_refs.some((reference) => reference.path === requirements && reference.kind === 'requirements'));
  assert.deepEqual(first.files, ['CONTEXT.md', 'docs/architecture/domain-model.md', domainModel].sort());
  assert.equal(gate('domain-model').ok, true);

  // 2. aggregate-design asks its consistency decision in one batch, then records the answer with its source.
  const asked = await runStage('aggregate-design', { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '일관성 질문 1건', questions: [question('con-1', '[INV-03] 게시글을 지우면 신고는 언제 닫혀야 하나요?')], expectCommit: false });
  assert.equal(asked.finished.result.questions.length, 1);
  const aggregated = await runStage('aggregate-design', {
    extraArgs: ['--answer', 'b'],
    files: { [domainModel]: upTo(document, 2), 'docs/architecture/domain-model.md': projectModel('v2') },
    artifacts: [art(domainModel, 'domain_model'), art('docs/architecture/domain-model.md', 'model_index')],
  });
  assert.deepEqual(aggregated.files, ['docs/architecture/domain-model.md', domainModel].sort(), 'the glossary stays out of a stage that did not report it');
  assert.deepEqual(JSON.parse(await readFile(join(dirname(aggregated.started.output_path), 'answers.json'), 'utf8')).map((entry) => entry.answer), ['b']);
  assert.equal(gate('aggregate-design').ok, true);

  // 3. domain-service blocks for missing evidence without writing; the user may revise the fixed requirements while it is blocked, and it resumes.
  const blocked = await runStage('domain-service', { status: 'blocked', code: 'INPUT_MISSING', summary: 'INV-04의 중복 기준이 요구사항에 없다: requirements-fix 수정이 필요하다', expectCommit: false });
  assert.equal(blocked.finished.status, 'blocked');
  const revision = invoke(workspace, 'harness-prepare-input.mjs', ['--stage-id', 'requirements-fix', '--feedback', '같은 회원이 같은 글을 하루에 한 번만 신고할 수 있다', '--user-revision', 'true']);
  assert.equal(revision.input.skill, 'requirements-fix');
  assert.equal(revision.input.context.user_revision, true);
  const resumed = await runStage('domain-service', { extraArgs: ['--feedback', '요구사항을 확인했다'], files: { [domainModel]: upTo(document, 3) }, artifacts: [art(domainModel, 'domain_model')] });
  assert.ok(resumed.prepared.input.input_refs.some((reference) => reference.kind === 'previous_execution_result'), 'the blocked stage resumes with its previous result');
  assert.equal(gate('domain-service').ok, true);

  // 4. application-service.
  await runStage('application-service', { files: { [domainModel]: upTo(document, 4) }, artifacts: [art(domainModel, 'domain_model')] });
  assert.equal(gate('application-service').ok, true);

  // 5. integration-design asks, and the answer reveals a rule that earlier sections must map: it adds the rule to requirements.md
  // and stops without touching them; the runner commits only that rule, so the tree is clean and the rule survives the restart.
  const integrationAsk = await runStage('integration-design', { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '통합 질문 1건', questions: [question('int-1', '[커뮤니티 → 신고] 삭제 직후 신고가 닫힌 것을 보여 줘야 하나요?')], expectCommit: false });
  assert.equal(integrationAsk.finished.status, 'action_required');
  const withRule = REQUIREMENTS.replace('  - INV-04 한 회원은 같은 게시글을 한 번만 신고할 수 있다 — 출처: CAND-03 채택\n', (line) => `${line}${NEW_RULE}`);
  assert.notEqual(withRule, REQUIREMENTS);
  const deepened = await runStage('integration-design', {
    extraArgs: ['--answer', 'a'], status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: '신고 기한(INV-05)이 새로 생겼다: aggregate-design을 다시 열어야 한다',
    files: { [requirements]: withRule, [domainModel]: `${upTo(document, 4)}\n## 5. 반쯤 쓴 절\n` }, artifacts: [art(requirements, 'requirements')],
  });
  assert.deepEqual(deepened.files, [requirements], 'a block keeps only the rule it added to the requirements');
  assert.match(treeGit('status', '--short', '--untracked-files=all'), /M docs\/specs\/.*domain-model\.md/, 'the half-written section stays uncommitted');
  await writeFile(join(workspace, domainModel), upTo(document, 4));
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '', 'the tree is clean once the half-written section is dropped');

  // 6. The restart reopens aggregate-design: tactical documents are restored, the rule stays, and the later stages are dropped from the state.
  const restartArgs = ['--stage-id', 'aggregate-design', '--restart-requirements', 'true'];
  const restart = invoke(workspace, 'harness-prepare-input.mjs', restartArgs);
  assert.equal(restart.previous_stage, 'domain-model');
  assert.ok(existsSync(join(restart.backup, 'state.json')));
  assert.match(await readFile(join(workspace, requirements), 'utf8'), /INV-05/, 'the rule added by the blocked stage survives');
  assert.doesNotMatch(await readFile(join(workspace, domainModel), 'utf8'), /^## 2\./m, 'the tactical document is back at the end of domain-model');
  assert.match(await readFile(join(workspace, 'docs/architecture/domain-model.md'), 'utf8'), /\| v1 \|/);
  const state = JSON.parse(await readFile(join(workspace, '.io/runtime/orchestrator/state.json'), 'utf8'));
  assert.equal(state.current_stage, 'domain-model');
  for (const stage of ['aggregate-design', 'domain-service', 'application-service', 'integration-design']) assert.equal(state.stages[stage], undefined, `${stage} is reopened`);
  assert.equal(state.stages['domain-model'].status, 'completed');
  // Without its mapping the new rule fails the gate of the stage that must map it.
  const unmapped = spawnSync(process.execPath, [join(workspace, GATE), '--workspace-root', workspace, '--stage', 'domain-model'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(unmapped.status, 1);
  assert.deepEqual(JSON.parse(unmapped.stdout).errors.map((error) => error.code), ['RULE_NO_OWNER']);

  // 7. The reopened stages run again with the rule mapped, and spec-me follows the last one.
  const rerun = async (stage, level, extra = {}) => runStage(stage, {
    files: { [domainModel]: withNewRule(upTo(document, level)), ...extra.files }, artifacts: [art(domainModel, 'domain_model'), ...(extra.artifacts || [])],
  });
  await rerun('aggregate-design', 2, { files: { 'docs/architecture/domain-model.md': projectModel('v3') }, artifacts: [art('docs/architecture/domain-model.md', 'model_index')] });
  assert.equal(gate('aggregate-design').ok, true);
  await rerun('domain-service', 3); assert.equal(gate('domain-service').ok, true);
  await rerun('application-service', 4); assert.equal(gate('application-service').ok, true);
  const last = await rerun('integration-design', 5); assert.equal(gate('integration-design').ok, true);
  assert.deepEqual(treeGit('log', '--format=%s', '-4').trim().split('\n'), ['integration-design', 'application-service', 'domain-service', 'aggregate-design'].map((stage) => `${stage}: ${planSetId}`));
  const next = invoke(workspace, 'harness-prepare-input.mjs', ['--stage-id', 'spec-me']);
  assert.equal(next.input.context.transition.from_stage, 'integration-design');
  assert.ok(next.input.input_refs.some((reference) => reference.path === domainModel && reference.kind === 'domain_model'), 'spec-me receives the tactical document as an input reference');
  assert.equal(last.finished.status, 'completed');

  // A completed tactical stage changes only on an explicit user revision; an earlier requirements stage still does not.
  const tacticalRevision = invoke(workspace, 'harness-prepare-input.mjs', ['--stage-id', 'domain-service', '--feedback', '중복 판정 기준을 하루로 바꿔 줘', '--user-revision', 'true']);
  assert.equal(tacticalRevision.input.skill, 'domain-service');
  assert.equal(tacticalRevision.input.context.user_revision, true);
  const refused = spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--stage-id', 'subdomain-candidates', '--feedback', '다시', '--user-revision', 'true'], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /User revision requires feedback for requirements-fix, a tactical design stage/);
});

test('a skipped stakeholder-analysis makes the tactical stages record the skip without writing, and spec-me follows integration-design', async (t) => {
  const flow = await consumerWorkflow(t, '게시글 삭제 기능을 추가해줘');
  const { workspace, treeGit, invoke, runStage, planSetId, specPath } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  await runStage('stakeholder-analysis', { files: { [analysis]: '# Stakeholder 분석\n\n- 판정: 생략\n- 근거: 기존 승인 Spec의 업무 하나 안의 변경\n' }, artifacts: [{ path: analysis, kind: 'stakeholder_analysis' }], summary: '생략 판정' });
  const head = treeGit('rev-parse', 'HEAD').trim();
  for (const stage of PRE_SPEC_STAGES.slice(1)) {
    const result = await runStage(stage, { summary: `생략: stakeholder-analysis 판정 생략 (${analysis})`, expectCommit: false });
    assert.equal(result.finished.result.artifacts.length, 0, `${stage} wrote nothing`);
  }
  assert.equal(treeGit('rev-parse', 'HEAD').trim(), head);
  assert.equal(existsSync(join(workspace, specPath('domain-model.md'))), false, 'a skipped analysis leaves no domain-model.md');
  const next = invoke(workspace, 'harness-prepare-input.mjs', ['--stage-id', 'spec-me']);
  assert.equal(next.input.context.transition.from_stage, 'integration-design');
});
