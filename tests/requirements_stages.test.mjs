import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { WORKTREE_STAGE, REQUIREMENTS_STAGES, TACTICAL_DESIGN_STAGES } from '../.harness/src/workflow/worktree-stages.mjs';
import { MODELS, SETUP, STAGE_TIERS, consumerWorkflow, gitIn, sourceRoot } from './support/consumer-workflow.mjs';

const TEMPLATE = '.codex/internal-skills/requirements-fix/references/template.md';
const read = (path) => readFile(join(sourceRoot, path), 'utf8');
const fenced = (text, language) => [...text.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```', 'g'))].map((match) => match[1]);

test('the requirements.md template, the stage guides and the orchestrator agree on the flow and the shape', async () => {
  // The flow order lives in one list; the orchestrator and the workflow map name the stages in that order before spec-me.
  assert.deepEqual(REQUIREMENTS_STAGES, ['stakeholder-analysis', 'subdomain-candidates', 'ubiquitous-language', 'event-storming', 'subdomain-classification', 'bounded-context', 'requirements-fix']);
  for (const stage of REQUIREMENTS_STAGES) assert.ok(Object.values(WORKTREE_STAGE).includes(stage), `${stage} is a worktree stage`);
  const orchestrator = await read('.codex/skills/orchestrator/SKILL.md');
  assert.ok(orchestrator.includes(REQUIREMENTS_STAGES.map((stage) => `\`${stage}\``).join(' → ')), 'the orchestrator names the flow in order');
  assert.match(orchestrator, /요구사항 흐름에서 완료되지 않은 첫 stage/);
  assert.match(orchestrator, /`fixed` `requirements\.md`\(소유 skill `requirements-fix`\)/);
  const map = await read('.codex/internal-skills/skill-execution/references/workflow-map.md');
  const positions = REQUIREMENTS_STAGES.map((stage) => map.indexOf(`\`${stage}\``));
  assert.ok(positions.every((position) => position >= 0) && positions.every((position, index) => index === 0 || position > positions[index - 1]), 'the workflow map names the stages in order');

  // The template owns the final shape.
  const template = await read(TEMPLATE);
  const document = fenced(template, 'markdown').find((block) => block.startsWith('# 요구사항 명세'));
  assert.ok(document, 'the template carries the document shape');
  assert.deepEqual([...document.matchAll(/^## (.+)$/gm)].map((match) => match[1]), ['1. 서브도메인 후보', '2. 업무', '3. 용어', '4. 서브도메인 간 이벤트', '5. hotspot', '6. 공통']);
  assert.match(document, /^- 상태: draft \| fixed$/m);
  assert.match(document, /^\| SD \| 이름 \| 업무 범위 \| 포함 업무 \| 핵심 용어 후보 \| 분리 이유\(가설\) \| 분류 \| 근거 \| 상태 \|$/m);
  assert.match(document, /^### 1\.1 바운디드 컨텍스트$/m);
  assert.match(document, /^\| BC \| 포함 SD·BIZ \| 책임 \| 소유 규칙·데이터 \| 근거 \| 비교한 대안 \|$/m);
  assert.match(document, /\| core \|[^\n]*\| confirmed \|/, 'a confirmed subdomain carries its class');
  assert.match(document, /\| 회원 \(커뮤니티\) \|/, 'a term that differs by context has one row per context with the context in the term cell');
  assert.match(document, /^\| 용어 \| 뜻 \| 쓰지 않을 말 \|$/m, 'the term table has exactly three columns');
  const biz = document.slice(document.indexOf('### BIZ-01'), document.indexOf('## 3. 용어'));
  for (const field of ['상태', '업무 목적', '업무 주체', '참여한 stakeholder', '정상 시나리오', '업무 규칙', '예외 시나리오', '완료 조건', '이벤트 흐름', '출처·변경 이력']) assert.match(biz, new RegExp(`^- ${field}:`, 'm'), field);
  assert.match(biz, /INV-01/); assert.match(biz, /EX-01/); assert.match(biz, /AC-01/);
  assert.match(biz, /\| 순서 \| 행위자 \| 명령 \| 도메인 이벤트 \| 정책 \| 외부 시스템 \| 근거 \|/);
  for (const source of ['요청 원문', 'CAND-xx 채택', 'answers.json', '요청 해석(에이전트 제안)']) assert.ok(template.includes(source), `source: ${source}`);
  for (const heading of ['6.1 범위·비목표', '6.2 우선순위·트레이드오프', '6.3 업무 상태·전이', '6.4 E2E 시나리오']) assert.ok(document.includes(heading), heading);
  assert.match(document, /\(answers\.json\)/, 'a user-decided term row ends with (answers.json)');
  assert.match(document, /\]\(diagrams\/events\/<name>\.puml\)/, 'the template links both the .puml and the .svg');
  assert.match(document, /\]\(diagrams\/events\/<name>\.svg\)/);

  // The persona record keeps only the persona record; the requirements it settles live in requirements.md.
  const analysis = await read('.codex/internal-skills/stakeholder-analysis/references/output-template.md');
  assert.doesNotMatch(analysis, /요구사항 초안\n|## 7\./);
  assert.match(analysis, /## 4\. 후보 요구사항/);
  assert.match(analysis, /## 5\. 충돌/);
  assert.match(analysis, /요청 범위 밖 관찰/);
  assert.match(await read('.codex/internal-skills/stakeholder-analysis/GUIDE.md'), /create `requirements\.md`/);

  // Each stage guide links the template, keeps its own boundary and returns through the common contract.
  for (const stage of REQUIREMENTS_STAGES.slice(1)) {
    const guide = await read(`.codex/internal-skills/${stage}/GUIDE.md`);
    assert.match(guide, /^---\nmodel_tier: (implementation|high_performance)\n---/, stage);
    assert.match(guide, /requirements-fix\/references\/template\.md|\(references\/template\.md\)/, `${stage} links the template`);
    assert.match(guide, /`판정: 생략`/, `${stage} records a skip`);
    assert.match(guide, /harness-spec-path\.mjs/, `${stage} resolves paths with the helper`);
    assert.match(guide, /harness-workspace-preflight\.mjs/, `${stage} runs the preflight`);
    assert.match(guide, /The runner commits `docs\/specs\/<plan-set-id>\/`/, `${stage} says what the runner commits`);
  }
  assert.match(await read('.codex/internal-skills/ubiquitous-language/GUIDE.md'), /`docs\/specs\/<plan-set-id>\/` and `CONTEXT\.md`/);
  assert.match(await read('.codex/internal-skills/ubiquitous-language/GUIDE.md'), /provisional BIZ scope/);
  const classification = await read('.codex/internal-skills/subdomain-classification/GUIDE.md');
  assert.match(classification, /`core`[\s\S]*`generic`[\s\S]*`supporting`/);
  assert.match(classification, /in one batch/);
  assert.match(classification, /A render failure blocks completion/);
  const context = await read('.codex/internal-skills/bounded-context/GUIDE.md');
  assert.match(context, /\[ddd-design\]\(\.\.\/ddd-design\/GUIDE\.md\)/, 'the boundary rule is linked, not copied');
  assert.match(context, /\[model-continuity\]\(\.\.\/ddd-design\/references\/model-continuity\.md\)/);
  assert.match(context, /`accepted-target`/);
  assert.match(context, /`CONTEXT-MAP\.md` and `CONTEXT\.md` when this stage completes/);
  assert.match(context, /Assign provisional BIZ-scoped glossary entries/);
  assert.match(context, /material meaning conflict/);
  const dispatch = await read('.codex/internal-skills/skill-execution/references/dispatch.md');
  assert.match(dispatch, /fork_turns: "none"/);
  assert.match(dispatch, /상위 대화·도구 출력·문서 본문을 복사하지 않고/);
  const languageGuide = await read('.codex/internal-skills/ubiquitous-language/GUIDE.md');
  assert.match(languageGuide, /after `subdomain-candidates` and before `event-storming`/);
  assert.match(languageGuide, /Do not rewrite every sentence/);
  assert.match(languageGuide, /not bounded contexts/);
  assert.match(await read('.codex/internal-skills/event-storming/GUIDE.md'), /Use settled terms in events and diagrams/);
  assert.match(await read('.codex/internal-skills/event-storming/GUIDE.md'), /settled `## 3` term table/);
  assert.match(context, /upstream, downstream, each context's responsibility, the communication contract[^`]*and the `판단 소유자`/);
  assert.match(context, /write `미정` with the reason when the evidence does not say/);
  assert.match(context, /has no `판단 소유자` column gets the column added/);
  // The map template every new project gets carries the decision owner next to the contract, and the guide's wording matches it.
  assert.match(await read('.codex/skills/setup/assets/CONTEXT-MAP.md'), /^\| Upstream \| Downstream \| Upstream 책임 \| Downstream 책임 \| 통신 계약 \| 판단 소유자 \| 상태·근거 \|\n\|---\|---\|---\|---\|---\|---\|---\|$/m);
  assert.match(context, /mark unspecified details as undecided/);
  assert.match(context, /pattern only when supported by evidence/);
  const events = await read('.codex/internal-skills/event-storming/GUIDE.md');
  assert.match(events, /`mode: events`/);
  assert.match(events, /`stakeholder_persona`/);
  assert.match(events, /A render failure blocks completion/);
  assert.match(await read('.codex/internal-skills/stakeholder-persona/GUIDE.md'), /^## Events mode$/m);
  assert.match(await read('.codex/internal-skills/requirements-fix/GUIDE.md'), /automatically/);
  assert.ok((await read('.codex/internal-skills/requirements-fix/references/coverage.md')).includes('확정 조건'));

  // spec-me and the Product procedure only read a fixed document; downstream consumers keep product-spec.md.
  assert.match(await read('.codex/internal-skills/spec-me/GUIDE.md'), /requirements\.md` exists with `상태: fixed`[\s\S]*requirements\.md BIZ-xx/);
  assert.match(await read('.codex/internal-skills/product-spec/GUIDE.md'), /`상태: fixed`[\s\S]*requirements\.md BIZ-xx/);
  assert.match(await read('.codex/internal-skills/spec-me/GUIDE.md'), /bounded-context table[\s\S]*do not compare the context boundaries again/);
  assert.match(await read('.codex/internal-skills/architecture-spec/GUIDE.md'), /requirements\.md` when present instead of running it again/);
  assert.match(await read('.codex/internal-skills/architecture-spec/GUIDE.md'), /already settled the contexts/);
  assert.match(await read('.codex/internal-skills/ddd-design/GUIDE.md'), /requirements\.md` when present/);
  assert.match(await read('.codex/internal-skills/ddd-design/GUIDE.md'), /do not compare the boundaries again/);
});

test('installed consumers get the requirements stages and diagram tooling, Git ignores them and keeps the plan set documents visible', async (t) => {
  await mkdir(resolve(sourceRoot, '.io'), { recursive: true });
  const root = await mkdtemp(resolve(sourceRoot, '.io/requirements-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = gitIn(root);
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'app.txt'), 'original application\n');
  await writeFile(join(root, 'CONTEXT.md'), '# 프로젝트 컨텍스트\n');
  await writeFile(join(root, 'CONTEXT-MAP.md'), '# 소비자 소유 관계\n');
  git('add', 'app.txt', 'CONTEXT.md', 'CONTEXT-MAP.md');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
  await writeFile(join(root, 'app.txt'), 'ongoing application change\n');
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  await writeFile(join(root, '.harness/harness.yaml'), SETUP);

  const managed = [
    ...REQUIREMENTS_STAGES.slice(1).map((name) => `.codex/internal-skills/${name}/GUIDE.md`),
    '.codex/internal-skills/architecture-spec/GUIDE.md',
    '.harness/src/workflow/requirements-restart.mjs',
    '.harness/src/workflow/worktree-stages.mjs',
    '.harness/src/workflow/stage-commit.mjs',
    '.codex/internal-skills/skill-execution/references/dispatch.md',
    '.codex/internal-skills/skill-execution/references/workflow-map.md',
    '.codex/scripts/harness-fresh-agent.mjs',
    '.codex/scripts/harness-setup.mjs',
    TEMPLATE,
    '.codex/internal-skills/requirements-fix/references/coverage.md',
    '.codex/internal-skills/event-storming/references/diagrams.md',
    '.codex/internal-skills/stakeholder-persona/GUIDE.md',
    '.codex/tools/plantuml-bootstrap.mjs',
    '.codex/tools/plantuml-render.mjs',
  ];
  const lock = JSON.parse(await readFile(join(root, '.codex/harness-lock.json'), 'utf8'));
  for (const path of managed) {
    assert.ok(existsSync(join(root, path)), `installed: ${path}`);
    assert.ok(lock.files[path], `lock inventory: ${path}`);
    assert.match(git('check-ignore', '-v', path), /info\/exclude/, `ignored: ${path}`);
    assert.equal(await readFile(join(root, path), 'utf8'), await read(path), `same content: ${path}`);
  }
  const setupMap = '.agents/skills/setup/assets/CONTEXT-MAP.md';
  assert.ok(lock.files[setupMap]);
  assert.equal(await readFile(join(root, setupMap), 'utf8'), await read('.codex/skills/setup/assets/CONTEXT-MAP.md'));
  assert.match(git('check-ignore', '-v', setupMap), /info\/exclude/);
  const hook = join(root, '.codex/scripts/harness-fresh-agent.mjs');
  const hookEvent = (fork_turns) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'collaborationspawn_agent', tool_input: { agent_type: 'workflow_stage', fork_turns } });
  const denied = spawnSync(process.execPath, [hook], { input: hookEvent('all'), encoding: 'utf8' });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(spawnSync(process.execPath, [hook], { input: hookEvent('none'), encoding: 'utf8' }).stdout, '');

  // The tiers resolve from the installed documents, and the installed commit wiring is the source wiring.
  const binding = (skill) => JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-skill-execution.mjs'), 'binding', '--root', root, '--skill', skill], { cwd: root, encoding: 'utf8' }));
  for (const [stage, tier] of Object.entries(STAGE_TIERS)) assert.deepEqual(binding(stage), { skill: stage, provider: 'codex', model_tier: tier, model: MODELS[tier], reasoning_effort: tier === 'high_performance' ? 'high' : 'medium' }, stage);
  const installedStages = await import(pathToFileURL(join(root, '.harness/src/workflow/worktree-stages.mjs')));
  assert.deepEqual([...installedStages.REQUIREMENTS_STAGES], REQUIREMENTS_STAGES);
  const { commitWorkflowDocuments } = await import(pathToFileURL(join(root, '.harness/src/workflow/stage-commit.mjs')));
  assert.equal(typeof commitWorkflowDocuments, 'function');

  // Plan set documents, the glossary and the project's own cards are project-owned and stay visible next to application changes.
  await mkdir(join(root, 'docs/specs/community/diagrams/events'), { recursive: true });
  await mkdir(join(root, 'docs/domain/stakeholders'), { recursive: true });
  await writeFile(join(root, 'docs/specs/community/requirements.md'), '# 요구사항 명세\n');
  await writeFile(join(root, 'docs/specs/community/diagrams/events/SD-01.events.puml'), '@startuml\n@enduml\n');
  await writeFile(join(root, 'docs/domain/stakeholders/SH-01.md'), '---\nid: SH-01\n---\n');
  await writeFile(join(root, 'CONTEXT.md'), '# 프로젝트 컨텍스트\n\n- 게시글\n');
  const status = git('status', '--short', '--untracked-files=all');
  assert.match(status, /\?\? docs\/specs\/community\/requirements\.md/);
  assert.match(status, /\?\? docs\/specs\/community\/diagrams\/events\/SD-01\.events\.puml/);
  assert.match(status, /\?\? docs\/domain\/stakeholders\/SH-01\.md/);
  assert.match(status, /^ M app\.txt$/m, 'application changes stay visible and untouched');
  assert.match(status, /^ M CONTEXT\.md$/m, 'the glossary is project-owned');
  assert.doesNotMatch(status, /\.codex\/|\.harness\/|\.claude\/|\.agents\/|\.io\//, 'Harness-managed files stay out of commits');
  for (const path of ['docs/specs/community/requirements.md', 'docs/specs/community/diagrams/events/SD-01.events.svg', 'CONTEXT.md']) assert.throws(() => git('check-ignore', '-q', path), `not ignored: ${path}`);

  // Doctor accepts the installation, reports a missing managed asset, and update restores it without touching project documents.
  let doctor = await runDoctor({ root, sourceRoot });
  assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  const template = join(root, TEMPLATE);
  const renderer = join(root, '.codex/tools/plantuml-render.mjs');
  const coverage = join(root, '.codex/internal-skills/requirements-fix/references/coverage.md');
  const contextGuide = join(root, '.codex/internal-skills/bounded-context/GUIDE.md');
  const restartModule = join(root, '.harness/src/workflow/requirements-restart.mjs');
  const dispatchGuide = join(root, '.codex/internal-skills/skill-execution/references/dispatch.md');
  const freshHook = join(root, '.codex/scripts/harness-fresh-agent.mjs');
  await unlink(template);
  await unlink(renderer);
  await writeFile(coverage, 'locally edited coverage\n');
  await writeFile(contextGuide, 'outdated guide\n');
  await unlink(restartModule);
  await unlink(dispatchGuide);
  await unlink(freshHook);
  doctor = await runDoctor({ root, sourceRoot });
  for (const path of [template, renderer, restartModule, dispatchGuide, freshHook]) assert.ok(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path === path), `missing: ${path}`);
  await updateProject({ sourceRoot, targetRoot: root });
  for (const path of [TEMPLATE, '.codex/tools/plantuml-render.mjs', '.codex/internal-skills/requirements-fix/references/coverage.md', '.codex/internal-skills/bounded-context/GUIDE.md', '.codex/internal-skills/skill-execution/references/dispatch.md', '.codex/scripts/harness-fresh-agent.mjs', '.harness/src/workflow/requirements-restart.mjs']) assert.equal(await readFile(join(root, path), 'utf8'), await read(path), `restored: ${path}`);
  for (const path of managed) assert.match(git('check-ignore', '-v', path), /info\/exclude/, `still ignored after update: ${path}`);
  assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  assert.equal(await readFile(join(root, 'docs/specs/community/requirements.md'), 'utf8'), '# 요구사항 명세\n');
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'ongoing application change\n');
  assert.equal(await readFile(join(root, 'CONTEXT-MAP.md'), 'utf8'), '# 소비자 소유 관계\n');
  assert.match(git('status', '--short', '--untracked-files=all'), /\?\? docs\/specs\/community\/requirements\.md/);
});

const REQUEST = '게시글 삭제 기능을 추가해줘';

test('the requirements stages run in order as workflow stages and the tactical design flow accepts the last one as its previous stage', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, treeGit, invoke, runStage, planSetId, specDirectory, specPath } = flow;
  const requirements = specPath('requirements.md');
  const analysis = specPath('stakeholder-analysis.md');
  assert.equal(requirements, `${specDirectory}/requirements.md`);
  const artifact = (path, kind) => ({ path, kind });
  await mkdir(join(workspace, 'docs/domain/stakeholders'), { recursive: true });
  await writeFile(join(workspace, 'docs/domain/stakeholders/SH-01.md'), '---\nid: SH-01\nkind: person\nrole: "작성자"\ngoals:\n  - "내 글을 지운다"\n---\n');

  // 1. stakeholder-analysis creates both documents; the requirements draft only holds what the user settled.
  const first = await runStage('stakeholder-analysis', {
    files: { [analysis]: `# Stakeholder 분석\n\n> ${REQUEST}\n`, [requirements]: `# 요구사항 명세\n\n- 상태: draft\n\n## 2. 업무\n\n### 요구사항 초안\n\n- 업무 목적: 게시글 삭제 (요청 원문: "게시글 삭제 기능")\n` },
    artifacts: [artifact(analysis, 'stakeholder_analysis'), artifact(requirements, 'requirements')],
    summary: 'CAND 1건 채택',
  });
  assert.deepEqual(first.files, [analysis, requirements].sort());

  // 2. subdomain-candidates receives the previous stage's documents and only rewrites requirements.md.
  const second = await runStage('subdomain-candidates', {
    files: { [requirements]: '# 요구사항 명세\n\n- 상태: draft\n\n## 1. 서브도메인 후보\n\n| SD | 이름 | 업무 범위 | 포함 업무 | 핵심 용어 후보 | 분리 이유(가설) | 상태 |\n|---|---|---|---|---|---|---|\n| SD-01 | 게시판 | 글 삭제 | BIZ-01 | 게시글 | 기존 영역 확장: 커뮤니티 | draft |\n\n## 2. 업무\n\n### BIZ-01 게시글 삭제 (SD-01)\n' },
    artifacts: [artifact(requirements, 'requirements')],
  });
  assert.equal(second.prepared.input.context.transition.from_stage, 'stakeholder-analysis');
  assert.ok(second.prepared.input.input_refs.some((reference) => reference.path === requirements && reference.kind === 'requirements'));
  assert.deepEqual(second.files, [requirements]);

  // 3. ubiquitous-language commits the plan set documents and the project glossary in one commit.
  const language = await runStage('ubiquitous-language', {
    files: { [requirements]: '# 요구사항 명세\n\n- 상태: draft\n\n## 3. 용어\n\n| 용어 | 뜻 | 쓰지 않을 말 |\n|---|---|---|\n| 게시글 | 회원이 올린 글 하나 (answers.json) | 포스트 |\n', 'CONTEXT.md': '# 프로젝트 컨텍스트\n\n| Canonical Term | Korean |\n|---|---|\n| Post | 게시글 |\n' },
    artifacts: [artifact(requirements, 'requirements'), artifact('CONTEXT.md', 'glossary')],
  });
  assert.deepEqual(language.files, ['CONTEXT.md', requirements]);

  // 4. event-storming asks its hotspots in one batch, then resumes with the answer and commits tables and diagrams together.
  const eventFiles = { [`${specDirectory}/diagrams/events/SD-01.events.puml`]: '@startuml\n@enduml\n', [`${specDirectory}/diagrams/events/SD-01.events.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"/>\n', [`${specDirectory}/diagrams/events/cross-subdomain.events.puml`]: '@startuml\n@enduml\n', [`${specDirectory}/diagrams/events/cross-subdomain.events.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"/>\n' };
  const question = { question_id: 'hotspot-1', title: '[BIZ-01] HS-01 삭제한 게시글을 복구할 수 있나요?', options: [{ id: 'no', label: '복구할 수 없다', consequence: '삭제는 되돌릴 수 없다', evidence: [] }, { id: 'yes', label: '복구할 수 있다', consequence: '삭제 상태를 보관한다', evidence: [] }], recommended_option_id: 'no', rationale: '요청은 삭제만 말한다', decision_kind: null };
  const waiting = await runStage('event-storming', {
    files: { [requirements]: '# 요구사항 명세\n\n- 상태: draft\n\n## 5. hotspot\n\n| HS | 질문 | 관련 BIZ | 상태 | 결정 | 출처 |\n|---|---|---|---|---|---|\n| HS-01 | 삭제한 글을 복구할 수 있는가 | BIZ-01 | 대기 | | |\n' },
    status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: 'hotspot 1건 질문', artifacts: [artifact(requirements, 'requirements')], questions: [question], expectCommit: false,
  });
  assert.equal(waiting.prepared.input.context.transition.from_stage, 'ubiquitous-language');
  assert.ok(waiting.prepared.input.input_refs.some((reference) => reference.path === 'CONTEXT.md'), 'event-storming receives the early glossary');
  assert.equal(waiting.finished.result.questions[0].question_id.length > 0, true, 'the runner identifies the question');
  const questionId = waiting.finished.result.questions[0].question_id;
  const resumed = await runStage('event-storming', {
    extraArgs: ['--answer', 'no'],
    files: { [requirements]: '# 요구사항 명세\n\n- 상태: draft\n\n## 4. 서브도메인 간 이벤트\n\n## 5. hotspot\n\n| HS | 질문 | 관련 BIZ | 상태 | 결정 | 출처 |\n|---|---|---|---|---|---|\n| HS-01 | 삭제한 글을 복구할 수 있는가 | BIZ-01 | 해결 | 복구할 수 없다 → INV-01 | answers.json |\n', [analysis]: `# Stakeholder 분석\n\n> ${REQUEST}\n\n요청 범위 밖 관찰: LENS-DOMAIN (event-storming)\n`, ...eventFiles },
    artifacts: [artifact(requirements, 'requirements'), artifact(analysis, 'stakeholder_analysis'), artifact(`${specDirectory}/diagrams/events`, 'event_diagrams')],
  });
  assert.deepEqual(resumed.files, [analysis, requirements, ...Object.keys(eventFiles).sort()].sort());
  assert.ok(resumed.prepared.input.input_refs.some((reference) => reference.kind === 'previous_execution_result'), 'the resumed stage reads its previous result');
  const answers = JSON.parse(await readFile(join(dirname(resumed.started.output_path), 'answers.json'), 'utf8'));
  assert.deepEqual(answers.map((entry) => [entry.question_id, entry.answer]), [[questionId, 'no']], 'the stage receives the actual answer under the identified question');

  // 5. subdomain-classification confirms the set and the classes with the user, then commits the plan set documents only.
  const classQuestion = { question_id: 'class-1', title: '[SD-01] 게시판의 분류는 무엇인가요?', options: [{ id: 'core', label: 'core', consequence: '이 요청의 차별점이다', evidence: [] }, { id: 'supporting', label: 'supporting', consequence: '필요하지만 차별되지 않는다', evidence: [] }], recommended_option_id: 'core', rationale: '글 삭제가 요청의 핵심이다', decision_kind: null };
  const classifying = await runStage('subdomain-classification', {
    status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '분류 질문', questions: [classQuestion], expectCommit: false,
  });
  assert.ok(classifying.finished.result.questions[0].question_id);
  const classified = await runStage('subdomain-classification', {
    extraArgs: ['--answer', 'core'],
    files: { [requirements]: '# 요구사항 명세\n\n- 상태: draft\n\n## 1. 서브도메인 후보\n\n| SD | 이름 | 업무 범위 | 포함 업무 | 핵심 용어 후보 | 분리 이유(가설) | 분류 | 근거 | 상태 |\n|---|---|---|---|---|---|---|---|---|\n| SD-01 | 게시판 | 글 삭제 | BIZ-01 | 게시글 | 기존 영역 확장: 커뮤니티 | core | 요청의 핵심이다 — 출처: answers.json | confirmed |\n' },
    artifacts: [artifact(requirements, 'requirements')],
  });
  assert.deepEqual(classified.files, [requirements]);

  // 6. bounded-context commits the plan set documents together with the project's context map.
  const contexts = await runStage('bounded-context', {
    files: { 'CONTEXT.md': '# 프로젝트 컨텍스트\n\n| Post | 게시글 (커뮤니티) |\n', [requirements]: '# 요구사항 명세\n\n- 상태: draft\n\n### 1.1 바운디드 컨텍스트\n\n| BC | 포함 SD·BIZ | 책임 | 소유 규칙·데이터 | 근거 | 비교한 대안 |\n|---|---|---|---|---|---|\n| 커뮤니티 | SD-01(BIZ-01) | 글 삭제 | INV-01 | 기존 컨텍스트 확장 | 분리 안 |\n', 'CONTEXT-MAP.md': '# 컨텍스트 맵\n\n| Bounded Context | 책임 | 주 입력 | 주 출력 | 비고 |\n|---|---|---|---|---|\n| 커뮤니티 | 글 삭제 | 삭제 요청 | 게시글이 삭제됨 | accepted-target, SD-01 core |\n' },
    artifacts: [artifact(requirements, 'requirements'), artifact('CONTEXT-MAP.md', 'context_map'), artifact('CONTEXT.md', 'glossary')],
  });
  assert.deepEqual(contexts.files, ['CONTEXT-MAP.md', 'CONTEXT.md', requirements]);

  // 7. requirements-fix fixes the document automatically and the runner commits it.
  const fixed = await runStage('requirements-fix', {
    files: { [requirements]: '# 요구사항 명세\n\n- 상태: fixed\n' },
    artifacts: [artifact(requirements, 'requirements')],
  });
  assert.deepEqual(fixed.files, [requirements]);
  assert.match(await readFile(join(workspace, requirements), 'utf8'), /상태: fixed/);

  // The tactical design flow follows the last requirements stage and receives the fixed document as an input reference;
  // spec-me waits for it, so the requirements flow alone does not reach spec-me.
  const premature = spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--stage-id', 'spec-me'], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(premature.status, 0);
  assert.match(premature.stderr, /spec-me cannot start before domain-model/);
  const next = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'domain-model']);
  assert.equal(next.input.skill, 'domain-model');
  assert.equal(next.input.context.transition.from_stage, 'requirements-fix');
  assert.equal(next.input.context.transition.code, 'OK');
  assert.ok(next.input.input_refs.some((reference) => reference.base === 'workspace' && reference.path === requirements && reference.kind === 'requirements'));
  assert.deepEqual(treeGit('log', '--format=%s', '-7').trim().split('\n'), [...REQUIREMENTS_STAGES].reverse().map((stage) => `${stage}: ${planSetId}`));
  assert.match(treeGit('status', '--short', '--untracked-files=all'), /\?\? docs\/domain\/stakeholders\/SH-01\.md/, 'the runner never commits the project-owned card');

  // A fixed document changes only on an explicit user revision, which reopens requirements-fix and no other requirements stage.
  const revision = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'requirements-fix', '--feedback', '삭제는 작성자만 한다고 바꿔 줘', '--user-revision', 'true']);
  assert.equal(revision.input.skill, 'requirements-fix');
  assert.equal(revision.input.context.user_revision, true);
  const refused = spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--stage-id', 'subdomain-candidates', '--feedback', '다시', '--user-revision', 'true'], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /User revision requires feedback for requirements-fix, a tactical design stage, spec-me, to-ticket or implement-wrapper/);

  // Restart preserves the old state and returns to the checkpoint before bounded-context.
  const restartArgs = ['--stage-id', 'bounded-context', '--restart-requirements', 'true'];
  const dirty = spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), ...restartArgs], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /clean project worktree/);
  await rm(join(workspace, 'docs/domain/stakeholders/SH-01.md'));
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const beforeRestart = await readFile(statePath, 'utf8');
  const running = JSON.parse(beforeRestart);
  running.stages['spec-me'] = { status: 'running', execution_id: 'spec-me-running' };
  await writeFile(statePath, JSON.stringify(running));
  const active = spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), ...restartArgs], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(active.status, 0);
  assert.match(active.stderr, /cannot be verified stopped/);
  await writeFile(statePath, beforeRestart);
  await writeFile(join(workspace, 'app.txt'), 'unrelated committed change\n');
  treeGit('add', 'app.txt');
  treeGit('commit', '-qm', 'application change');
  const laterCommit = spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), ...restartArgs], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(laterCommit.status, 0);
  assert.match(laterCommit.stderr, /Unrelated or later commits/);
  assert.equal(await readFile(join(workspace, 'app.txt'), 'utf8'), 'unrelated committed change\n');
  treeGit('reset', '--hard', 'HEAD^');
  treeGit('commit', '--allow-empty', '-qm', `ubiquitous-language: ${planSetId}`);
  const legacyOrder = spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), ...restartArgs], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(legacyOrder.status, 0);
  assert.match(legacyOrder.stderr, /earlier stage order/);
  treeGit('reset', '--hard', 'HEAD^');
  const restart = invoke(workspace, 'harness-prepare-input.mjs', restartArgs);
  assert.equal(restart.previous_stage, 'subdomain-classification');
  assert.ok(existsSync(join(restart.backup, 'state.json')));
  const restored = await readFile(join(workspace, requirements), 'utf8');
  assert.match(restored, /confirmed/);
  const state = JSON.parse(await readFile(join(workspace, '.io/runtime/orchestrator/state.json'), 'utf8'));
  assert.equal(state.current_stage, 'subdomain-classification');
  assert.equal(state.stages['bounded-context'], undefined);
  assert.equal(state.stages['requirements-fix'], undefined);
  assert.equal(state.stages['ubiquitous-language'].status, 'completed', 'earlier vocabulary is retained');
  const fresh = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'bounded-context']);
  assert.equal(fresh.input.context.transition.from_stage, 'subdomain-classification');
});

test('a skipped stakeholder-analysis makes the later requirements stages record the skip without writing, and spec-me follows the tactical stages', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, treeGit, invoke, runStage, planSetId, specPath } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  const skipped = await runStage('stakeholder-analysis', {
    files: { [analysis]: `# Stakeholder 분석\n\n- 판정: 생략\n- 근거: 기존 승인 Spec의 업무 하나 안의 변경\n` },
    artifacts: [{ path: analysis, kind: 'stakeholder_analysis' }],
    summary: '생략 판정',
  });
  assert.deepEqual(skipped.files, [analysis]);
  const head = treeGit('rev-parse', 'HEAD').trim();
  for (const stage of REQUIREMENTS_STAGES.slice(1)) {
    const result = await runStage(stage, { summary: `생략: stakeholder-analysis 판정 생략 (${analysis})`, expectCommit: false });
    assert.equal(result.finished.result.artifacts.length, 0, `${stage} wrote nothing`);
  }
  assert.equal(treeGit('rev-parse', 'HEAD').trim(), head);
  assert.equal(existsSync(join(workspace, `docs/specs/${planSetId}/requirements.md`)), false, 'a skipped analysis leaves no requirements.md');
  const premature = spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--stage-id', 'spec-me'], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(premature.status, 0);
  assert.match(premature.stderr, /spec-me cannot start before domain-model/);
  for (const stage of TACTICAL_DESIGN_STAGES) await runStage(stage, { summary: `생략: stakeholder-analysis 판정 생략 (${analysis})`, expectCommit: false });
  const next = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'spec-me']);
  assert.equal(next.input.context.transition.from_stage, 'integration-design');
});

// The event diagrams are rendered by the installed local renderer. The examples in the reference are rendered here, so a
// broken example or renderer fails the suite; the render itself needs Java, Graphviz and the cached pinned PlantUML jar.
const JAR = join(process.env.XDG_CACHE_HOME || join(process.env.HOME || '', '.cache'), 'harness-codex/plantuml/plantuml-1.2024.7.jar');
const toolsAvailable = ['java', 'dot'].every((command) => spawnSync(command, command === 'java' ? ['-version'] : ['-V'], { stdio: 'ignore' }).status === 0) && existsSync(JAR);

test('the event diagram examples render to SVG and a broken diagram fails the renderer', { skip: toolsAvailable ? false : 'Java, Graphviz or the cached PlantUML jar is unavailable' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'event-diagrams-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reference = await read('.codex/internal-skills/event-storming/references/diagrams.md');
  const examples = fenced(reference, 'plantuml');
  assert.equal(examples.length, 2, 'one per-subdomain and one cross-subdomain example');
  const renderer = join(sourceRoot, '.codex/tools/plantuml-render.mjs');
  const render = (file) => spawnSync(process.execPath, [renderer, '--workspace', directory, '--jar', JAR, file], { encoding: 'utf8' });
  for (const [index, source] of examples.entries()) {
    const name = index === 0 ? 'SD-01.events' : 'cross-subdomain.events';
    await writeFile(join(directory, `${name}.puml`), `${source}\n`);
    const result = render(join(directory, `${name}.puml`));
    assert.equal(result.status, 0, result.stderr);
    const svg = await readFile(join(directory, `${name}.svg`), 'utf8');
    assert.match(svg, /<svg[\s>]/);
    assert.match(svg, /harness-source-sha256: [0-9a-f]{64}/, 'the renderer stamps the source hash');
  }
  // A syntax error exits non-zero, so the stage cannot treat its picture as a successful render.
  await writeFile(join(directory, 'broken.events.puml'), '@startuml\n|회원|\nstart\n:명령\n@enduml\n');
  const broken = render(join(directory, 'broken.events.puml'));
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /render failed/);
});
