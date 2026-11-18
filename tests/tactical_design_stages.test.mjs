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
import { checkTacticalDesign } from '../.harness/src/workflow/domain-model-gate.mjs';
import { PRE_SPEC_STAGES, REQUIREMENTS_STAGES, TACTICAL_DESIGN_STAGES, WORKTREE_STAGE } from '../.harness/src/workflow/worktree-stages.mjs';
import { MODELS, SETUP, STAGE_TIERS, consumerWorkflow, gitIn, sourceRoot, stakeholderAnalysisDocument } from './support/consumer-workflow.mjs';
import { READ_ONLY_REQUIREMENTS, READ_ONLY_DOCUMENT, REQUIREMENTS, STATELESS_DOCUMENT, STATELESS_REQUIREMENTS, templateDocument, upTo } from './support/domain-model-fixture.mjs';

const TEMPLATE = '.codex/internal-skills/domain-model/references/template.md';
const DEEPENING = '.codex/internal-skills/domain-model/references/deepening.md';
const GATE = '.codex/scripts/harness-domain-model-check.mjs';
const GATE_LIBRARY = '.harness/src/workflow/domain-model-gate.mjs';
const README_PATH = 'README.md';
const TACTICAL_TIERS = { 'domain-model': 'high_performance', 'aggregate-design': 'high_performance', 'domain-service': 'implementation', 'application-service': 'implementation', 'integration-design': 'high_performance', 'context-boundary': 'high_performance' };
const ASKING = ['aggregate-design', 'integration-design', 'context-boundary'];
const FINAL_STAGE = 'context-boundary';
const read = (path) => readFile(join(sourceRoot, path), 'utf8');

test('the tactical stages follow the requirements flow in one ordered list, and the orchestrator, the map, the README and every guide agree on it', async () => {
  assert.deepEqual(TACTICAL_DESIGN_STAGES, ['domain-model', 'aggregate-design', 'domain-service', 'application-service', 'integration-design', 'context-boundary']);
  assert.deepEqual(PRE_SPEC_STAGES, [...REQUIREMENTS_STAGES, ...TACTICAL_DESIGN_STAGES]);
  assert.equal(PRE_SPEC_STAGES.at(REQUIREMENTS_STAGES.length - 1), 'bounded-context');
  for (const stage of TACTICAL_DESIGN_STAGES) assert.ok(Object.values(WORKTREE_STAGE).includes(stage), `${stage} is a worktree stage`);
  assert.deepEqual(Object.keys(STAGE_TIERS).sort(), [...PRE_SPEC_STAGES, 'tactical-technology', 'tactical-ui', 'tactical-api', 'tactical-data', 'to-ticket', 'tracker-publish', 'tactical-code'].sort(), 'every stage in the pre-spec and tactical implementation flows has a declared tier in the shared fixture');

  const orchestrator = await read('.codex/skills/orchestrator/SKILL.md');
  assert.ok(orchestrator.includes(TACTICAL_DESIGN_STAGES.map((stage) => `\`${stage}\``).join(' → ')), 'the orchestrator names the tactical flow in order');
  assert.match(orchestrator, /전술 설계 흐름에서 완료되지 않은 첫 stage/);
  assert.match(orchestrator, /요구사항·전술 설계 흐름이 끝났고 구현 요청이 있음/);
  assert.match(orchestrator, /`DEPENDENCY_INCOMPLETE`/);
  assert.match(orchestrator, /restart를 먼저 하고 요구사항 수정은 그 뒤에 한다/);
  const map = await read('.codex/skills/orchestrator/references/workflow-map.md');
  const positions = PRE_SPEC_STAGES.map((stage) => map.indexOf(`\`${stage}\``));
  assert.ok(positions.every((position) => position >= 0) && positions.every((position, index) => index === 0 || position > positions[index - 1]), 'the workflow map names every stage in order');
  assert.match(map, /harness-domain-model-check\.mjs/);
  const readme = await read('README.md');
  assert.ok(readme.includes(TACTICAL_DESIGN_STAGES.map((stage) => `\`${stage}\``).join(' → ')));
  assert.match(readme, /#### 전술 설계 흐름/);
  for (const stage of TACTICAL_DESIGN_STAGES) assert.ok(readme.includes(`| \`${stage}\` |`), `${stage} has a README row`);
  const exec = await read('docs/agents/EXEC.md');
  assert.ok(exec.includes(TACTICAL_DESIGN_STAGES.map((stage) => `\`${stage}\``).join('→')), 'the E2E procedure names the tactical flow');
  assert.match(await read('docs/architecture/enforcement.md'), /TACTICAL_DESIGN_STAGES[\s\S]*harness-domain-model-check\.mjs/);
  assert.match(await read('docs/architecture/enforcement.md'), /domain-model-gate\.mjs[\s\S]*FINAL_TACTICAL_STAGE[\s\S]*`gate_error`[\s\S]*`owner_stage`[\s\S]*recordExecutionState/, 'the enforcement map names where the runner rejects a failing last tactical stage');
  for (const path of ['.codex/skills/orchestrator/references/dispatch.md', '.codex/skills/orchestrator/references/state.md', '.codex/skills/orchestrator/SKILL.md', README_PATH]) assert.match(await read(path), /`gate_error`/, `${path} tells what the runner returns for a failing tactical gate`);
  assert.match(await read('.codex/internal-skills/domain-model/references/deepening.md'), /No stage runs a gate[\s\S]*`gate_error`[\s\S]*`owner_stage`/);
  for (const path of ['.codex/skills/orchestrator/references/dispatch.md', '.codex/skills/orchestrator/references/state.md', '.codex/skills/orchestrator/SKILL.md', README_PATH]) assert.match(await read(path), /`owner_stage`/, `${path} tells the orchestrator which stage owns a failing section`);
  assert.match(await read('CONTEXT.md'), /\| Consistency Decision \| 일관성 결정 \|/);
  assert.match(await read('.codex/skills/orchestrator/references/dispatch.md'), /요구사항·전술 설계 stage의 문서를 고치라고 지시하면/);
  assert.match(await read('.codex/skills/orchestrator/references/input.md'), /요구사항 또는 전술 설계 stage부터 다시 시작/);

  // The requirements template points at the tactical documents and lets only the asking stages add a rule from a user's answer.
  const requirementsTemplate = await read('.codex/internal-skills/requirements-fix/references/template.md');
  assert.match(requirementsTemplate, /\| `domain-model`부터 `context-boundary`까지 \|/);
  assert.match(requirementsTemplate, /질문을 하는 stage\(`aggregate-design`, `integration-design`, `context-boundary`\)/);

  // The template owns the document shape the gate reads.
  const document = await templateDocument(sourceRoot);
  assert.deepEqual([...document.matchAll(/^## (.+)$/gm)].map((match) => match[1]), ['1. 모델 후보', '2. Aggregate', '3. Domain Service', '4. Application Service', '5. 통합 설계', '6. 컨텍스트 경계', '7. 결정 이력']);
  assert.match(document, /^\| 모델 \| 종류 \| BC \| 정체성·생애주기 또는 값의 의미 \| 현재 상태 \| 근거 \|$/m);
  assert.match(document, /^\| 요구 \| BC \| 소유 모델 \| 근거 \|$/m);
  assert.match(document, /^\| CON \| 규칙 \| 걸친 Aggregate \| 조회 전용 Aggregate \| 일관성 \| 결정 \| 근거·출처 \|$/m);
  assert.match(document, /^\| DEC \| stage \| 대상 \| 결정 \| 비교한 대안 \| 출처 \|$/m);
  const template = await read(TEMPLATE);
  assert.match(template, /^\| Context \/ 모델 ID \| 상태 \| Root \/ 소유 코드 \| 규칙 ID → enforcement \| 데이터 \/ transaction \| 공개 계약 \/ 통신 \| deployment \/ extraction trigger \| 근거 \|$/m, 'the project model row format is the model-continuity one');
  assert.match(template, /`accepted-target`/);
  assert.doesNotMatch(template, /classDiagram|@startuml/, 'no class diagram yet');
  // An enforcing behaviour is a Root method, a Value Object's rule or a Domain Service, and a context with no state lifecycle has no Aggregate.
  assert.match(template, /Value Object: <모델>` 또는 `Value Object: <모델>\.<행위>\(\)`/);
  assert.match(template, /^## Aggregate가 없는 컨텍스트$/m);
  const snippet = [...template.matchAll(/````markdown\n([\s\S]*?)\n````/g)].map((match) => match[1]).find((block) => block.startsWith('### 2.1 Aggregate'));
  assert.ok(snippet, 'the template shows how a context without an Aggregate is written');
  const withSnippet = (text) => STATELESS_DOCUMENT.replace(/### 2\.1 Aggregate[\s\S]*?(?=### 2\.3)/, `${text}\n\n`);
  assert.deepEqual(checkTacticalDesign({ requirements: STATELESS_REQUIREMENTS, tacticalDesign: withSnippet(snippet) }), { ok: true, errors: [] }, 'the gate accepts the no-Aggregate example of the template');
  assert.deepEqual(checkTacticalDesign({ requirements: STATELESS_REQUIREMENTS, tacticalDesign: withSnippet(snippet.replace(/^\| (?:INV|EX)-\d+ \|.*\n?/gm, '')) }).errors.map((error) => error.code), ['RULE_NO_ENFORCEMENT', 'RULE_NO_ENFORCEMENT'], 'and refuses it once no behaviour enforces the rules');

  // Each stage guide links the shared documents, keeps its own boundary and returns through the common contract.
  for (const stage of TACTICAL_DESIGN_STAGES) {
    const guide = await read(`.codex/internal-skills/${stage}/GUIDE.md`);
    assert.match(guide, new RegExp(`^---\\nmodel_tier: ${TACTICAL_TIERS[stage]}\\n---\\n<!-- 내부 workflow 전용`), `${stage} declares its tier and stays internal`);
    assert.match(guide, /domain-model\/references\/template\.md|\(references\/template\.md\)/, `${stage} links the template`);
    assert.match(guide, /domain-model\/references\/deepening\.md|\(references\/deepening\.md\)/, `${stage} links the shared rules`);
    const sections = stage === 'context-boundary' ? ['## 목적', '## 입력', '## 금지 사항', '## 절차', '## 심화', '## 완료 조건'] : ['## Purpose', '## Inputs', '## Prohibited', '## Process', '## Deepening', '## Completion'];
    for (const part of sections) assert.ok(guide.includes(part), `${stage} has ${part}`);
    assert.match(guide, /harness-workspace-preflight\.mjs/, `${stage} runs the preflight`);
    assert.match(guide, /harness-spec-path\.mjs/, `${stage} resolves paths with the helper`);
    assert.match(guide, /`판정: 생략`/, `${stage} records a skip`);
    assert.match(guide, stage === 'context-boundary' ? /Runner는 `CONTEXT-MAP\.md`를 변경 artifact로 보고한 경우에만/ : /The runner commits `docs\/specs\/<plan-set-id>\/`/, `${stage} says what the runner commits`);
    // The gate runs once, in the runner, when the last stage completes: only that guide speaks of it and no stage runs it.
    if (stage === FINAL_STAGE) {
      assert.match(guide, /## 최종 gate/);
      assert.match(guide, /Runner는 이 stage가 `completed\/OK`를 반환한 뒤에만 전술 gate를 실행한다/);
      assert.match(guide, /6절/);
      assert.match(guide, /`gate_error`[\s\S]*`owner_stage`/);
      assert.match(guide, /이 stage 소유 오류는 여기서 고칠 수 있다/);
      assert.match(guide, /이전 stage 오류[\s\S]*`blocked` \/ `DEPENDENCY_INCOMPLETE`/);
      assert.match(guide, /`--restart-requirements true` (?:or|또는) `--user-revision true --feedback`/);
    } else assert.doesNotMatch(guide, /harness-domain-model-check|gate_error|owner_stage|--stage|gate passes|^## Final gate/im, `${stage} does not run or describe a gate of its own`);
    assert.match(guide, /`DEPENDENCY_INCOMPLETE`|`INPUT_MISSING`/, `${stage} says how it blocks`);
    assert.match(guide, /requirements\.md/, `${stage} reads the requirements`);
    // The document is named for the flow, never for a stage: a stage writes only its own section, and a user instruction that
    // names a stage is read as the stage, not as a file.
    assert.match(guide, stage === 'context-boundary' ? /`tactical-design\.md`에서는 `## 6`/ : /Writing anything in `tactical-design\.md` but `## \d`/, `${stage} writes only its own section of the tactical design`);
    assert.match(guide, stage === 'context-boundary' ? /파일이 아니라 이 stage와 기록된 상태/ : /refers to that stage and its recorded state, never to a file/, `${stage} reads a stage name as a stage`);
    assert.doesNotMatch(guide, /(?<!architecture\/)domain-model\.md/, `${stage} never names the legacy document`);
    assert.doesNotMatch(guide, /ddd-design|spec-me\/GUIDE|architecture-spec/, `${stage} does not depend on the older design guides`);
    if (ASKING.includes(stage)) {
      assert.match(guide, /`action_required` \/ `USER_DECISION_REQUIRED`/, `${stage} may ask`);
      if (stage === 'context-boundary') {
        assert.match(guide, /질문을 한국어 한 번의 묶음으로/);
        assert.match(guide, /권장안과 이유/);
      } else {
        assert.match(guide, /in Korean/, `${stage} asks in Korean`);
        assert.match(guide, /a recommended option/, `${stage} recommends an option`);
        assert.match(guide, /one batch/, `${stage} asks in one batch`);
      }
      assert.match(guide, /`answers\.json`/, `${stage} records the answer source`);
      assert.match(guide, stage === 'context-boundary' ? /`INV` 또는 `EX`와 `AC`/ : /`INV` or `EX` with its `AC`/, `${stage} adds a discovered rule to the requirements`);
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
  assert.match(aggregate, /Inventing an Entity or an Aggregate only so that a rule has a Root/);
  assert.match(aggregate, /`Value Object: <모델>` or `Value Object: <모델>\.<행위>\(\)`/);
  assert.match(aggregate, /`BC` \/ `Aggregate 없음 사유` table of `### 2\.1`/);
  const service = await read('.codex/internal-skills/domain-service/GUIDE.md');
  assert.match(service, /Orchestration, transaction boundaries, persistence, repository calls, publishing events or any external effect/);
  assert.match(service, /Taking a rule that an Aggregate method or a Value Object already enforces/);
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
    GATE_LIBRARY, '.harness/src/workflow/execution-state.mjs', '.codex/scripts/harness-native-stage.mjs',
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
  assert.deepEqual(installedCommit.restartDocuments('domain-model', 'x'), ['docs/specs/x/tactical-design.md', 'docs/specs/x/domain-model.md', 'docs/architecture/domain-model.md', 'CONTEXT.md', 'CONTEXT-MAP.md'], 'a restart restores the document under its current and its legacy name');
  assert.equal(typeof installedCommit.migrateLegacyTacticalDesign, 'function', 'the installed runner carries the legacy rename');
  assert.deepEqual(installedCommit.restartDocuments('bounded-context', 'x'), ['docs/specs/x', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/architecture/domain-model.md']);

  // The installed gate runs from the consumer on the template's own example, and on a context without an Aggregate.
  const document = await templateDocument(sourceRoot);
  await mkdir(join(root, 'docs/specs/community'), { recursive: true });
  await writeFile(join(root, 'docs/specs/community/requirements.md'), REQUIREMENTS);
  await writeFile(join(root, 'docs/specs/community/tactical-design.md'), document);
  const gate = (...extra) => spawnSync(process.execPath, [join(root, GATE), '--requirements', join(root, 'docs/specs/community/requirements.md'), '--tactical-design', join(root, 'docs/specs/community/tactical-design.md'), ...extra], { cwd: root, encoding: 'utf8' });
  assert.equal(gate().status, 0, gate().stdout);
  await writeFile(join(root, 'docs/specs/community/tactical-design.md'), document.replace('| BIZ-03 | 신고 | 신고 | 신고를 접수한다 |\n', ''));
  assert.equal(gate().status, 1);
  assert.match(JSON.parse(gate().stdout).errors[0].message, /BIZ-03 maps to no model/);
  assert.equal(JSON.parse(gate().stdout).errors[0].owner_stage, 'domain-model');
  assert.equal(gate('--stage', 'domain-model').status, 1, 'the installed gate has no stage to select');
  assert.match(gate('--stage', 'domain-model').stderr, /^Usage: harness-domain-model-check\.mjs/);
  await writeFile(join(root, 'docs/specs/community/requirements.md'), STATELESS_REQUIREMENTS);
  await writeFile(join(root, 'docs/specs/community/tactical-design.md'), STATELESS_DOCUMENT);
  assert.equal(gate().status, 0, `a bounded context with no state lifecycle and a Value Object that enforces its rules passes: ${gate().stdout}`);
  await writeFile(join(root, 'docs/specs/community/tactical-design.md'), STATELESS_DOCUMENT.replace(/^\| (?:INV|EX)-\d+ \| - \|.*\n/gm, ''));
  assert.equal(gate().status, 1);
  assert.deepEqual(JSON.parse(gate().stdout).errors.map((error) => error.code), ['RULE_NO_ENFORCEMENT', 'RULE_NO_ENFORCEMENT'], 'a rule that no behaviour enforces does not');
  await writeFile(join(root, 'docs/specs/community/requirements.md'), READ_ONLY_REQUIREMENTS);
  await writeFile(join(root, 'docs/specs/community/tactical-design.md'), READ_ONLY_DOCUMENT);
  assert.equal(gate().status, 0, `a read-only Aggregate, an unmerged immediate decision and a Value Object context pass: ${gate().stdout}`);
  await writeFile(join(root, 'docs/specs/community/requirements.md'), REQUIREMENTS);
  await writeFile(join(root, 'docs/specs/community/tactical-design.md'), document);

  // Plan set documents, the project's model rows and the glossary are project-owned and stay visible next to application changes.
  await writeFile(join(root, 'docs/architecture/domain-model.md'), '# 소비자 모델 색인\n\n| 커뮤니티 / 게시글 | accepted-target |\n');
  await writeFile(join(root, 'CONTEXT.md'), '# 프로젝트 컨텍스트\n\n- 신고\n');
  const status = git('status', '--short', '--untracked-files=all');
  assert.match(status, /\?\? docs\/specs\/community\/tactical-design\.md/);
  assert.match(status, /\?\? docs\/specs\/community\/requirements\.md/);
  assert.match(status, /^ M docs\/architecture\/domain-model\.md$/m, 'the project model document is project-owned');
  assert.match(status, /^ M CONTEXT\.md$/m, 'the glossary is project-owned');
  assert.match(status, /^ M app\.txt$/m, 'application changes stay visible and untouched');
  assert.doesNotMatch(status, /\.codex\/|\.harness\/|\.claude\/|\.agents\/|\.io\//, 'Harness-managed files stay out of commits');
  for (const path of ['docs/specs/community/tactical-design.md', 'docs/architecture/domain-model.md', 'CONTEXT.md', 'CONTEXT-MAP.md']) assert.throws(() => git('check-ignore', '-q', path), `not ignored: ${path}`);

  // Doctor accepts the installation, reports a missing tactical asset, and update restores it without touching project documents.
  let doctor = await runDoctor({ root, sourceRoot });
  assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  const removed = [TEMPLATE, DEEPENING, GATE, GATE_LIBRARY, '.codex/internal-skills/aggregate-design/GUIDE.md'];
  for (const path of removed) await unlink(join(root, path));
  await writeFile(join(root, '.codex/internal-skills/integration-design/GUIDE.md'), 'outdated guide\n');
  doctor = await runDoctor({ root, sourceRoot });
  for (const path of removed) assert.ok(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path === join(root, path)), `missing: ${path}`);
  await updateProject({ sourceRoot, targetRoot: root });
  for (const path of [...removed, '.codex/internal-skills/integration-design/GUIDE.md']) assert.equal(await readFile(join(root, path), 'utf8'), await read(path), `restored: ${path}`);
  // `harness-codex update` replaces a runner from before the gate enforcement, so installed consumers start enforcing it.
  const outdated = [GATE_LIBRARY, '.codex/scripts/harness-native-stage.mjs', '.harness/src/workflow/execution-state.mjs'];
  for (const path of outdated) await writeFile(join(root, path), 'outdated\n');
  await updateProject({ sourceRoot, targetRoot: root, force: true });
  for (const path of outdated) assert.equal(await readFile(join(root, path), 'utf8'), await read(path), `updated: ${path}`);
  for (const path of managed) assert.match(git('check-ignore', '-v', path), /info\/exclude/, `still ignored after update: ${path}`);
  assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  assert.equal(await readFile(join(root, 'docs/specs/community/tactical-design.md'), 'utf8'), document);
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'ongoing application change\n');
  assert.equal(await readFile(join(root, 'CONTEXT-MAP.md'), 'utf8'), '# 소비자 소유 관계\n');
  assert.match(git('status', '--short', '--untracked-files=all'), /\?\? docs\/specs\/community\/tactical-design\.md/);
});

const draft = (marker) => `# 요구사항 명세\n\n- 상태: draft\n\n<!-- ${marker} -->\n`;
const projectModel = (version) => `# 모델 색인\n\n| Context / 모델 ID | 상태 | Root / 소유 코드 | 규칙 ID → enforcement | 데이터 / transaction | 공개 계약 / 통신 | deployment / extraction trigger | 근거 |\n|---|---|---|---|---|---|---|---|\n| 커뮤니티 / 게시글 | accepted-target | ${version} | - | - | - | - | docs/specs |\n`;
const question = (id, title) => ({ question_id: id, title, options: [{ id: 'a', label: '첫째', consequence: '첫째 결과', evidence: [] }, { id: 'b', label: '둘째', consequence: '둘째 결과', evidence: [] }], recommended_option_id: 'a', rationale: '요구사항이 그렇게 말한다', decision_kind: null });
// The rule a design answer adds to the owning BIZ, and the rows that map it.
const NEW_RULE = '  - INV-05 신고는 접수한 뒤 하루 안에 닫힌다 — 출처: answers.json `q-deadline`\n';
const withNewRule = (document) => document
  .replace('| EX-01 | 인증 | 인증 시스템 | 방문자 판별은 외부 시스템이 한다 |\n', (row) => `${row}| INV-05 | 신고 | 신고 | 닫는 기한은 신고의 규칙이다 |\n`)
  .replace('| INV-04 | 신고 | Domain Service | Aggregate 안 |\n', (row) => `${row}| INV-05 | 신고 | \`신고.닫기()\` | Aggregate 안 |\n`);

test('the tactical stages run after the requirements flow and are accepted section by section, deepen the requirements and restart without losing the added rule, and the last one passes the whole gate', async (t) => {
  const flow = await consumerWorkflow(t, '게시글 삭제 기능을 추가해줘');
  const { workspace, treeGit, invoke, runStage, planSetId, specDirectory, specPath } = flow;
  const requirements = specPath('requirements.md');
  const analysis = specPath('stakeholder-analysis.md');
  const tacticalDesign = specPath('tactical-design.md');
  const art = (path, kind) => ({ path, kind });
  const document = await templateDocument(sourceRoot);

  // The requirements flow ends with a fixed requirements.md that carries the rules the design maps.
  const markers = { 'stakeholder-analysis': { [analysis]: stakeholderAnalysisDocument('게시글 삭제 기능을 추가해줘'), [requirements]: draft('stakeholder-analysis') } };
  for (const stage of REQUIREMENTS_STAGES) {
    const files = stage === 'stakeholder-analysis' ? markers[stage] : { [requirements]: stage === 'bounded-context' ? REQUIREMENTS : draft(stage) };
    await runStage(stage, { files, artifacts: [art(requirements, 'requirements')] });
  }
  assert.deepEqual(treeGit('log', '--format=%s', '-7').trim().split('\n'), [...REQUIREMENTS_STAGES].reverse().map((stage) => `${stage}: ${planSetId}`));

  // 1. domain-model follows the last requirements stage (bounded-context), writes section 1 and the project rows, and the runner commits them with the reported glossary.
  const first = await runStage('domain-model', {
    files: { [tacticalDesign]: upTo(document, 1), 'docs/architecture/domain-model.md': projectModel('v1'), 'CONTEXT.md': '# 프로젝트 컨텍스트\n\n| Post | 게시글 |\n' },
    artifacts: [art(tacticalDesign, 'tactical_design'), art('docs/architecture/domain-model.md', 'model_index'), art('CONTEXT.md', 'glossary')],
  });
  assert.equal(first.prepared.input.context.transition.from_stage, 'bounded-context');
  assert.ok(first.prepared.input.input_refs.some((reference) => reference.path === requirements && reference.kind === 'requirements'));
  assert.deepEqual(first.files, ['CONTEXT.md', 'docs/architecture/domain-model.md', tacticalDesign].sort(), 'a section 1 alone is accepted: no gate runs before the last stage');

  // 2. aggregate-design asks its consistency decision in one batch, then records the answer with its source.
  const asked = await runStage('aggregate-design', { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '일관성 질문 1건', questions: [question('con-1', '[INV-03] 게시글을 지우면 신고는 언제 닫혀야 하나요?')], expectCommit: false });
  assert.equal(asked.finished.result.questions.length, 1);
  const aggregated = await runStage('aggregate-design', {
    extraArgs: ['--answer', 'b'],
    files: { [tacticalDesign]: upTo(document, 2), 'docs/architecture/domain-model.md': projectModel('v2') },
    artifacts: [art(tacticalDesign, 'tactical_design'), art('docs/architecture/domain-model.md', 'model_index')],
  });
  assert.deepEqual(aggregated.files, ['docs/architecture/domain-model.md', tacticalDesign].sort(), 'the glossary stays out of a stage that did not report it');
  assert.deepEqual(JSON.parse(await readFile(join(dirname(aggregated.started.output_path), 'answers.json'), 'utf8')).map((entry) => entry.answer), ['b']);

  // 3. domain-service blocks for missing evidence without writing; the user may revise the fixed requirements while it is blocked, and it resumes.
  const blocked = await runStage('domain-service', { status: 'blocked', code: 'INPUT_MISSING', summary: 'INV-04의 중복 기준이 요구사항에 없다: requirements-fix 수정이 필요하다', expectCommit: false });
  assert.equal(blocked.finished.status, 'blocked');
  const revision = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'requirements-fix', '--feedback', '같은 회원이 같은 글을 하루에 한 번만 신고할 수 있다', '--user-revision', 'true']);
  assert.equal(revision.input.skill, 'requirements-fix');
  assert.equal(revision.input.context.user_revision, true);
  const resumed = await runStage('domain-service', { extraArgs: ['--feedback', '요구사항을 확인했다'], files: { [tacticalDesign]: upTo(document, 3) }, artifacts: [art(tacticalDesign, 'tactical_design')] });
  assert.ok(resumed.prepared.input.input_refs.some((reference) => reference.kind === 'previous_execution_result'), 'the blocked stage resumes with its previous result');

  // 4. application-service.
  await runStage('application-service', { files: { [tacticalDesign]: upTo(document, 4) }, artifacts: [art(tacticalDesign, 'tactical_design')] });

  // 5. integration-design asks, and the answer reveals a rule that earlier sections must map: it adds the rule to requirements.md
  // and stops without touching them; the runner commits only that rule, so the tree is clean and the rule survives the restart.
  const integrationAsk = await runStage('integration-design', { status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '통합 질문 1건', questions: [question('int-1', '[커뮤니티 → 신고] 삭제 직후 신고가 닫힌 것을 보여 줘야 하나요?')], expectCommit: false });
  assert.equal(integrationAsk.finished.status, 'action_required');
  const withRule = REQUIREMENTS.replace('  - INV-04 한 회원은 같은 게시글을 한 번만 신고할 수 있다 — 출처: CAND-03 채택\n', (line) => `${line}${NEW_RULE}`);
  assert.notEqual(withRule, REQUIREMENTS);
  const deepened = await runStage('integration-design', {
    extraArgs: ['--answer', 'a'], status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: '신고 기한(INV-05)이 새로 생겼다: aggregate-design을 다시 열어야 한다',
    files: { [requirements]: withRule, [tacticalDesign]: `${upTo(document, 4)}\n## 5. 반쯤 쓴 절\n` }, artifacts: [art(requirements, 'requirements')],
    resultExtra: { owner_stage: 'aggregate-design', dependency_gap: '신고 기한(INV-05)의 소유 Aggregate가 없다' },
  });
  assert.deepEqual(deepened.files, [requirements], 'a block keeps only the rule it added to the requirements');
  assert.match(treeGit('status', '--short', '--untracked-files=all'), /M docs\/specs\/.*tactical-design\.md/, 'the half-written section stays uncommitted');
  await writeFile(join(workspace, tacticalDesign), upTo(document, 4));
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '', 'the tree is clean once the half-written section is dropped');

  // 6. The restart reopens aggregate-design: tactical documents are restored, the rule stays, and the later stages are dropped from the state.
  const restartArgs = ['--stage-id', 'aggregate-design', '--restart-requirements', 'true'];
  const restart = invoke(workspace, 'harness-prepare-input.mjs', restartArgs);
  assert.equal(restart.previous_stage, 'domain-model');
  assert.ok(existsSync(join(restart.backup, 'state.json')));
  assert.match(await readFile(join(workspace, requirements), 'utf8'), /INV-05/, 'the rule added by the blocked stage survives');
  assert.doesNotMatch(await readFile(join(workspace, tacticalDesign), 'utf8'), /^## 2\./m, 'the tactical document is back at the end of domain-model');
  assert.match(await readFile(join(workspace, 'docs/architecture/domain-model.md'), 'utf8'), /\| v1 \|/);
  const state = JSON.parse(await readFile(join(workspace, '.io/runtime/orchestrator/state.json'), 'utf8'));
  assert.equal(state.current_stage, 'domain-model');
  for (const stage of ['aggregate-design', 'domain-service', 'application-service', 'integration-design', 'context-boundary']) assert.equal(state.stages[stage], undefined, `${stage} is reopened`);
  assert.equal(state.stages['domain-model'].status, 'completed');
  // Without its mapping the new rule is an unowned rule, found by the one gate that runs when the last stage completes (step 7).

  // 7. The reopened stages run again with the rule mapped, and tactical-technology follows the last one once the whole document passes the gate.
  const rerun = async (stage, level, extra = {}) => runStage(stage, {
    files: { [tacticalDesign]: withNewRule(upTo(document, level)), ...extra.files }, artifacts: [art(tacticalDesign, 'tactical_design'), ...(extra.artifacts || [])],
  });
  await rerun('aggregate-design', 2, { files: { 'docs/architecture/domain-model.md': projectModel('v3') }, artifacts: [art('docs/architecture/domain-model.md', 'model_index')] });
  await rerun('domain-service', 3);
  await rerun('application-service', 4);
  await rerun('integration-design', 5);
  const last = await rerun('context-boundary', 6);
  assert.equal(invoke(workspace, 'harness-domain-model-check.mjs', ['--workspace-root', workspace]).ok, true, 'the installed command agrees with the runner on the finished document');
  assert.deepEqual(treeGit('log', '--format=%s', '-4').trim().split('\n'), ['context-boundary', 'integration-design', 'application-service', 'domain-service'].map((stage) => `${stage}: ${planSetId}`));
  const next = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'tactical-technology']);
  assert.equal(next.input.context.transition.from_stage, 'context-boundary');
  assert.ok(next.input.input_refs.some((reference) => reference.path === tacticalDesign && reference.kind === 'tactical_design'), 'tactical-technology receives the tactical document as an input reference');
  assert.equal(last.finished.status, 'completed');

  // A completed tactical stage changes only on an explicit user revision; an earlier requirements stage still does not.
  const tacticalRevision = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'domain-service', '--feedback', '중복 판정 기준을 하루로 바꿔 줘', '--user-revision', 'true']);
  assert.equal(tacticalRevision.input.skill, 'domain-service');
  assert.equal(tacticalRevision.input.context.user_revision, true);
  const refused = spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--stage-id', 'subdomain-candidates', '--feedback', '다시', '--user-revision', 'true'], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /User revision requires feedback for requirements-fix, a tactical design stage/);
});

test('a skipped stakeholder-analysis makes the tactical stages record the skip without writing, and tactical-technology follows context-boundary', async (t) => {
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
  assert.equal(existsSync(join(workspace, specPath('tactical-design.md'))), false, 'a skipped analysis leaves no tactical-design.md');
  const next = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'tactical-technology']);
  assert.equal(next.input.context.transition.from_stage, 'context-boundary');
});

test('the runner accepts the first five tactical stages without a gate and rejects context-boundary while the whole document fails, then recovers through the earlier stage, with Git visibility intact', async (t) => {
  const flow = await consumerWorkflow(t, '게시글 삭제 기능을 추가해줘');
  const { workspace, treeGit, invoke, runStage, beginStage, submitStage, finishStage, tree, planSetId, specPath } = flow;
  const requirements = specPath('requirements.md');
  const tacticalDesign = specPath('tactical-design.md');
  const art = (path, kind) => ({ path, kind });
  const document = await templateDocument(sourceRoot);
  const artifacts = [art(tacticalDesign, 'tactical_design')];
  const stageState = async (stage) => JSON.parse(await readFile(join(workspace, '.io/runtime/orchestrator/state.json'), 'utf8')).stages[stage];
  const returned = (begun) => join(dirname(begun.started.output_path), 'return.json');
  // The status of the tree as the user sees it: application changes and plan set documents, never Harness-owned files.
  const visible = () => treeGit('status', '--short', '--untracked-files=all').split('\n').filter(Boolean).sort();
  const assertVisibility = (expected, label) => {
    assert.deepEqual(visible(), expected.sort(), label);
    assert.doesNotMatch(visible().join('\n'), /\.codex\/|\.harness\/|\.claude\/|\.agents\/|\.io\//, `${label}: Harness-managed files stay out of the status`);
  };

  for (const stage of REQUIREMENTS_STAGES) {
    const files = stage === 'stakeholder-analysis' ? { [specPath('stakeholder-analysis.md')]: stakeholderAnalysisDocument('게시글 삭제 기능을 추가해줘'), [requirements]: draft(stage) } : { [requirements]: stage === 'bounded-context' ? REQUIREMENTS : draft(stage) };
    await runStage(stage, { files, artifacts: [art(requirements, 'requirements')] });
  }
  // Work of the application that the stages never touch.
  await writeFile(join(workspace, 'app.txt'), 'ongoing application change\n');

  // 1. The first four stages are accepted with sections that the whole gate would refuse: the consistency decision of
  // aggregate-design cites only an agent proposal, and application-service changes two Aggregates in one transaction.
  const agentSourced = (text) => text.replace(/^(\| CON-01 \|.*\| )answers\.json `<question_id>` \|$/m, '$1에이전트 제안 |');
  const multiAggregate = (text) => text.replace('| T1: 신고 | 신고 |', '| T1: 신고, 게시글 | 신고 |');
  assert.notEqual(agentSourced(upTo(document, 2)), upTo(document, 2));
  assert.notEqual(multiAggregate(upTo(document, 4)), upTo(document, 4));
  await runStage('domain-model', { files: { [tacticalDesign]: upTo(document, 1) }, artifacts });
  await runStage('aggregate-design', { files: { [tacticalDesign]: agentSourced(upTo(document, 2)) }, artifacts });
  const serviced = await runStage('domain-service', { files: { [tacticalDesign]: agentSourced(upTo(document, 3)) }, artifacts });
  assert.equal(serviced.finished.status, 'completed');
  await runStage('application-service', { files: { [tacticalDesign]: multiAggregate(agentSourced(upTo(document, 4))) }, artifacts });
  assert.deepEqual(treeGit('log', '--format=%s', '-4').trim().split('\n'), ['application-service', 'domain-service', 'aggregate-design', 'domain-model'].map((stage) => `${stage}: ${planSetId}`));
  for (const stage of ['domain-model', 'aggregate-design', 'domain-service', 'application-service']) assert.equal((await stageState(stage)).status, 'completed', `${stage} was accepted without a gate`);
  assertVisibility([' M app.txt'], 'after the four ungated stages');

  // 2. integration-design completes ungated; context-boundary then triggers the single whole-document check: the finding of aggregate-design and of
  // application-service name those stages, the one of its own section names itself, and nothing is committed or recorded.
  const ownError = (text) => text.replace('| 비동기 이벤트 | CON-01 |', '| 비동기 이벤트 | - |');
  const everyone = ownError(multiAggregate(agentSourced(document)));
  assert.notEqual(ownError(document), document);
  await runStage('integration-design', { files: { [tacticalDesign]: document }, artifacts });
  const boundary = await beginStage('context-boundary');
  await submitStage(boundary, { files: { [tacticalDesign]: everyone }, artifacts });
  const head = treeGit('rev-parse', 'HEAD').trim();
  const rejected = finishStage(boundary);
  assert.equal(rejected.status, 1, rejected.stdout);
  const rejection = JSON.parse(rejected.stdout);
  assert.deepEqual(Object.keys(rejection), ['status', 'gate', 'execution_id', 'stage', 'errors', 'instruction', 'output_path', 'code', 'why', 'next']);
  assert.equal(rejection.code, 'GATE_ERROR');
  assert.ok(rejection.next.some((step) => /finish --execution-id /.test(step)), 'the rejection names the finish command to run again');
  assert.equal(rejection.status, 'gate_error');
  assert.equal(rejection.gate, 'domain_model_check');
  assert.equal(rejection.stage, 'context-boundary');
  assert.equal(rejection.execution_id, boundary.prepared.input.execution_id);
  assert.equal(rejection.output_path, boundary.started.output_path);
  assert.deepEqual(rejection.errors.map((error) => [error.owner_stage, error.code, error.id]), [
    ['aggregate-design', 'DECISION_NO_SOURCE', 'CON-01'],
    ['application-service', 'MULTI_AGGREGATE_TRANSACTION', 'AS-04'],
    ['integration-design', 'SAGA_WITHOUT_EVENTUAL', 'INT-01'],
  ]);
  for (const error of rejection.errors) assert.deepEqual(Object.keys(error), error.id ? ['code', 'message', 'id', 'owner_stage'] : ['code', 'message', 'owner_stage']);
  assert.match(rejection.errors[0].message, /an agent proposal alone is not a source/);
  assert.match(rejection.instruction, /once on the whole tactical-design\.md for context-boundary and it failed/);
  assert.match(rejection.instruction, /Nothing was committed or recorded, and the stage is still running/);
  assert.match(rejection.instruction, /Errors whose owner_stage is aggregate-design, application-service, integration-design are in sections of earlier stages/);
  assert.match(rejection.instruction, /returns blocked \/ DEPENDENCY_INCOMPLETE with result\.owner_stage aggregate-design \(the earliest stage to reopen\)/);
  assert.match(rejection.instruction, /reopens aggregate-design itself with --reopen-for and re-runs the stale stages in order, without asking the user/);
  assert.equal(treeGit('rev-parse', 'HEAD').trim(), head, 'a rejected result is not committed');
  assert.equal(existsSync(returned(boundary)), false, 'no canonical return is written');
  const running = await stageState('context-boundary');
  assert.equal(running.status, 'running', 'the stage stays running so the same subagent can answer the rejection');
  assert.equal(running.execution_id, boundary.prepared.input.execution_id);
  assertVisibility([' M app.txt', ` M ${tacticalDesign}`], 'after the rejection the document is visible and nothing else changed');
  assert.equal(await readFile(join(workspace, 'app.txt'), 'utf8'), 'ongoing application change\n', 'application changes stay untouched');
  assert.equal(await readFile(join(workspace, tacticalDesign), 'utf8'), everyone, 'the gate does not edit the stage documents');
  assert.equal(finishStage(boundary).status, 1, 'the same finish rejects again until the output changes');

  // The state command cannot record the stage as completed around the gate either.
  const recorded = spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-execution-state.mjs'), '--root', workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', boundary.prepared.input.execution_id, '--status', 'completed', '--code', 'OK'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(recorded.status, 1);
  assert.match(JSON.parse(recorded.stderr).error, /^Tactical design gate failed for context-boundary: DECISION_NO_SOURCE \(CON-01\) \[aggregate-design\] /);
  assert.equal((await stageState('context-boundary')).status, 'running', 'the state command left the stage running');

  // 3. The subagent follows the instruction: an earlier section is settled input, so it restores its working tree and blocks
  // naming the earliest stage. The block is never gated, and the user reopens that stage through the existing restart.
  treeGit('restore', tacticalDesign);
  await submitStage(boundary, { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: 'CON-01의 출처가 에이전트 제안뿐이다: aggregate-design을 다시 열어야 한다', files: {}, artifacts: [], resultExtra: { owner_stage: 'aggregate-design', dependency_gap: 'CON-01의 출처가 없다' } });
  const blocked = finishStage(boundary);
  assert.equal(blocked.status, 0, blocked.stdout || blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).status, 'blocked');
  assert.equal((await stageState('context-boundary')).status, 'blocked');
  assertVisibility([' M app.txt'], 'after the block');
  // The restart needs a clean project tree, as it always did: the application work is set aside for it and comes back after.
  treeGit('stash', 'push', '--', 'app.txt');
  const restart = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'aggregate-design', '--restart-requirements', 'true']);
  assert.equal(restart.previous_stage, 'domain-model');
  const state = JSON.parse(await readFile(join(workspace, '.io/runtime/orchestrator/state.json'), 'utf8'));
  for (const stage of ['aggregate-design', 'domain-service', 'application-service', 'integration-design', 'context-boundary']) assert.equal(state.stages[stage], undefined, `${stage} is reopened`);
  treeGit('stash', 'pop');

  // 4. The reopened stages run again. Their sections are right now, and integration-design's own error is repaired by itself.
  await runStage('aggregate-design', { files: { [tacticalDesign]: upTo(document, 2) }, artifacts });
  await runStage('domain-service', { files: { [tacticalDesign]: upTo(document, 3) }, artifacts });
  await runStage('application-service', { files: { [tacticalDesign]: upTo(document, 4) }, artifacts });
  await runStage('integration-design', { files: { [tacticalDesign]: document }, artifacts });
  const second = await beginStage('context-boundary');
  const ownBoundaryError = (text) => text.replace('| 커뮤니티 | 신고 | 관계 패턴은 근거가 말해 주는 경우에만 기록 |', '| 커뮤니티 | 신고 | - |');
  await submitStage(second, { files: { [tacticalDesign]: ownBoundaryError(document) }, artifacts });
  const ownRejected = finishStage(second);
  assert.equal(ownRejected.status, 1, ownRejected.stdout);
  const ownRejection = JSON.parse(ownRejected.stdout);
  assert.equal(ownRejection.status, 'gate_error');
  assert.deepEqual(ownRejection.errors.map((error) => [error.owner_stage, error.code]), [['context-boundary', 'BOUNDARY_DECISION_INCOMPLETE']]);
  assert.match(ownRejection.instruction, /same subagent so it repairs its own section/);
  assert.doesNotMatch(ownRejection.instruction, /DEPENDENCY_INCOMPLETE/);
  assert.equal((await stageState('context-boundary')).status, 'running');

  // An unrelated integration error still points back to integration-design, which this stage cannot rewrite.
  const integrationRow = '| 비동기 이벤트 | CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |';
  const crossing = [['| 게시글, 신고 | - | 최종 |', '| 게시글, 신고 | 신고 | 즉시 |'], ['| T2: 신고 (CON-01) |', '| T2: 신고 |']].reduce((text, [from, to]) => { assert.ok(text.includes(from), from); return text.replace(from, to); }, document);
  await writeFile(join(workspace, tacticalDesign), crossing);
  const unrealised = finishStage(second);
  assert.equal(unrealised.status, 1, unrealised.stdout);
  assert.deepEqual(JSON.parse(unrealised.stdout).errors.map((error) => [error.owner_stage, error.code, error.id]), [['integration-design', 'SAGA_WITHOUT_EVENTUAL', 'INT-01']], 'no merge is asked of aggregate-design and the finding is this stage own');
  assert.equal((await stageState('context-boundary')).status, 'running');
  assertVisibility([' M app.txt', ` M ${tacticalDesign}`], 'after the cross-context rejection the document is visible and nothing else changed');
  assert.doesNotMatch(unrealised.stdout, /IMMEDIATE_/, 'the merge and cross-context findings are gone');
  await writeFile(join(workspace, tacticalDesign), crossing.replace(integrationRow, '| 동기 확인 | CON-01 | 없음 — 호출한 쪽이 응답을 기다린다 |'));
  assert.equal(invoke(workspace, 'harness-domain-model-check.mjs', ['--workspace-root', workspace]).ok, true, 'the installed command accepts the synchronous row');
  await writeFile(join(workspace, tacticalDesign), crossing.replace(integrationRow, '| 비동기 이벤트 | CON-01 | 없음 — 이벤트를 곧바로 발행한다 |'));
  assert.equal(invoke(workspace, 'harness-domain-model-check.mjs', ['--workspace-root', workspace]).ok, true, 'and leaves the style of the integration to the stage');

  await writeFile(join(workspace, tacticalDesign), document);
  const accepted = finishStage(second);
  assert.equal(accepted.status, 0, accepted.stdout || accepted.stderr);
  const result = JSON.parse(accepted.stdout);
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'OK');
  assert.equal(treeGit('log', '-1', '--format=%s').trim(), `integration-design: ${planSetId}`);
  assert.deepEqual(treeGit('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [tacticalDesign]);
  assert.equal(existsSync(returned(second)), true);
  assert.equal((await stageState('context-boundary')).status, 'completed');
  assertVisibility([' M app.txt'], 'after the accepted stage');
  assert.equal(await readFile(join(workspace, 'app.txt'), 'utf8'), 'ongoing application change\n');

  // 5. A user revision of an earlier stage is not gated either; the stage lists what it affects and the flow reruns from it.
  const revisionArgs = ['--feedback', '중복 판정 기준을 하루로 바꿔 줘', '--user-revision', 'true'];
  const revision = await beginStage('domain-service', { extraArgs: revisionArgs });
  assert.equal(revision.prepared.input.context.user_revision, true);
  await submitStage(revision, { files: { [tacticalDesign]: multiAggregate(document) }, artifacts });
  assert.equal(finishStage(revision).status, 0, 'the revision is accepted without a gate even with an incomplete section');
  assert.equal(treeGit('log', '-1', '--format=%s').trim(), `domain-service: ${planSetId}`);
});

test('a stage relaunched after a block gets the previous result labelled as evidence of an earlier attempt, and the installed guides make it re-run the gate before it blocks again', async (t) => {
  const flow = await consumerWorkflow(t, '게시글 삭제 기능을 추가해줘');
  const { workspace, treeGit, runStage, specPath } = flow;
  const requirements = specPath('requirements.md');
  const tacticalDesign = specPath('tactical-design.md');
  const art = (path, kind) => ({ path, kind });
  const artifacts = [art(tacticalDesign, 'tactical_design')];
  const document = await templateDocument(sourceRoot);
  for (const stage of REQUIREMENTS_STAGES) {
    const files = stage === 'stakeholder-analysis' ? { [specPath('stakeholder-analysis.md')]: stakeholderAnalysisDocument('게시글 삭제 기능을 추가해줘'), [requirements]: draft(stage) } : { [requirements]: stage === 'bounded-context' ? REQUIREMENTS : draft(stage) };
    await runStage(stage, { files, artifacts: [art(requirements, 'requirements')] });
  }
  await writeFile(join(workspace, 'app.txt'), 'ongoing application change\n');
  for (const [index, stage] of TACTICAL_DESIGN_STAGES.slice(0, 5).entries()) await runStage(stage, { files: { [tacticalDesign]: upTo(document, index + 1) }, artifacts });

  // context-boundary blocked on an earlier-stage gate error that a later Harness no longer reports: the first run has no previous result.
  const staleSummary = 'DECISION_AGGREGATE_MISMATCH (EX-03, owner aggregate-design): 가장 이른 재개 대상은 aggregate-design이다';
  const blocked = await runStage('context-boundary', { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: staleSummary, expectCommit: false, resultExtra: { owner_stage: 'aggregate-design', dependency_gap: staleSummary } });
  assert.equal(blocked.prepared.input.context.previous_result_note, undefined, 'a first run has no previous attempt');
  assert.equal(blocked.prepared.input.context.previous_result_ref, undefined);

  // The current gate reports only what is missing now: the sections of the earlier stages are fine and the unwritten section 6 is context-boundary's own.
  const check = spawnSync(process.execPath, [join(workspace, GATE), '--workspace-root', workspace], { cwd: workspace, encoding: 'utf8' });
  assert.equal(check.status, 1, 'the installed gate reads the current documents and refuses the missing section 6');
  const verdict = JSON.parse(check.stdout);
  assert.ok(verdict.errors.length > 0 && verdict.errors.every((error) => error.owner_stage === 'context-boundary'), `no earlier stage owns an error now: ${check.stdout}`);

  // The relaunch hands the blocked result over as evidence of the earlier attempt, next to the user's instruction, and completes: the block does not carry over.
  const feedback = 'Harness가 업데이트되어 aggregate-design 오류를 내던 gate 검사는 제거되었습니다. context-boundary를 재실행하세요.';
  const relaunched = await runStage('context-boundary', { extraArgs: ['--feedback', feedback], files: { [tacticalDesign]: document }, artifacts });
  const { context, input_refs: refs } = relaunched.prepared.input;
  assert.match(context.previous_result_note, /evidence of an earlier attempt/);
  assert.match(context.previous_result_note, /Re-run the check on the current files before relying on any of them/);
  assert.equal(context.previous_result_ref, `runtime/executions/${blocked.prepared.input.execution_id}/result.json`);
  assert.ok(refs.some((reference) => reference.kind === 'previous_execution_result' && reference.path === context.previous_result_ref), 'the previous result is listed under its own kind');
  assert.equal(JSON.parse(await readFile(join(dirname(relaunched.started.output_path), 'feedback.json'), 'utf8')).feedback, feedback);
  assert.equal(relaunched.finished.status, 'completed');
  assert.equal(JSON.parse(await readFile(join(workspace, '.io/runtime/orchestrator/state.json'), 'utf8')).stages['context-boundary'].status, 'completed');

  // A resume that is not after a block (an answer, a user revision of a completed stage) carries no such note.
  const revision = await runStage('domain-service', { extraArgs: ['--feedback', '중복 판정 기준을 하루로 바꿔 줘', '--user-revision', 'true'], files: { [tacticalDesign]: `${document}\n<!-- 사용자 수정 -->\n` }, artifacts });
  assert.equal(revision.prepared.input.context.user_revision, true);
  assert.equal(revision.prepared.input.context.previous_result_note, undefined, 'a revision of a completed stage is not a retry of an attempt');

  // The installed guides tell the stage to re-run the gate before it blocks on an earlier stage, and they stay Harness-owned while the application work stays visible.
  const owned = [DEEPENING, '.codex/internal-skills/integration-design/GUIDE.md', '.harness/src/workflow/stage-input.mjs'];
  for (const path of owned) {
    assert.equal(await readFile(join(workspace, path), 'utf8'), await read(path), `installed: ${path}`);
    assert.match(treeGit('check-ignore', '-v', path), /info\/exclude/, `ignored: ${path}`);
  }
  const rules = await readFile(join(workspace, DEEPENING), 'utf8');
  assert.match(rules, /## Relaunch after a block[\s\S]*harness-domain-model-check\.mjs --workspace-root <absolute workspace root>[\s\S]*blocks only on errors that this run still reports for earlier stages/);
  assert.match(rules, /`context-boundary` designs `## 6`/);
  assert.match(await readFile(join(workspace, '.codex/internal-skills/context-boundary/GUIDE.md'), 'utf8'), /이전 실행이 `blocked`였다면[\s\S]*deepening\.md#relaunch-after-a-block/);
  // The stage contract the installer writes into the stage profile carries the same rule.
  assert.match(await readFile(join(workspace, '.codex/agents/workflow_stage.toml'), 'utf8'), /`context\.previous_result_note`\): re-run the check on the current files/);
  assert.match(treeGit('check-ignore', '-v', '.codex/agents/workflow_stage.toml'), /info\/exclude/);
  const status = treeGit('status', '--short', '--untracked-files=all');
  assert.match(status, /^ M app\.txt$/m, 'application changes stay visible and untouched');
  assert.doesNotMatch(status, /\.codex\/|\.harness\/|\.claude\/|\.agents\/|\.io\//, 'Harness-managed files stay out of commits');
  assert.equal(await readFile(join(workspace, 'app.txt'), 'utf8'), 'ongoing application change\n');
});

test('a plan set that an earlier Harness started is renamed to tactical-design.md when the next tactical stage is prepared, keeps its history, restarts across the rename and keeps Git visibility', async (t) => {
  const flow = await consumerWorkflow(t, '게시글 삭제 기능을 추가해줘');
  const { workspace, treeGit, invoke, runStage, beginStage, submitStage, finishStage, planSetId, specPath } = flow;
  const requirements = specPath('requirements.md');
  const legacy = specPath('domain-model.md');
  const current = specPath('tactical-design.md');
  const projectIndex = 'docs/architecture/domain-model.md';
  const art = (path, kind) => ({ path, kind });
  const document = await templateDocument(sourceRoot);
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const visible = () => treeGit('status', '--short', '--untracked-files=all').split('\n').filter(Boolean).sort();
  const assertVisibility = (expected, label) => {
    assert.deepEqual(visible(), expected.sort(), label);
    assert.doesNotMatch(visible().join('\n'), /\.codex\/|\.harness\/|\.claude\/|\.agents\/|\.io\//, `${label}: Harness-managed files stay out of the status`);
  };
  const restartArgs = (stage) => ['--stage-id', stage, '--restart-requirements', 'true'];

  for (const stage of REQUIREMENTS_STAGES) {
    const files = stage === 'stakeholder-analysis' ? { [specPath('stakeholder-analysis.md')]: stakeholderAnalysisDocument('게시글 삭제 기능을 추가해줘'), [requirements]: draft(stage) } : { [requirements]: stage === 'bounded-context' ? REQUIREMENTS : draft(stage) };
    await runStage(stage, { files, artifacts: [art(requirements, 'requirements')] });
  }
  // The earlier Harness wrote and committed the document as domain-model.md, next to the project's own model index.
  await runStage('domain-model', { files: { [legacy]: upTo(document, 1), [projectIndex]: projectModel('v1') }, artifacts: [art(legacy, 'tactical_design'), art(projectIndex, 'model_index')] });
  assert.deepEqual(treeGit('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), [projectIndex, legacy].sort());
  await writeFile(join(workspace, 'app.txt'), 'ongoing application change\n');
  assertVisibility([' M app.txt'], 'before the migration');

  // 1. Preparing the next tactical stage renames the document before the stage runs; only that document moves.
  const aggregate = await beginStage('aggregate-design');
  assert.equal(existsSync(join(workspace, legacy)), false, 'the legacy name is gone before the stage runs');
  assert.equal(await readFile(join(workspace, current), 'utf8'), upTo(document, 1), 'the stage finds the document under its current name with its content');
  assert.equal(await readFile(join(workspace, projectIndex), 'utf8'), projectModel('v1'), 'the project model index is never renamed');
  assertVisibility([' M app.txt', `R  ${legacy} -> ${current}`], 'the rename is staged and application changes stay visible and untouched');

  // 2. The stage writes its own section under the current name; the stage commit carries the rename, so history follows the file.
  await submitStage(aggregate, { files: { [current]: upTo(document, 2) }, artifacts: [art(current, 'tactical_design')] });
  const accepted = finishStage(aggregate);
  assert.equal(accepted.status, 0, accepted.stdout || accepted.stderr);
  assert.equal(treeGit('log', '-1', '--format=%s').trim(), `aggregate-design: ${planSetId}`);
  const [kind, from, to] = treeGit('show', '--name-status', '-M', '--format=', 'HEAD').trim().split('\t');
  assert.match(kind, /^R\d+$/, 'the commit records a rename');
  assert.deepEqual([from, to], [legacy, current]);
  assert.deepEqual(treeGit('log', '--follow', '--format=%s', '--', current).trim().split('\n'), [`aggregate-design: ${planSetId}`, `domain-model: ${planSetId}`], 'history follows the file across the rename');
  assert.equal(treeGit('ls-tree', '--name-only', 'HEAD', '--', legacy).trim(), '');
  assertVisibility([' M app.txt'], 'after the stage commit');
  // The finished domain-model stage still records its artifact under the legacy name; reopening it by a user revision follows the rename.
  const revised = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'domain-model', '--feedback', '모델 이름을 바꿔 줘', '--user-revision', 'true']);
  assert.equal(revised.input.skill, 'domain-model');
  assert.equal(revised.input.context.user_revision, true);
  assert.ok(existsSync(join(workspace, current)) && !existsSync(join(workspace, legacy)), 'preparing a revision keeps the current name');

  // 3. A restart that cannot finish puts the working tree back: the legacy document restored from the checkpoint is not left behind.
  treeGit('stash', 'push', '--', 'app.txt');
  const original = await readFile(statePath, 'utf8');
  const tampered = JSON.parse(original);
  tampered.stages['domain-model'].status = 'failed';
  await writeFile(statePath, JSON.stringify(tampered, null, 2) + '\n');
  const failed = spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), ...restartArgs('aggregate-design')], { cwd: workspace, encoding: 'utf8' });
  await writeFile(statePath, original);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Previous stage is not completed/);
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '', 'a failed restart leaves the committed tree as it was');
  assert.equal(existsSync(join(workspace, legacy)), false);
  assert.equal(await readFile(join(workspace, current), 'utf8'), upTo(document, 2));

  // 4. A restart to the checkpoint before the rename restores the document under the name it had then.
  const restart = invoke(workspace, 'harness-prepare-input.mjs', restartArgs('aggregate-design'));
  assert.equal(restart.previous_stage, 'domain-model');
  assert.equal(await readFile(join(workspace, legacy), 'utf8'), upTo(document, 1), 'the checkpoint document is back under its legacy name');
  assert.equal(existsSync(join(workspace, current)), false);
  assert.deepEqual(visible(), [` D ${current}`, `?? ${legacy}`].sort(), 'the restored document is project-owned and visible');
  assert.deepEqual(JSON.parse(await readFile(join(restart.backup, 'restart.json'), 'utf8')).paths.sort(), [current, legacy].sort());
  treeGit('stash', 'pop');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.current_stage, 'domain-model');
  assert.equal(state.stages['aggregate-design'], undefined);

  // 5. The reopened stage is prepared again: the runner renames the restored document once more and the stage commits it.
  const reopened = await beginStage('aggregate-design');
  assert.equal(existsSync(join(workspace, legacy)), false);
  assertVisibility([' M app.txt', ` M ${current}`], 'the restored document is a modification of the committed one');
  await submitStage(reopened, { files: { [current]: `${upTo(document, 2)}\n<!-- restart 뒤 다시 쓴 절 -->\n` }, artifacts: [art(current, 'tactical_design')] });
  const again = finishStage(reopened);
  assert.equal(again.status, 0, again.stdout || again.stderr);
  assert.equal(treeGit('log', '-1', '--format=%s').trim(), `aggregate-design: ${planSetId}`);
  assert.equal(treeGit('ls-tree', '--name-only', 'HEAD', '--', legacy).trim(), '', 'the legacy name never returns to the history');
  assert.match(treeGit('show', `HEAD:${current}`), /restart 뒤 다시 쓴 절/);
  assertVisibility([' M app.txt'], 'after the reopened stage');

  // 6. A restart to the first tactical stage, whose checkpoint predates the document, removes it under both names.
  treeGit('stash', 'push', '--', 'app.txt');
  const first = invoke(workspace, 'harness-prepare-input.mjs', restartArgs('domain-model'));
  assert.equal(first.previous_stage, 'bounded-context');
  assert.equal(existsSync(join(workspace, current)), false);
  assert.equal(existsSync(join(workspace, legacy)), false);
  assert.deepEqual(visible(), [` D ${current}`, ` D ${projectIndex}`].sort());
  treeGit('stash', 'pop');

  // Harness-owned files stay ignored, and the plan set documents and the project model index stay visible to Git.
  for (const path of ['.codex/scripts/harness-prepare-input.mjs', '.harness/src/workflow/stage-commit.mjs', '.codex/internal-skills/domain-model/references/template.md']) assert.match(treeGit('check-ignore', '-v', path), /info\/exclude/, `ignored: ${path}`);
  for (const path of [current, legacy, projectIndex, requirements]) assert.throws(() => treeGit('check-ignore', '-q', path), `not ignored: ${path}`);
});
