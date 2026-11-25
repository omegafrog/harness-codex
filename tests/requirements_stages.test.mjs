import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { WORKTREE_STAGE, REQUIREMENTS_STAGES, TACTICAL_DESIGN_STAGES } from '../.harness/src/workflow/worktree-stages.mjs';
import { MODELS, SETUP, STAGE_TIERS, consumerWorkflow, gitIn, sourceRoot, stakeholderAnalysisDocument } from './support/consumer-workflow.mjs';
import { withDecisionContext } from './support/decision-question.mjs';
import { codexUserPrompt } from './support/codex-user-prompt.mjs';

const TEMPLATE = '.harness/internal-skills/requirements-fix/references/template.md';
const read = (path) => readFile(join(sourceRoot, path), 'utf8');
const fenced = (text, language) => [...text.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```', 'g'))].map((match) => match[1]);

test('the requirements.md template, the stage guides and the orchestrator agree on the flow and the shape', async () => {
  // The orchestrator entry links the map, which owns the detailed stage order.
  assert.deepEqual(REQUIREMENTS_STAGES, ['stakeholder-analysis', 'subdomain-candidates', 'ubiquitous-language', 'event-storming', 'subdomain-classification', 'requirements-fix', 'bounded-context']);
  for (const stage of REQUIREMENTS_STAGES) assert.ok(Object.values(WORKTREE_STAGE).includes(stage), `${stage} is a worktree stage`);
  const orchestrator = await read('.codex/skills/orchestrator/SKILL.md');
  assert.doesNotMatch(orchestrator, /\]\(references\//);
  assert.match(await read('.codex/skills/orchestrator/references/dispatch.md'), /업무 묶음·서브도메인 분류는 `subdomain-classification`/);
  assert.doesNotMatch(orchestrator, /먼저 `bounded-context`부터 `--restart-requirements true`/);
  const map = await read('.codex/skills/orchestrator/references/workflow-map.md');
  assert.ok(map.includes(REQUIREMENTS_STAGES.map((stage) => `\`${stage}\``).join(' → ')), 'the workflow map names the flow in order');
  assert.match(map, /launch --stage-id domain-model --requirements-approved true --approval-answer/);
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
  assert.match(biz, /\| 순서 \| 행위자 \| 명령 \| 이벤트 ID \| 도메인 이벤트 \| 정책 ID \| 정책 \| 전이 ID \| 상태 전이 \| 공통 ID \| 외부 시스템 \| 근거 \|/);
  for (const source of ['요청 원문', 'CAND-xx 채택', 'answers.json', '요청 해석(에이전트 제안)']) assert.ok(template.includes(source), `source: ${source}`);
  for (const heading of ['6.1 범위·비목표', '6.2 우선순위·트레이드오프', '6.3 업무 상태·전이', '6.4 E2E 시나리오']) assert.ok(document.includes(heading), heading);
  assert.match(document, /\(answers\.json\)/, 'a user-decided term row ends with (answers.json)');
  assert.match(document, /\]\(diagrams\/events\/<name>\.puml\)/, 'the template links both the .puml and the .svg');
  assert.match(document, /\]\(diagrams\/events\/<name>\.svg\)/);

  // The persona record keeps only the persona record; the requirements it settles live in requirements.md.
  const analysis = await read('.harness/internal-skills/stakeholder-analysis/references/output-template.md');
  assert.doesNotMatch(analysis, /요구사항 초안\n|## 7\./);
  assert.match(analysis, /## 4\. 후보 요구사항/);
  assert.match(analysis, /## 5\. 충돌/);
  assert.match(analysis, /요청 범위 밖 관찰/);
  assert.match(await read('.harness/internal-skills/stakeholder-analysis/GUIDE.md'), /create `requirements\.md`/);

  // Each stage guide links the template, keeps its own boundary and returns through the common contract.
  for (const stage of REQUIREMENTS_STAGES.slice(1)) {
    const guide = await read(`.harness/internal-skills/${stage}/GUIDE.md`);
    assert.match(guide, /^---\nmodel_tier: (implementation|high_performance)\n---/, stage);
    assert.match(guide, /requirements-fix\/references\/template\.md|\(references\/template\.md\)/, `${stage} links the template`);
    assert.match(guide, /`판정: 생략`/, `${stage} records a skip`);
    assert.match(guide, /context\.workspace\.preflight/, `${stage} uses the runner's workspace check`);
    assert.match(guide, /context\.workspace\.documents/, `${stage} uses the paths the runner gives`);
    assert.doesNotMatch(guide, /harness-spec-path|harness-workspace-preflight/, `${stage} does not look them up again`);
    assert.match(guide, /The runner commits `docs\/specs\/<plan-set-id>\/`/, `${stage} says what the runner commits`);
  }
  assert.match(await read('.harness/internal-skills/ubiquitous-language/GUIDE.md'), /`docs\/specs\/<plan-set-id>\/` and `CONTEXT\.md`/);
  assert.match(await read('.harness/internal-skills/ubiquitous-language/GUIDE.md'), /provisional BIZ scope/);
  const classification = await read('.harness/internal-skills/subdomain-classification/GUIDE.md');
  assert.match(classification, /`core`[\s\S]*`generic`[\s\S]*`supporting`/);
  assert.match(classification, /한 묶음의 한국어 질문/);
  assert.match(classification, /현재 후보를 유지하도록 권장해도 사용자의 경계 승인을 받는다/);
  assert.match(classification, /A render failure blocks completion/);
  const context = await read('.harness/internal-skills/bounded-context/GUIDE.md');
  assert.match(context, /\[ddd-design\]\(\.\.\/ddd-design\/GUIDE\.md\)/, 'the boundary rule is linked, not copied');
  assert.match(context, /\[model-continuity\]\(\.\.\/ddd-design\/references\/model-continuity\.md\)/);
  assert.match(context, /`accepted-target`/);
  assert.match(context, /`CONTEXT-MAP\.md` and `CONTEXT\.md` when this stage completes/);
  assert.match(context, /Assign provisional BIZ-scoped glossary entries/);
  assert.match(context, /material meaning conflict/);
  const dispatch = await read('.codex/skills/orchestrator/references/dispatch.md');
  assert.match(dispatch, /fork_turns: "none"/);
  assert.match(dispatch, /부모 이력이나 산출물 본문을 붙여 넣지 않는다/);
  const languageGuide = await read('.harness/internal-skills/ubiquitous-language/GUIDE.md');
  assert.match(languageGuide, /after `subdomain-candidates` and before `event-storming`/);
  assert.match(languageGuide, /Do not rewrite every sentence/);
  assert.match(languageGuide, /not bounded contexts/);
  assert.match(await read('.harness/internal-skills/event-storming/GUIDE.md'), /Use settled terms in events and diagrams/);
  assert.match(await read('.harness/internal-skills/event-storming/GUIDE.md'), /settled `## 3` term table/);
  assert.match(context, /upstream, downstream, each context's responsibility, the communication contract[^`]*and the `판단 소유자`/);
  assert.match(context, /write `미정` with the reason when the evidence does not say/);
  assert.match(context, /has no `판단 소유자` column gets the column added/);
  // The map template every new project gets carries the decision owner next to the contract, and the guide's wording matches it.
  assert.match(await read('.codex/skills/setup/assets/CONTEXT-MAP.md'), /^\| Upstream \| Downstream \| Upstream 책임 \| Downstream 책임 \| 통신 계약 \| 판단 소유자 \| 상태·근거 \|\n\|---\|---\|---\|---\|---\|---\|---\|$/m);
  assert.match(context, /mark unspecified details as undecided/);
  assert.match(context, /pattern only when supported by evidence/);
  // The user sees which stakeholder each candidate question came from, by role and participant ID.
  const analysisGuide = await read('.harness/internal-skills/stakeholder-analysis/GUIDE.md');
  assert.match(analysisGuide, /Start each question title with the stakeholders it came from, each by the role and ID of the participant table/);
  assert.match(analysisGuide, /`\[제안: 도메인 전문가\(LENS-DOMAIN\), 결제 담당자\(SH-01\)\]`/);
  const events = await read('.harness/internal-skills/event-storming/GUIDE.md');
  assert.match(events, /`mode: events`/);
  assert.match(events, /`stakeholder_persona`/);
  assert.match(events, /A render failure blocks completion/);
  assert.match(await read('.harness/internal-skills/stakeholder-persona/GUIDE.md'), /^## Events mode$/m);
  // requirements-fix completes the requirements before the boundaries; bounded-context, the last stage, fixes the document.
  const fix = await read('.harness/internal-skills/requirements-fix/GUIDE.md');
  assert.match(fix, /after `subdomain-classification` and before `bounded-context`/);
  assert.match(fix, /The document stays `draft`/);
  assert.match(context, /^Last step of the requirements flow, after `requirements-fix`/m);
  assert.match(context, /set its `상태` to `fixed` automatically/);
  assert.match(context, /`result\.owner_stage: requirements-fix`/);
  const coverage = await read('.harness/internal-skills/requirements-fix/references/coverage.md');
  assert.match(coverage, /확정 조건/);
  assert.doesNotMatch(`${fix}\n${coverage}`, /product-spec\/GUIDE\.md|grill-with-docs|how-to-grill/);

  // The Product guide and the DDD guide treat requirements.md as a fixed input.
  assert.match(await read('.harness/internal-skills/product-spec/GUIDE.md'), /`상태: fixed`[\s\S]*requirements\.md BIZ-xx/);
  assert.match(await read('.harness/internal-skills/ddd-design/GUIDE.md'), /requirements\.md` when present/);
  assert.match(await read('.harness/internal-skills/ddd-design/GUIDE.md'), /do not compare the boundaries again/);
});

// Attempt 008: a feedback recovery of event-storming spawned a persona and interrupted it 2.6 seconds later. The tables from
// the first run already held the persona output, so the guides must say when a resumed run spawns none.
test('a feedback or recovery run reuses the recorded persona output and the guides name the markers the runner writes for it', async () => {
  const input = await read('.harness/src/workflow/stage-input.mjs');
  assert.ok(input.includes('previous_result_ref') && input.includes("kind: 'previous_execution_result'"), 'the runner writes both resume markers');
  const analysis = await read('.harness/internal-skills/stakeholder-analysis/GUIDE.md');
  const events = await read('.harness/internal-skills/event-storming/GUIDE.md');
  for (const guide of [analysis, events]) {
    assert.match(guide, /`context\.previous_result_ref`/);
    assert.match(guide, /`kind: previous_execution_result`/);
  }
  assert.match(analysis, /A `--feedback`, recovery or takeover run \(the input has[^)]*\) whose `stakeholder-analysis\.md` holds a candidate table spawns no persona: those rows are their output, so reuse them and the prior result's refs\./);
  assert.match(analysis, /Spawn only a selected persona that has no recorded candidates, or round 2 for a `CONF` the new input opens\./);
  assert.match(events, /`--feedback`·복구·인계로 재개한 실행\(입력에[^)]*\)은 `requirements\.md`의 BIZ마다 `이벤트 흐름` 표나 `이벤트 없음 — 이유`가 있고 `## 5` hotspot 목록이 있으면 그 표가 persona 결과다\./);
  assert.match(events, /4·5단계를 건너뛰고 기록된 표와 이전 결과의 refs를 재사용하며 persona를 시작하지 않는다\./);
  assert.match(events, /표가 없는 BIZ가 남았을 때만 그 BIZ의 skeleton만 보내 4단계를 실행한다\./);
  assert.match(events, /Rerunning the persona after the user answered or on a feedback\/recovery run that finds the event tables recorded/);
  // Only these two guides start personas; the other requirements stages say that none runs.
  for (const stage of ['subdomain-candidates', 'ubiquitous-language', 'subdomain-classification', 'bounded-context']) assert.match(await read(`.harness/internal-skills/${stage}/GUIDE.md`), /No persona runs/, stage);
});

test('the requester is a stakeholder: requested features are settled, and a persona candidate anchored in the request is never dropped as out of scope', async () => {
  const { checkStakeholderAnalysis } = await import('../.harness/src/workflow/stakeholder-analysis-gate.mjs');
  const request = '$orchestrator 계산기 웹 앱 만들어. 유저 인증과 커뮤니티 기능 있어야 해.';
  const participants = '| ID | 구분 | 역할 | 실행 | 선택 근거 |\n|---|---|---|---|---|\n| REQUESTER | 요청자 | 요청자 | 요청 원문 | 요청 기능 |\n| LENS-DOMAIN | 전문가 관점 | 도메인 전문가 | 실행 | 기본 관점 |\n';
  const features = (decision = '확정', phrase = '커뮤니티 기능') => `| 요청 기능 | 요청 문구 | 제안자 | 결정 | 출처 | 내용 질문 |\n|---|---|---|---|---|---|\n| 커뮤니티 | "${phrase}" | REQUESTER | ${decision} | 요청 원문 | q:4 |\n`;
  const observation = (anchor) => `| 제안자 | 관찰 | 요청 앵커 | 근거 |\n|---|---|---|---|\n| LENS-DOMAIN | 게시물 작성자만 수정한다 | "${anchor}" | 근거 |\n`;
  const openFacts = '\n### 미확정 사실\n\n| ID | 구분 | 사실 | 바뀌는 동작 | 처리 | 근거 |\n|---|---|---|---|---|---|\n| OPEN-01 | 이용 조건 | 이용 주체 | 권한 | 확정 | 요청 원문 "유저 인증" |\n';
  const codes = (analysis) => checkStakeholderAnalysis({ request, analysis: analysis + openFacts }).errors.map(({ code }) => code);
  assert.deepEqual(codes(`# 분석\n\n${participants}\n${features()}\n${observation('결제 기능')}`), [], 'an observation anchored outside the request is kept out of scope');
  assert.deepEqual(codes(`# 분석\n\n${participants}\n${features()}\n${observation('유저 인증과 커뮤니티 기능')}`), ['ANCHORED_CANDIDATE_EXCLUDED'], 'the E2E defect: an anchored community candidate was moved out of scope');
  assert.deepEqual(codes(`# 분석\n\n${features()}`), ['REQUESTER_MISSING']);
  assert.deepEqual(codes(`# 분석\n\n${participants}`), ['REQUESTED_FEATURES_MISSING']);
  assert.deepEqual(codes(`# 분석\n\n${participants}\n${features('대기')}`), ['REQUESTED_FEATURE_ASKED'], 'a requested feature is never asked for adoption');
  assert.deepEqual(codes(`# 분석\n\n${participants}\n${features('확정', '게시판 기능')}`), ['REQUESTED_FEATURE_NOT_QUOTED']);
  assert.deepEqual(codes(`# 분석\n\n${participants}\n${features()}\n| 제안자 | 관찰 | 근거 |\n|---|---|---|\n| LENS-DOMAIN | 관찰 | 근거 |\n`), ['OBSERVATION_ANCHOR_MISSING']);
  assert.ok(checkStakeholderAnalysis({ request, analysis: '# 분석\n\n- 판정: 생략\n' }).ok, 'a skipped analysis is not checked');

  // The guides carry the same rules: subdomain-candidates never asks about a requested feature and rewinds instead.
  const candidates = await read('.harness/internal-skills/subdomain-candidates/GUIDE.md');
  assert.match(candidates, /다른 활동의 규칙·예외·정책·상태 전이에 묻힌 동작도 확인한다/);
  assert.match(candidates, /`result\.owner_stage: stakeholder-analysis`/);
  const analysisGuide = await read('.harness/internal-skills/stakeholder-analysis/GUIDE.md');
  assert.match(analysisGuide, /This is the only reason a candidate leaves the candidate table/);
  assert.match(analysisGuide, /`\[제안: 요청자\(REQUESTER\) · 요청 기능: <기능>\]`/);
});

test('a BIZ field is written once: a second field of the same name is rejected, placeholders filled in place pass', async () => {
  const { checkRequirementsDocument } = await import('../.harness/src/workflow/requirements-document-gate.mjs');
  const biz = (extra = '') => `### BIZ-03 로그인 (SD-02)\n\n- 상태: draft\n- 업무 규칙: 없음 — 후속 stage가 채운다\n- 예외 시나리오:\n  - EX-02 로그인 실패를 알린다 — 출처: answers.json \`q:3\`\n- 이벤트 흐름:\n\n  | 순서 | 행위자 |\n  |---|---|\n  | 1 | 사용자 |\n${extra}- 출처·변경 이력:\n  - event-storming: 반영\n`;
  const other = '### BIZ-04 게시글 읽기 (SD-03)\n\n- 업무 규칙: 없음 — 후속 stage가 채운다\n- 예외 시나리오: 없음 — 후속 stage가 채운다\n\n## 4. 서브도메인 간 이벤트\n\n- 예외 시나리오: 문서 공통 절의 같은 이름은 BIZ 밖이다\n';
  const ok = checkRequirementsDocument({ requirements: `# 요구사항 명세\n\n${biz()}\n${other}`, stage: 'event-storming' });
  assert.deepEqual(ok.errors, [], 'the same field in different BIZ sections, or outside a BIZ, is not a duplicate');
  // The E2E defect: event-storming appended a second 업무 규칙 and 예외 시나리오 to BIZ-03 instead of filling them in place.
  const appended = biz('- 업무 규칙:\n  - INV-01 규칙 — 출처: answers.json `q:1`\n- 예외 시나리오:\n  - EX-02 로그인 실패를 알린다\n');
  const failed = checkRequirementsDocument({ requirements: `# 요구사항 명세\n\n${appended}\n${other}`, stage: 'event-storming' });
  assert.deepEqual(failed.errors.map(({ code, id, owner_stage }) => [code, id, owner_stage]), [['DUPLICATE_FIELD', 'BIZ-03', 'event-storming'], ['DUPLICATE_FIELD', 'BIZ-03', 'event-storming']]);
  assert.match(failed.errors[0].message, /업무 규칙" 2 times/);
  assert.match(failed.errors[0].message, /@@ ### BIZ-03/);
  const fixed = `## 2. 업무\n\n${biz('- 완료 조건:\n  - AC-01 세션이 생성된다\n').replace('없음 — 후속 stage가 채운다', 'INV-03 이메일은 계정당 하나다')}`;
  const complete = (requirements) => checkRequirementsDocument({ requirements, stage: 'requirements-fix', complete: true });
  assert.equal(complete(fixed).ok, true);
  assert.deepEqual(complete(fixed.replace('INV-03 이메일은 계정당 하나다', '없음 — 후속 stage가 채운다')).errors.map(({ code }) => code), ['BIZ_REQUIREMENT_INCOMPLETE']);
  assert.equal(complete(fixed.replace('AC-01 세션이 생성된다', 'AC-01 TODO')).ok, false);
  assert.match(await read(TEMPLATE), /같은 이름의 필드를 BIZ 끝에 새로 덧붙이지 않는다/);
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
    ...REQUIREMENTS_STAGES.slice(1).map((name) => `.harness/internal-skills/${name}/GUIDE.md`),
    '.harness/src/workflow/output-schema.mjs',
    '.harness/src/workflow/questions.mjs',
    '.harness/src/workflow/stage-input.mjs',
    '.harness/scripts/harness-result.mjs',
    '.harness/src/workflow/requirements-restart.mjs',
    '.harness/src/workflow/worktree-stages.mjs',
    '.harness/src/workflow/stage-commit.mjs',
    '.harness/src/workflow/stakeholder-analysis-gate.mjs',
    '.harness/src/workflow/requirements-document-gate.mjs',
    '.harness/internal-skills/stakeholder-analysis/GUIDE.md',
    '.harness/internal-skills/stakeholder-analysis/references/output-template.md',
    '.harness/scripts/harness-fresh-agent.mjs',
    '.harness/scripts/harness-setup.mjs',
    TEMPLATE,
    '.harness/internal-skills/requirements-fix/references/coverage.md',
    '.harness/internal-skills/event-storming/references/diagrams.md',
    '.harness/internal-skills/stakeholder-persona/GUIDE.md',
    '.harness/tools/plantuml-bootstrap.mjs',
    '.harness/tools/plantuml-render.mjs',
  ];
  const lock = JSON.parse(await readFile(join(root, '.harness/harness-lock.json'), 'utf8'));
  for (const path of managed) {
    assert.ok(existsSync(join(root, path)), `installed: ${path}`);
    assert.ok(lock.files[path], `lock inventory: ${path}`);
    assert.match(git('check-ignore', '-v', path), /info\/exclude/, `ignored: ${path}`);
    assert.equal(await readFile(join(root, path), 'utf8'), await read(path), `same content: ${path}`);
  }
  // The stage coordination references travel with the orchestrator skill (path rewritten for the provider copy).
  for (const name of ['coordination', 'dispatch', 'input', 'workflow-map']) {
    const path = `.codex/skills/orchestrator/references/${name}.md`;
    assert.ok(lock.files[path], `lock inventory: ${path}`);
    assert.equal(lock.files[path].source_path, `.codex/skills/orchestrator/references/${name}.md`);
    assert.match(git('check-ignore', '-v', path), /info\/exclude/, `ignored: ${path}`);
  }
  const setupMap = '.codex/skills/setup/assets/CONTEXT-MAP.md';
  assert.ok(lock.files[setupMap]);
  assert.equal(await readFile(join(root, setupMap), 'utf8'), await read('.codex/skills/setup/assets/CONTEXT-MAP.md'));
  assert.match(git('check-ignore', '-v', setupMap), /info\/exclude/);
  const hook = join(root, '.harness/scripts/harness-fresh-agent.mjs');
  const hookEvent = (fork_turns) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'collaborationspawn_agent', tool_input: { agent_type: 'workflow_stage', fork_turns } });
  const denied = spawnSync(process.execPath, [hook], { input: hookEvent('all'), encoding: 'utf8' });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(spawnSync(process.execPath, [hook], { input: hookEvent('none'), encoding: 'utf8' }).stdout, '');

  // The tiers resolve from the installed documents, and the installed commit wiring is the source wiring.
  const binding = (skill) => JSON.parse(execFileSync(process.execPath, [join(root, '.harness/scripts/harness-stage-runtime.mjs'), 'binding', '--root', root, '--skill', skill], { cwd: root, encoding: 'utf8' }));
  for (const [stage, tier] of Object.entries(STAGE_TIERS)) assert.deepEqual(binding(stage), { skill: stage, provider: 'codex', model_tier: tier, model: MODELS[tier], reasoning_effort: tier === 'high_performance' ? 'high' : tier === 'low_performance' ? 'minimal' : 'medium' }, stage);
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
  const renderer = join(root, '.harness/tools/plantuml-render.mjs');
  const coverage = join(root, '.harness/internal-skills/requirements-fix/references/coverage.md');
  const schemaModule = join(root, '.harness/src/workflow/output-schema.mjs');
  const contextGuide = join(root, '.harness/internal-skills/bounded-context/GUIDE.md');
  const restartModule = join(root, '.harness/src/workflow/requirements-restart.mjs');
  const inputGuide = join(root, '.codex/skills/orchestrator/references/input.md');
  const dispatchGuide = join(root, '.codex/skills/orchestrator/references/dispatch.md');
  const freshHook = join(root, '.harness/scripts/harness-fresh-agent.mjs');
  await unlink(template);
  await unlink(renderer);
  await unlink(schemaModule);
  await writeFile(coverage, 'locally edited coverage\n');
  await writeFile(contextGuide, 'outdated guide\n');
  await unlink(restartModule);
  await unlink(dispatchGuide);
  await unlink(inputGuide);
  await unlink(freshHook);
  doctor = await runDoctor({ root, sourceRoot });
  for (const path of [template, renderer, restartModule, dispatchGuide, inputGuide, freshHook, schemaModule]) assert.ok(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path === path), `missing: ${path}`);
  await updateProject({ sourceRoot, targetRoot: root });
  for (const path of [TEMPLATE, '.harness/tools/plantuml-render.mjs', '.harness/internal-skills/requirements-fix/references/coverage.md', '.harness/internal-skills/bounded-context/GUIDE.md', '.harness/scripts/harness-fresh-agent.mjs', '.harness/src/workflow/requirements-restart.mjs', '.harness/src/workflow/output-schema.mjs']) assert.equal(await readFile(join(root, path), 'utf8'), await read(path), `restored: ${path}`);
  assert.match(await readFile(dispatchGuide, 'utf8'), /fork_turns: "none"/, 'update restores the orchestrator dispatch reference');
  assert.match(await readFile(inputGuide, 'utf8'), /"clarification"/, 'update restores the orchestrator answer protocol');
  for (const path of managed) assert.match(git('check-ignore', '-v', path), /info\/exclude/, `still ignored after update: ${path}`);
  assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  assert.equal(await readFile(join(root, 'docs/specs/community/requirements.md'), 'utf8'), '# 요구사항 명세\n');
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'ongoing application change\n');
  assert.equal(await readFile(join(root, 'CONTEXT-MAP.md'), 'utf8'), '# 소비자 소유 관계\n');
  const updatedStatus = git('status', '--short', '--untracked-files=all');
  assert.match(updatedStatus, /\?\? docs\/specs\/community\/requirements\.md/);
  assert.match(updatedStatus, /^ M app\.txt$/m);
  assert.doesNotMatch(updatedStatus, /\.codex\/|\.harness\/|\.claude\/|\.agents\/|\.io\//);
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

  const { writeDomainDocument } = await import(pathToFileURL(join(workspace, '.harness/src/domain/repository.mjs')));
  await writeDomainDocument(workspace, {
    metadata: { schema_version: 1, id: 'actor.author', kind: 'actor', name: '게시글 작성자', status: 'accepted-target',
      role: '게시글 작성자', authority: '게시글 삭제', scope: '본인 글', aliases: [], source_refs: ['CONTEXT.md'], references: ['SH-01'] },
    body: '# 게시글 작성자\n',
  });

  // 1. stakeholder-analysis creates both documents; the requirements draft only holds what the user settled.
  const first = await runStage('stakeholder-analysis', {
    files: { [analysis]: stakeholderAnalysisDocument(REQUEST), [requirements]: `# 요구사항 명세\n\n- 상태: draft\n\n## 2. 업무\n\n### 요구사항 초안\n\n- 업무 목적: 게시글 삭제 (요청 원문: "게시글 삭제 기능")\n` },
    artifacts: [artifact(analysis, 'stakeholder_analysis'), artifact(requirements, 'requirements')],
    summary: 'CAND 1건 채택',
  });
  assert.deepEqual(first.files, [analysis, requirements].sort());
  const packRef = first.prepared.input.input_refs.find(({ kind }) => kind === 'domain_context_pack');
  const pack = JSON.parse(await readFile(join(workspace, '.io', packRef.path), 'utf8'));
  assert.ok(pack.candidates.some(({ id }) => id === 'actor.author'));
  assert.match(treeGit('check-ignore', '-v', `.io/${packRef.path}`), /info\/exclude/);
  assert.match(treeGit('status', '--short', '--untracked-files=all'), /docs\/domain\/actors\/actor\.author\.md/);


  // 2. subdomain-candidates receives the previous stage's documents and only rewrites requirements.md.
  const second = await runStage('subdomain-candidates', {
    files: { [requirements]: '# 요구사항 명세\n\n- 상태: draft\n\n## 1. 서브도메인 후보\n\n| SD | 이름 | 업무 범위 | 포함 업무 | 핵심 용어 후보 | 분리 이유(가설) | 상태 |\n|---|---|---|---|---|---|---|\n| SD-01 | 게시판 | 글 삭제 | BIZ-01 | 게시글 | 기존 영역 확장: 커뮤니티 | draft |\n\n## 2. 업무\n\n### BIZ-01 게시글 삭제 (SD-01)\n' },
    artifacts: [artifact(requirements, 'requirements')],
  });
  assert.equal(second.prepared.input.context.transition.from_stage, 'stakeholder-analysis');
  // Earlier stages' canonical results reach the worker as refs, so it never searches .io for them.
  assert.deepEqual(second.prepared.input.context.upstream, [{ stage_id: 'stakeholder-analysis', execution_id: first.prepared.input.execution_id, result_ref: first.finished.result_ref }]);
  assert.ok(second.prepared.input.input_refs.some((reference) => reference.path === requirements && reference.kind === 'requirements'));
  assert.deepEqual(second.files, [requirements]);
  const secondPackRef = second.prepared.input.input_refs.find(({ kind }) => kind === 'domain_context_pack');
  const secondPack = JSON.parse(await readFile(join(workspace, '.io', secondPackRef.path), 'utf8'));
  assert.ok(!secondPack.candidates.some(({ kind }) => kind === 'actor'));


  // 3. ubiquitous-language commits the plan set documents and the project glossary in one commit.
  const language = await runStage('ubiquitous-language', {
    files: { [requirements]: '# 요구사항 명세\n\n- 상태: draft\n\n## 3. 용어\n\n| 용어 | 뜻 | 쓰지 않을 말 |\n|---|---|---|\n| 게시글 | 회원이 올린 글 하나 (answers.json) | 포스트 |\n', 'CONTEXT.md': '# 프로젝트 컨텍스트\n\n| Canonical Term | Korean |\n|---|---|\n| Post | 게시글 |\n' },
    artifacts: [artifact(requirements, 'requirements'), artifact('CONTEXT.md', 'glossary')],
  });
  assert.deepEqual(language.files, ['CONTEXT.md', requirements]);
  assert.deepEqual(language.prepared.input.context.upstream.map(({ stage_id, result_ref }) => [stage_id, result_ref]), [['stakeholder-analysis', first.finished.result_ref], ['subdomain-candidates', second.finished.result_ref]]);

  // 4. event-storming preserves the confirmed decision while the user asks for clarification about the other hotspot.
  const eventFiles = { [`${specDirectory}/diagrams/events/SD-01.events.puml`]: '@startuml\n@enduml\n', [`${specDirectory}/diagrams/events/SD-01.events.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"/>\n', [`${specDirectory}/diagrams/events/cross-subdomain.events.puml`]: '@startuml\n@enduml\n', [`${specDirectory}/diagrams/events/cross-subdomain.events.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"/>\n' };
  const recoveryQuestion = withDecisionContext({ question_id: 'hotspot-2', title: '[BIZ-01] HS-02 삭제한 게시글을 복구할 수 있나요?', options: [{ id: 'no', label: '복구할 수 없다', consequence: '삭제는 되돌릴 수 없다', evidence: [] }, { id: 'yes', label: '복구할 수 있다', consequence: '삭제 상태를 보관한다', evidence: [] }], recommended_option_id: 'no', rationale: '요청은 삭제만 말한다', decision_kind: null });
  const authorQuestion = withDecisionContext({ question_id: 'hotspot-1', title: '[BIZ-01] HS-01 게시글의 삭제 권한은 누구에게 있나요?', options: [{ id: 'author', label: '작성자만 삭제', consequence: '다른 회원은 삭제할 수 없다', evidence: [] }, { id: 'member', label: '모든 회원이 삭제', consequence: '작성자 이외의 회원도 삭제할 수 있다', evidence: [] }], recommended_option_id: 'author', rationale: '작성자가 자신의 게시글을 지운다', decision_kind: null });
  const eventDraft = '# 요구사항 명세\n\n- 상태: draft\n\n## 5. hotspot\n\n| HS | 질문 | 관련 BIZ | 상태 | 결정 | 출처 |\n|---|---|---|---|---|---|\n| HS-01 | 게시글의 삭제 권한 | BIZ-01 | 대기 | | |\n| HS-02 | 삭제한 글을 복구할 수 있는가 | BIZ-01 | 대기 | | |\n';
  const waiting = await runStage('event-storming', {
    files: { [requirements]: eventDraft },
    status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: 'hotspot 2건 질문', artifacts: [artifact(requirements, 'requirements')], questions: [authorQuestion, recoveryQuestion], expectCommit: false,
  });
  assert.equal(waiting.prepared.input.context.transition.from_stage, 'ubiquitous-language');
  assert.ok(waiting.prepared.input.input_refs.some((reference) => reference.path === 'CONTEXT.md'), 'event-storming receives the early glossary');
  const [authorId, recoveryId] = waiting.finished.result.questions.map(({ question_id }) => question_id);
  const confirmed = { question_id: authorId, answer: 'author' };
  const clarification = { question_id: recoveryId, clarification: '댓글이 달린 글도 같은 방식으로 처리하나요?' };
  const mixed = invoke(workspace, 'harness-native-stage.mjs', ['launch', '--stage-id', 'event-storming', '--answer', JSON.stringify([confirmed, clarification])]);
  assert.equal(mixed.waiting_for_answers, true);
  assert.equal(mixed.execution_id, undefined, 'clarification leaves the existing stage waiting');
  assert.equal(mixed.answered, 1);
  assert.deepEqual(mixed.questions.map(({ question_id }) => question_id), [recoveryId]);
  assert.deepEqual(mixed.clarifications, [clarification]);
  assert.match(mixed.next, /Address the user’s clarifications in chat/);
  const waitingDirectory = dirname(waiting.started.output_path);
  assert.equal(existsSync(join(waitingDirectory, 'decision-answers.json')), false);
  assert.equal(await readFile(join(workspace, requirements), 'utf8'), eventDraft);

  const recovery = { question_id: recoveryId, answer: '댓글이 달린 글도 삭제한 뒤 복구할 수 없게 한다.' };
  const resumed = await runStage('event-storming', {
    extraArgs: ['--answer', JSON.stringify([recovery])],
    files: { [requirements]: '# 요구사항 명세\n\n- 상태: draft\n\n## 4. 서브도메인 간 이벤트\n\n## 5. hotspot\n\n| HS | 질문 | 관련 BIZ | 상태 | 결정 | 출처 |\n|---|---|---|---|---|---|\n| HS-01 | 게시글의 삭제 권한 | BIZ-01 | 해결 | 작성자만 삭제 → INV-01 | answers.json |\n| HS-02 | 삭제한 글을 복구할 수 있는가 | BIZ-01 | 해결 | 복구할 수 없다 → EX-01 | answers.json |\n', [analysis]: `# Stakeholder 분석\n\n> ${REQUEST}\n\n요청 범위 밖 관찰: LENS-DOMAIN (event-storming)\n`, ...eventFiles },
    artifacts: [artifact(requirements, 'requirements'), artifact(analysis, 'stakeholder_analysis'), artifact(`${specDirectory}/diagrams/events`, 'event_diagrams')],
  });
  assert.deepEqual(resumed.files, [analysis, requirements, ...Object.keys(eventFiles).sort()].sort());
  const resumedResult = JSON.parse(await readFile(join(workspace, '.io', resumed.finished.result_ref), 'utf8'));
  assert.equal(resumedResult.artifacts.find(({ kind }) => kind === 'event_diagrams').sha256, null);
  assert.ok(resumed.prepared.input.input_refs.some((reference) => reference.kind === 'previous_execution_result'), 'the resumed stage reads its previous result');
  const answers = JSON.parse(await readFile(join(dirname(resumed.started.output_path), 'answers.json'), 'utf8'));
  assert.deepEqual(answers, [confirmed, recovery], 'only confirmed decisions reach the worker');
  assert.deepEqual(JSON.parse(await readFile(join(waitingDirectory, 'decision-answers.json'), 'utf8')), answers);

  // 5. subdomain-classification confirms the set and the classes with the user, then commits the plan set documents only.
  const classQuestion = withDecisionContext({ question_id: 'draft-classification', title: '[서브도메인 분류] SD-01 게시판의 분류는 무엇인가요?', options: [{ id: 'core', label: 'core', consequence: '이 요청의 차별점이다', evidence: [] }, { id: 'supporting', label: 'supporting', consequence: '필요하지만 차별되지 않는다', evidence: [] }], recommended_option_id: 'core', rationale: '글 삭제가 요청의 핵심이다', decision_kind: null });
  const boundaryQuestion = withDecisionContext({ question_id: 'draft-boundary', title: '[서브도메인 경계] SD-01 글 삭제를 게시판에 둘까요?', options: [{ id: 'keep', label: '게시판에 유지', consequence: '글 작성과 삭제를 같은 업무 영역이 소유한다', evidence: [] }, { id: 'split', label: '별도 운영 영역으로 분리', consequence: '삭제의 판단을 운영 영역이 소유한다', evidence: [] }], recommended_option_id: 'keep', rationale: '글의 소유권은 작성자에게 있다', decision_kind: null });
  const classifying = await runStage('subdomain-classification', {
    status: 'action_required', code: 'USER_DECISION_REQUIRED', summary: '경계와 분류 질문', questions: [boundaryQuestion, classQuestion], expectCommit: false,
  });
  const [boundary, classification] = classifying.finished.result.questions;
  // The confirmed answers of event-storming are recorded on the execution that asked them.
  const eventUpstream = classifying.prepared.input.context.upstream.find(({ stage_id }) => stage_id === 'event-storming');
  assert.deepEqual(eventUpstream, { stage_id: 'event-storming', execution_id: resumed.prepared.input.execution_id, result_ref: resumed.finished.result_ref, answers_refs: [`runtime/executions/${waiting.prepared.input.execution_id}/decision-answers.json`] });
  assert.deepEqual(JSON.parse(await readFile(join(workspace, '.io', eventUpstream.answers_refs[0]), 'utf8')), answers);
  assert.deepEqual([boundary.title, classification.title], [boundaryQuestion.title, classQuestion.title]);
  const answersArg = (question, answer) => ['--answer', JSON.stringify([{ question_id: question.question_id, answer }])];
  const waitingForBoundary = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'subdomain-classification', ...answersArg(classification, 'core')]);
  assert.ok(waitingForBoundary.waiting_for_answers);
  const classified = await runStage('subdomain-classification', {
    extraArgs: answersArg(boundary, 'keep'),
    files: { [requirements]: `# 요구사항 명세\n\n- 상태: draft\n\n## 1. 서브도메인 후보\n\n| SD | 이름 | 업무 범위 | 포함 업무 | 핵심 용어 후보 | 분리 이유(가설) | 분류 | 근거 | 상태 |\n|---|---|---|---|---|---|---|---|---|\n| SD-01 | 게시판 | 글 삭제 | BIZ-01 | 게시글 | 기존 영역 확장: 커뮤니티 | core | 요청의 핵심이다 — 출처: answers.json ${classification.question_id} | confirmed |\n\n- 경계: 게시판에 유지 — 출처: answers.json ${boundary.question_id}\n` },
    artifacts: [artifact(requirements, 'requirements')],
  });
  assert.deepEqual(classified.files, [requirements]);

  // 6. requirements-fix fills the open rows before the boundaries are decided; the document stays draft.
  const filled = await runStage('requirements-fix', {
    files: { [requirements]: '# 요구사항 명세\n\n- 상태: draft\n\n- INV-01 작성자가 글을 삭제한다.\n' },
    artifacts: [artifact(requirements, 'requirements')],
  });
  assert.deepEqual(filled.files, [requirements]);
  const directory = dirname(filled.started.output_path);
  const raw = JSON.parse(await readFile(filled.started.output_path, 'utf8'));
  const saved = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  const sha256 = createHash('sha256').update(await readFile(join(workspace, requirements))).digest('hex');
  assert.deepEqual(raw.result.artifacts, [{ base: 'workspace', path: requirements, kind: 'requirements' }]);
  assert.deepEqual(saved.artifacts, [{ ...raw.result.artifacts[0], sha256 }]);
  for (const path of ['output.json', 'return.schema.json', 'result.json']) assert.match(treeGit('check-ignore', '-v', `.io/runtime/executions/${filled.finished.execution_id}/${path}`), /info\/exclude/);

  // 7. bounded-context decides the contexts from the completed requirements, fixes the document automatically, syncs the
  // shared definitions it now owns and commits the plan set documents together with the project's context map.
  const fixing = await flow.beginStage('bounded-context');
  await flow.submitStage(fixing, {
    files: { 'CONTEXT.md': '# 프로젝트 컨텍스트\n\n| Post | 게시글 (커뮤니티) |\n', [requirements]: '# 요구사항 명세\n\n- 상태: fixed\n\n### 1.1 바운디드 컨텍스트\n\n| BC | 포함 SD·BIZ | 책임 | 소유 규칙·데이터 | 근거 | 비교한 대안 |\n|---|---|---|---|---|---|\n| 커뮤니티 | SD-01(BIZ-01) | 글 삭제 | INV-01 | 기존 컨텍스트 확장 | 분리 안 |\n\n- INV-01 작성자가 글을 삭제한다.\n- 이벤트 흐름:\n\n  | 순서 | 이벤트 ID | 도메인 이벤트 | 공통 ID |\n  |---|---|---|---|\n  | 1 | EVT-01 | 글이 삭제됨 | - |\n', 'CONTEXT-MAP.md': '# 컨텍스트 맵\n\n| Bounded Context | Context ID | 책임 | 주 입력 | 주 출력 | 비고 |\n|---|---|---|---|---|---|\n| 커뮤니티 | community | 글 삭제 | 삭제 요청 | 게시글이 삭제됨 | accepted-target, SD-01 core |\n' },
    artifacts: [artifact(requirements, 'requirements'), artifact('CONTEXT-MAP.md', 'context_map'), artifact('CONTEXT.md', 'glossary')],
  });
  // The E2E defect: bounded-context fixed the document without the sync plan. finish refuses, names the recovery for the same
  // subagent instead of a bare HARNESS_ERROR, and leaves the stage running.
  const missingSync = flow.finishStage(fixing);
  assert.notEqual(missingSync.status, 0);
  const missingBody = JSON.parse(missingSync.stderr || missingSync.stdout);
  assert.equal(missingBody.code, 'DOMAIN_SYNC_MISSING', missingSync.stderr);
  assert.match(missingBody.next[0], /harness-domain\.mjs sync plan/);
  const { planDomainSync } = await import(pathToFileURL(join(workspace, '.harness/src/domain/sync.mjs')));
  const id = 'community.rule.delete-own-post';
  const domainPath = `docs/domain/contexts/community/rules/${id}.md`;
  const domainPlan = await planDomainSync(workspace, planSetId, {
    schema_version: 1, links: { 'INV-01': id }, changes: [{ operation: 'create', id, reason: '확정된 작성자 제한',
      document: { metadata: { schema_version: 1, id, owner_context: 'community', kind: 'rule', name: '게시글 삭제 권한',
        status: 'accepted-target', aliases: [], source_refs: [`${requirements}#INV-01`], references: [],
        statement: '작성자만 삭제한다', condition: '삭제 요청', violation_result: '삭제 거절' }, body: '# 게시글 삭제 권한\n' } }],
  });
  await writeFile(join(fixing.prepared.execution_directory, 'domain-sync.json'), JSON.stringify(domainPlan));
  const fixed = flow.finishStage(fixing);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(JSON.parse(fixed.stdout).status, 'completed');
  const fixCommit = treeGit('show', '--name-only', '--format=', 'HEAD');
  for (const path of ['CONTEXT-MAP.md', 'CONTEXT.md', requirements, domainPath]) assert.ok(fixCommit.includes(path), `${path} is committed with bounded-context`);
  assert.match(fixCommit, /domain-links\.json/);
  assert.match(await readFile(join(workspace, requirements), 'utf8'), /상태: fixed/);

  // The tactical design flow follows the last requirements stage and receives the fixed document as an input reference;
  // the new-feature flow continues through tactical design before implementation.
  const premature = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-prepare-input.mjs'), '--stage-id', 'spec-me'], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(premature.status, 0);
  assert.match(premature.stderr, /spec-me has been removed/);
  // The user approves the fixed requirements before tactical design: bounded-context's finish tells the orchestrator to show them
  // and ask, and the runner refuses domain-model without the user's own logged reply.
  assert.match(JSON.parse(fixed.stdout).next, /Show the user result\.summary[\s\S]*answer --text/);
  assert.match(JSON.parse(fixed.stdout).next, /standalone `\$orchestrator <approval>`/);
  const unapproved = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-prepare-input.mjs'), '--stage-id', 'domain-model'], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(unapproved.status, 0);
  assert.equal(JSON.parse(unapproved.stderr).code, 'PRECONDITION');
  assert.match(JSON.parse(unapproved.stderr).user_decision, /standalone `\$orchestrator <approval>`/);
  assert.match(unapproved.stderr, /Requirements approval answer was not recorded/);
  const claimed = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-prepare-input.mjs'), '--stage-id', 'domain-model', '--requirements-approved', 'true', '--approval-answer', '승인'], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(claimed.status, 0, 'a bare flag with words the user never said is not approval');
  // The user's words sent as a plain message (attempt 025's headless resume) are in the owner transcript but are not an orchestrator
  // request: the installed command refuses them and says exactly why and how to send them.
  await codexUserPrompt(workspace, '요구사항 좋아요, 승인', { prefix: '' });
  const plainApproval = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-native-stage.mjs'), 'launch', '--stage-id', 'domain-model', '--requirements-approved', 'true', '--approval-answer', '요구사항 좋아요, 승인'], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(plainApproval.status, 0);
  const plainRefusal = JSON.parse(plainApproval.stderr);
  assert.equal(plainRefusal.code, 'PRECONDITION');
  assert.deepEqual(plainRefusal.approval_search.candidates.map(({ form, problems }) => ({ form, problems })), [{ form: 'plain_user_message', problems: ['missing_orchestrator_prefix'] }]);
  assert.match(plainRefusal.error, /plain user message at \S+ with exactly that text, but it has no leading `\$orchestrator`/);
  assert.match(plainRefusal.user_decision, /`\$orchestrator <reply>` \(Codex; headless: `codex exec resume <session-id> '\$orchestrator <reply>'`\) or `\/orchestrator <reply>` \(Claude Code\)/);
  assert.match(plainRefusal.user_decision, /send the same text as `\$orchestrator 요구사항 좋아요, 승인`/);
  const misplaced = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-prepare-input.mjs'), '--stage-id', 'aggregate-design', '--requirements-approved', 'true', '--approval-answer', '승인'], { cwd: workspace, encoding: 'utf8' });
  assert.match(misplaced.stderr, /Requirements approval is only valid for domain-model/);
  const next = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'domain-model', ...await flow.approveRequirements('요구사항 좋아요, 승인')]);
  assert.equal(next.input.skill, 'domain-model');
  assert.equal(next.input.context.transition.from_stage, 'bounded-context');
  assert.equal(next.input.context.transition.code, 'OK');
  assert.ok(next.input.input_refs.some((reference) => reference.base === 'workspace' && reference.path === requirements && reference.kind === 'requirements'));
  assert.deepEqual(treeGit('log', '--format=%s', '-7').trim().split('\n'), [...REQUIREMENTS_STAGES].reverse().map((stage) => `${stage}: ${planSetId}`));
  assert.match(treeGit('status', '--short', '--untracked-files=all'), /\?\? docs\/domain\/stakeholders\/SH-01\.md/, 'the runner never commits the project-owned card');

  // Preparing a partial revision leaves the current requirements in place.
  const revision = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'requirements-fix', '--feedback', '삭제는 작성자만 한다고 바꿔 줘', '--user-revision', 'true']);
  assert.equal(revision.input.skill, 'requirements-fix');
  assert.equal(revision.input.context.user_revision, true);
  const reviseBusiness = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'subdomain-candidates', '--feedback', '별도로 완료되는 업무를 확인해 줘', '--user-revision', 'true']);
  assert.equal(reviseBusiness.input.skill, 'subdomain-candidates');

  // Restart preserves the old state and returns to the checkpoint before bounded-context.
  const restartArgs = ['--stage-id', 'bounded-context', '--restart-requirements', 'true'];
  const dirty = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-prepare-input.mjs'), ...restartArgs], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /clean project worktree/);
  await rm(join(workspace, 'docs/domain/stakeholders/SH-01.md'));
  await rm(join(workspace, 'docs/domain/actors/actor.author.md'));
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const beforeRestart = await readFile(statePath, 'utf8');
  const running = JSON.parse(beforeRestart);
  running.stages['spec-me'] = { status: 'running', execution_id: 'spec-me-running' };
  await writeFile(statePath, JSON.stringify(running));
  const active = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-prepare-input.mjs'), ...restartArgs], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(active.status, 0);
  assert.match(active.stderr, /cannot be verified stopped/);
  await writeFile(statePath, beforeRestart);
  await writeFile(join(workspace, 'app.txt'), 'unrelated committed change\n');
  treeGit('add', 'app.txt');
  treeGit('commit', '-qm', 'application change');
  const laterCommit = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-prepare-input.mjs'), ...restartArgs], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(laterCommit.status, 0);
  assert.match(laterCommit.stderr, /Unrelated or later commits/);
  assert.equal(await readFile(join(workspace, 'app.txt'), 'utf8'), 'unrelated committed change\n');
  treeGit('reset', '--hard', 'HEAD^');
  treeGit('commit', '--allow-empty', '-qm', `ubiquitous-language: ${planSetId}`);
  const legacyOrder = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-prepare-input.mjs'), ...restartArgs], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(legacyOrder.status, 0);
  assert.match(legacyOrder.stderr, /earlier stage order/);
  treeGit('reset', '--hard', 'HEAD^');
  const restart = invoke(workspace, 'harness-prepare-input.mjs', restartArgs);
  assert.equal(restart.previous_stage, 'requirements-fix');
  assert.equal(existsSync(join(workspace, domainPath)), false);
  assert.equal(existsSync(join(workspace, specPath('domain-links.json'))), false);
  assert.ok(existsSync(join(restart.backup, 'state.json')));
  const restored = await readFile(join(workspace, requirements), 'utf8');
  assert.match(restored, /상태: draft/);
  assert.match(restored, /INV-01/, 'the completed requirements are kept');
  const state = JSON.parse(await readFile(join(workspace, '.io/runtime/orchestrator/state.json'), 'utf8'));
  assert.equal(state.current_stage, 'requirements-fix');
  assert.equal(state.stages['bounded-context'], undefined);
  assert.equal(state.stages['requirements-fix'].status, 'completed', 'the completed requirements interview is retained');
  assert.equal(state.stages['ubiquitous-language'].status, 'completed', 'earlier vocabulary is retained');
  const fresh = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'bounded-context']);
  assert.equal(fresh.input.context.transition.from_stage, 'requirements-fix');

  const fixedDocument = (rule) => `# 요구사항 명세\n\n- 상태: fixed\n\n### BIZ-01 게시글 삭제 (SD-01)\n\n- 업무 규칙: INV-01 ${rule}\n`;
  const initialRule = '작성자만 자기 글을 삭제한다.';
  await runStage('bounded-context', { files: { [requirements]: fixedDocument(initialRule) }, artifacts: [artifact(requirements, 'requirements')] });
  const firstApprovalArgs = await flow.approveRequirements('첫 번째 요구사항을 승인합니다');
  const staleStart = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'domain-model', ...firstApprovalArgs]);
  const tacticalDesign = specPath('tactical-design.md');
  const design = await runStage('domain-model', {
    extraArgs: firstApprovalArgs,
    files: { [tacticalDesign]: '# 전술 설계\n\n## 1. Domain Model\n\nBIZ-01 / INV-01 게시글 삭제\n' },
    artifacts: [artifact(tacticalDesign, 'tactical_design')],
  });
  const applicationFile = '.harness/agents/EXEC.md';
  await writeFile(join(workspace, applicationFile), '# 프로젝트 실행 설정\n');
  const headBeforeRevision = treeGit('rev-parse', 'HEAD');
  const designBeforeRevision = await readFile(join(workspace, tacticalDesign), 'utf8');
  const gitBeforeRevision = treeGit('status', '--short', '--untracked-files=all');
  assert.match(gitBeforeRevision, / M \.harness\/agents\/EXEC\.md/);
  const revise = '작성자와 운영자가 각자 권한에 따라 지울 수 있게 고쳐 줘';
  const rerun = await flow.beginStage('requirements-fix', { extraArgs: ['--user-revision', 'true', '--feedback', revise] });
  assert.equal(treeGit('rev-parse', 'HEAD'), headBeforeRevision);
  assert.equal(await readFile(join(workspace, requirements), 'utf8'), fixedDocument(initialRule));
  assert.equal(await readFile(join(workspace, tacticalDesign), 'utf8'), designBeforeRevision);
  assert.equal(treeGit('status', '--short', '--untracked-files=all'), gitBeforeRevision);
  const duringRevision = invoke(workspace, 'harness-context.mjs', []);
  assert.equal(duringRevision.stages['domain-model'].stale.owner_stage, 'requirements-fix');
  assert.equal(duringRevision.stages['subdomain-classification'].stale, undefined);
  const revisedRule = '작성자와 운영자가 각자 권한에 따라 지운다.';
  await flow.submitStage(rerun, { files: { [requirements]: fixedDocument(revisedRule).replace('상태: fixed', '상태: draft') }, artifacts: [artifact(requirements, 'requirements')] });
  const rerunResult = flow.finishStage(rerun);
  assert.equal(rerunResult.status, 0, rerunResult.stderr);
  assert.match(JSON.parse(rerunResult.stdout).next, /--stage-id bounded-context/);
  const fixedAgain = await runStage('bounded-context', { files: { [requirements]: fixedDocument(revisedRule) }, artifacts: [artifact(requirements, 'requirements')] });
  assert.match(fixedAgain.finished.next, /Show the user result\.summary/);
  assert.match(invoke(workspace, 'harness-context.mjs', []).next, /Show the user result\.summary/);
  const command = (file, args) => spawnSync(process.execPath, [join(workspace, '.harness/scripts', file), ...args], { cwd: workspace, encoding: 'utf8' });
  for (const args of [[], firstApprovalArgs]) {
    const refused = command('harness-native-stage.mjs', ['launch', '--stage-id', 'domain-model', ...args]);
    assert.notEqual(refused.status, 0, refused.stdout);
    assert.match(refused.stderr, /Requirements approval answer was not recorded/);
  }
  const oldPrepared = command('harness-native-stage.mjs', ['start', '--execution-id', staleStart.input.execution_id]);
  assert.notEqual(oldPrepared.status, 0, oldPrepared.stdout);
  assert.match(oldPrepared.stderr, /Requirements approval answer was not recorded/);
  const reapproved = await flow.beginStage('domain-model', { extraArgs: await flow.approveRequirements('수정된 요구사항을 승인합니다') });
  assert.ok(reapproved.prepared.input.input_refs.some((reference) => reference.kind === 'upstream_user_revision'));
  const revisedState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(revisedState.stages['domain-model'].requirements_approval, fixedAgain.finished.execution_id);
  assert.equal(revisedState.stages['domain-model'].attempts[0].execution_id, design.finished.execution_id, 'the previous design execution is still available');
  assert.equal(await readFile(join(workspace, applicationFile), 'utf8'), '# 프로젝트 실행 설정\n');
});

test('a skipped stakeholder-analysis makes later stages record the skip, then tactical-to-code follows tactical design', async (t) => {
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
  const premature = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-prepare-input.mjs'), '--stage-id', 'spec-me'], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(premature.status, 0);
  assert.match(premature.stderr, /spec-me has been removed/);
  for (const stage of TACTICAL_DESIGN_STAGES) await runStage(stage, { summary: `생략: stakeholder-analysis 판정 생략 (${analysis})`, expectCommit: false });
  const next = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', 'tactical-technology']);
  assert.equal(next.input.context.stage_id, 'tactical-technology');
});

// The event diagrams are rendered by the installed local renderer. The examples in the reference are rendered here, so a
// broken example or renderer fails the suite; the render itself needs Java, Graphviz and the cached pinned PlantUML jar.
const JAR = join(process.env.XDG_CACHE_HOME || join(process.env.HOME || '', '.cache'), 'harness-codex/plantuml/plantuml-1.2024.7.jar');
const toolsAvailable = ['java', 'dot'].every((command) => spawnSync(command, command === 'java' ? ['-version'] : ['-V'], { stdio: 'ignore' }).status === 0) && existsSync(JAR);

test('the event diagram examples render to SVG and a broken diagram fails the renderer', { skip: toolsAvailable ? false : 'Java, Graphviz or the cached PlantUML jar is unavailable' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'event-diagrams-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reference = await read('.harness/internal-skills/event-storming/references/diagrams.md');
  const examples = fenced(reference, 'plantuml');
  assert.equal(examples.length, 2, 'one per-subdomain and one cross-subdomain example');
  const renderer = join(sourceRoot, '.harness/tools/plantuml-render.mjs');
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
