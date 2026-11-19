import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TACTICAL_DESIGN_STAGES, TACTICAL_IMPLEMENTATION_STAGES } from '../.harness/src/workflow/worktree-stages.mjs';
import { codexUserPrompt } from './support/codex-user-prompt.mjs';
import { consumerWorkflow, SETUP, sourceRoot } from './support/consumer-workflow.mjs';
import { bindNativeReviewer } from './support/native-reviewer.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';

const REQUEST = '커뮤니티 게시글 작성 기능을 기존 전술 설계에 따라 구현한다';
const APPROVAL = '네, 검토한 ticket 계획 그대로 발행하세요';

const REQUIREMENTS = `# 요구사항 명세

- 상태: fixed

### BIZ-01 방문자 확인 (SD-01)
- INV-01: 방문자는 글을 쓸 수 없다
### BIZ-02 게시글 작성 (SD-02)
- INV-02: 본문은 1000자 이하다
- AC-01: 회원이 쓴 글이 목록에 보인다
`;
const TACTICAL_DESIGN = `# 전술 설계

## 4. Application Service

| AS | 이름 | 업무 |
|---|---|---|
| AS-01 | 방문자 확인 | BIZ-01 |
| AS-02 | 게시글 작성 | BIZ-02 |

## 6. 컨텍스트 경계

| 상류 BC | 하류 BC | 관계 패턴 | 코드 의존 | 경계 강제 | 데이터 소유·타입 경계 | 근거·출처 |
|---|---|---|---|---|---|---|
| 인증 | 커뮤니티 | Customer-Supplier | 상류 공개 API 의존 | import 검사 | 각자 자기 table만 접근 | CONTEXT-MAP.md |
`;
const TICKET = (title, bc, biz, rule, needs) => `---
status: planned
---
# ${title}

## 구현 목적

${title}을 구현한다.

## 대상

| 항목 | 내용 |
|---|---|
| 컨텍스트(BC) | ${bc} |
| 업무(BIZ) | ${biz} |

## 소유 규칙과 검증

| 요구 | 내용 | 강제 위치 | 검증 테스트(파일 — 테스트 이름) |
|---|---|---|---|
| ${rule} | 규칙 | 값 | test/${biz}.test.mjs — 규칙을 지킨다 |

## 컨텍스트 경계 (tactical-design 6절)

| 상대 컨텍스트 | 방향 | 허용 의존 | 데이터 소유 | 경계 강제 검사 |
|---|---|---|---|---|
| 인증 | 하류 | 공개 API | 각자 | test/boundary.test.mjs |

## 의존한 결정

- 기술(technology.md): node --test

## 의존성

${needs ? `선행 ticket: \`${needs}\`.` : '없음'}

## 완료 기준

- 위 표의 테스트가 통과한다.
`;
const INDEX = `# Plan set

| ticket | 요약 | 컨텍스트·BIZ | 의존성 |
|---|---|---|---|
| [auth-visitor-check](auth-visitor-check.md) | 방문자 확인 | 인증·BIZ-01 | 없음 |
| [post-write](post-write.md) | 게시글 작성 | 커뮤니티·BIZ-02 | auth-visitor-check |
`;

async function prepareWorkflow(t) {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, planSetId, treeGit } = flow;
  await writeFile(join(workspace, '.harness/harness.yaml'), `${SETUP}`);
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const stage of TACTICAL_DESIGN_STAGES) state.stages[stage] = { status: 'completed', code: 'OK', result_ref: `runtime/executions/${stage}/result.json` };
  state.current_stage = 'workflow-compose';
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
  const documents = { [`docs/specs/${planSetId}/requirements.md`]: REQUIREMENTS, [`docs/specs/${planSetId}/tactical-design.md`]: TACTICAL_DESIGN };
  for (const [path, content] of Object.entries(documents)) { await mkdir(join(workspace, path, '..'), { recursive: true }); await writeFile(join(workspace, path), content); }
  treeGit('add', 'docs');
  treeGit('commit', '-qm', 'tactical design fixture');
  return { ...flow, statePath };
}

test('tactical completion blocks an empty ticket set', async (t) => {
  const { workspace, planSetId } = await prepareWorkflow(t);
  const dir = join(workspace, 'docs/plans', planSetId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plans.md'), '# Empty plan set\n');
  const { deriveTacticalOutcome } = await import(pathToFileURL(join(workspace, '.harness/src/workflow/tactical-tickets.mjs')).href);
  assert.equal((await deriveTacticalOutcome({ root: workspace, planSetId, session: '.io' })).reason, 'tickets_missing');
});

test('tactical-to-code runs the decisions, the ticket split, approved publication and the tickets in order, without any Spec', async (t) => {
  const flow = await prepareWorkflow(t);
  const { workspace, planSetId, treeGit, runStage, beginStage, submitStage, finishStage, invoke, statePath } = flow;
  const prepare = (...args) => spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--verbose', ...args], { cwd: workspace, encoding: 'utf8' });
  const refused = (result, pattern) => { assert.notEqual(result.status, 0, result.stdout); assert.match(result.stderr, pattern, result.stderr); return result; };
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));

  assert.deepEqual(TACTICAL_IMPLEMENTATION_STAGES, ['tactical-technology', 'tactical-ui', 'tactical-api', 'tactical-data', 'to-ticket', 'tracker-publish', 'tactical-code']);
  // The order guard: no ticket stage before the decisions, and no later stage before its predecessor completed.
  refused(prepare('--stage-id', 'to-ticket'), /to-ticket cannot start before tactical-technology/);
  refused(prepare('--stage-id', 'tactical-code', '--plan', 'post-write'), /tactical-code cannot start before tactical-technology/);

  const decisions = [['tactical-technology', 'technology.md', 'Node 20과 `node --test`를 쓴다.\n'], ['tactical-ui', null, '서버 전용 요청이라 UI는 없다.'], ['tactical-api', 'api.md', '`POST /posts`를 둔다.\n'], ['tactical-data', 'data.md', '`posts` table을 둔다.\n']];
  for (const [stage, name, content] of decisions) await runStage(stage, { files: name ? { [`docs/implementation/${planSetId}/${name}`]: content } : {}, summary: content, expectCommit: Boolean(name) });
  refused(prepare('--stage-id', 'tracker-publish', '--publication-approved', 'true', '--approval-answer', APPROVAL), /tracker-publish cannot start before to-ticket/);

  // to-ticket splits the settled design into tickets per context and business activity, reviewed by a fresh reviewer.
  const otherPlan = 'docs/specs/other-plan/tactical-design.md';
  await mkdir(join(workspace, otherPlan, '..'), { recursive: true });
  await writeFile(join(workspace, otherPlan), '# Separate plan\n');
  const ticketStage = await beginStage('to-ticket');
  const ticketId = ticketStage.prepared.input.execution_id;
  assert.equal(ticketStage.started.agent_profile, 'to_ticket');
  const references = ticketStage.prepared.input.input_refs;
  for (const path of [
    `docs/specs/${planSetId}/requirements.md`, `docs/specs/${planSetId}/tactical-design.md`,
    ...['technology', 'api', 'data'].map((name) => `docs/implementation/${planSetId}/${name}.md`),
  ]) assert.equal(references.filter((reference) => reference.base === 'workspace' && reference.path === path).length, 1, path);
  assert.ok(!references.some((reference) => reference.path === otherPlan || reference.kind === 'frontend_design_brief'));
  assert.match(treeGit('status', '--porcelain', '--untracked-files=all'), /\?\? docs\/specs\/other-plan\/tactical-design\.md/);
  await rm(join(workspace, otherPlan));
  const plans = join('docs/plans', planSetId);
  for (const [name, content] of [['plans.md', INDEX], ['auth-visitor-check.md', TICKET('방문자 확인', '인증', 'BIZ-01', 'INV-01')], ['post-write.md', TICKET('게시글 작성', '커뮤니티', 'BIZ-02', 'INV-02', 'auth-visitor-check')]]) {
    await mkdir(join(workspace, plans), { recursive: true });
    await writeFile(join(workspace, plans, name), content);
  }
  const env = { HARNESS_WORKSPACE_ROOT: workspace, HARNESS_SKILL_EXECUTION_ID: ticketId };
  const planReview = await import(pathToFileURL(join(workspace, '.harness/src/workflow/plan-review.mjs')).href);
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const snapshot = await planReview.snapshotPlanSet({ root: workspace, planSetId });
    assert.deepEqual(snapshot.spec_paths, [], 'no Product or Architecture Spec is part of the review basis');
    assert.ok(snapshot.design_paths.includes(`docs/specs/${planSetId}/tactical-design.md`) && snapshot.design_paths.includes(`docs/implementation/${planSetId}/data.md`));
    assert.ok(Object.keys(snapshot.inputs).every((path) => !/product-spec|architecture-spec/.test(path)));
    const admission = await planReview.updatePlanReview({ root: workspace, planSetId, action: 'begin' });
    await bindNativeReviewer({ root: workspace, scope: `plan-${planSetId}`, attemptId: admission.attempt_id, executionId: ticketId, reviewerId: 'plan-reviewer', parentSessionId: 'plan-author' });
    assert.equal((await planReview.updatePlanReview({ root: workspace, planSetId, action: 'record', attemptId: admission.attempt_id, review: { schema_version: 1, attempt_id: admission.attempt_id, plan_set_id: planSetId }, requireNative: true })).status, 'pass');
  } finally { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; }
  await submitStage(ticketStage, { artifacts: [{ path: `${plans}/plans.md`, kind: 'plan_set_draft' }], summary: '두 ticket으로 나눴다' });
  const before = treeGit('rev-parse', 'HEAD').trim();
  const finished = JSON.parse(finishStage(ticketStage).stdout);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.notEqual(treeGit('rev-parse', 'HEAD').trim(), before);
  assert.deepEqual(treeGit('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), [`${plans}/auth-visitor-check.md`, `${plans}/plans.md`, `${plans}/post-write.md`], 'only the ticket documents are committed');
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '', 'the ticket documents are project-owned and visible to Git once committed');

  // Publication needs the user's own reply to the reviewed plan set.
  refused(prepare('--stage-id', 'tracker-publish'), /Completed to-ticket and user publication approval are required/);
  refused(prepare('--stage-id', 'tracker-publish', '--publication-approved', 'true'), /Publication approval answer was not recorded/);
  refused(prepare('--stage-id', 'tracker-publish', '--publication-approved', 'true', '--approval-answer', APPROVAL), /Publication approval answer was not recorded/);
  await codexUserPrompt(workspace, APPROVAL, { at: new Date(Date.now() - 3600_000).toISOString() });
  refused(prepare('--stage-id', 'tracker-publish', '--publication-approved', 'true', '--approval-answer', APPROVAL), /Publication approval answer was not recorded/);
  assert.equal((await state()).stages['tracker-publish'], undefined, 'a refusal records nothing');
  refused(prepare('--stage-id', 'tactical-code', '--plan', 'auth-visitor-check'), /tactical-code cannot start before tracker-publish/);
  await codexUserPrompt(workspace, APPROVAL);
  const publish = await beginStage('tracker-publish', { extraArgs: ['--publication-approved', 'true', '--approval-answer', APPROVAL] });
  assert.equal(publish.started.agent_profile, 'tracker_publisher');
  const { resolveAgentSandbox } = await import(pathToFileURL(join(workspace, '.harness/src/workflow/skill-execution.mjs')).href);
  assert.deepEqual(await resolveAgentSandbox({ root: workspace, input: { skill: 'tracker-publish' }, workflow: 'tactical-to-code', stage: 'tracker-publish' }), { profile: 'tracker_publisher', sandbox: 'danger-full-access' }, 'the publisher is the one stage with network and tracker access');
  await submitStage(publish, { summary: '계획을 발행했다' });
  assert.equal(JSON.parse(finishStage(publish).stdout).status, 'completed');

  // tactical-code builds one ticket per run, after the tickets it depends on.
  refused(prepare('--stage-id', 'tactical-code'), /tactical-code needs --plan <ticket-id>/);
  refused(prepare('--stage-id', 'tactical-code', '--plan', 'post-write'), /tactical-code post-write cannot start before its prerequisite ticket auth-visitor-check is completed; ready tickets: auth-visitor-check/);
  refused(prepare('--stage-id', 'tactical-code', '--plan', 'missing'), /Plan missing is not part of plan set/);
  const context = () => JSON.parse(execFileSync(process.execPath, [join(workspace, '.codex/scripts/harness-context.mjs')], { cwd: workspace, encoding: 'utf8' }));
  assert.deepEqual(context().ready_tickets, [{ plan_id: 'auth-visitor-check', depends_on: [] }]);

  // The stage marks the ticket completed with the installed tracker command, which rewrites the local ticket's status.
  const implementTicket = async (begun, ticket, files, summary) => {
    const sync = spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-tracker.mjs'), 'sync', '--root', workspace, '--ticket', `${plans}/${ticket}.md`, '--status', 'completed'], { cwd: workspace, encoding: 'utf8', env: { ...process.env, HARNESS_SKILL_EXECUTION_ID: begun.prepared.input.execution_id } });
    assert.equal(sync.status, 0, sync.stderr || sync.stdout);
    const paths = [...Object.keys(files), `${plans}/${ticket}.md`];
    await submitStage(begun, { files, summary, commit_request: { message: `tactical-code: ${planSetId}/${ticket}`, paths } });
    const head = treeGit('rev-parse', 'HEAD').trim();
    const done = JSON.parse(finishStage(begun).stdout);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.notEqual(treeGit('rev-parse', 'HEAD').trim(), head);
    assert.equal(treeGit('log', '-1', '--format=%s').trim(), `tactical-code: ${planSetId}/${ticket}`, 'one commit per ticket');
    assert.deepEqual(treeGit('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), [...paths].sort());
  };
  const startTicket = async (ticket, extraArgs = ['--plan', ticket]) => {
    const begun = await beginStage('tactical-code', { extraArgs });
    assert.equal(begun.prepared.input.context.plan_id, ticket);
    assert.ok(begun.prepared.input.input_refs.some((reference) => reference.kind === 'ticket' && reference.path === `${plans}/${ticket}.md`), 'the stage reads the ticket file');
    return begun;
  };

  // A ticket that cannot proceed is blocked; the same ticket resumes with feedback and no --plan, and stays the one ticket in flight.
  const blockedRun = await startTicket('auth-visitor-check');
  await submitStage(blockedRun, { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: 'api.md가 인증 API를 정하지 않았다' });
  assert.equal(JSON.parse(finishStage(blockedRun).stdout).status, 'blocked');
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '', 'a blocked ticket commits nothing');
  const resumed = await startTicket('auth-visitor-check', ['--feedback', 'api.md를 보완했다']);
  assert.equal(resumed.prepared.input.context.plan_id, 'auth-visitor-check');
  await implementTicket(resumed, 'auth-visitor-check', { 'src/auth.mjs': 'export const visitor = (user) => user === null;\n', 'test/BIZ-01.test.mjs': "import assert from 'node:assert/strict';\nimport { visitor } from '../src/auth.mjs';\nassert.equal(visitor(null), true);\n" }, '방문자 확인 구현');
  assert.match(await readFile(join(workspace, plans, 'auth-visitor-check.md'), 'utf8'), /^---\nstatus: completed\n---/);
  refused(prepare('--stage-id', 'tactical-code', '--plan', 'auth-visitor-check'), /Ticket auth-visitor-check is already completed; ready tickets: post-write/);
  assert.deepEqual(context().ready_tickets, [{ plan_id: 'post-write', depends_on: ['auth-visitor-check'] }]);
  const gate = (...extra) => spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-workflow-complete.mjs'), '--root', workspace, '--workflow', 'tactical-to-code', '--worktree-id', flow.tree.worktree_id, '--base-ref', flow.tree.head, ...extra], { cwd: workspace, encoding: 'utf8' });
  // While a ticket is open the gate stays in progress, and a state file cannot claim the outcome.
  await writeFile(join(workspace, '.io/runtime/claim.json'), JSON.stringify({ required_outcome: { passed: true }, tests: { passed: true } }));
  const early = gate('--state', 'runtime/claim.json');
  assert.notEqual(early.status, 0);
  const claimed = JSON.parse(early.stdout);
  assert.equal(claimed.state, 'in-progress');
  assert.equal(claimed.verdict.checks.find((check) => check.rule_id === 'required_outcome').reason, 'tickets_not_completed');
  assert.deepEqual(claimed.ignored_state_keys, ['required_outcome'], 'a state file cannot claim the ticket outcome');
  await implementTicket(await startTicket('post-write'), 'post-write', { 'src/post.mjs': 'export const write = (text) => text.length <= 1000;\n', 'test/BIZ-02.test.mjs': "import assert from 'node:assert/strict';\nimport { write } from '../src/post.mjs';\nassert.equal(write('a'), true);\n" }, '게시글 작성 구현');
  assert.equal(context().ready_tickets, undefined, 'no ticket is left');

  // The final gate reads the tracker and the recorded runs; the review of the published plan set stays current.
  const completion = JSON.parse(gate('--final-workflow').stdout);
  assert.equal(completion.state, 'completed', JSON.stringify(completion.verdict));
  assert.equal(completion.completion_kind, 'tickets_implemented');

  // The published plan set stays tied to the design it was reviewed against: a changed decision makes the gate wait again.
  const api = join(workspace, 'docs/implementation', planSetId, 'api.md');
  const settledApi = await readFile(api, 'utf8');
  await writeFile(api, `${settledApi}\n\`GET /posts\`도 둔다.\n`);
  const stale = JSON.parse(gate().stdout);
  assert.equal(stale.state, 'in-progress');
  assert.match(stale.verdict.checks.find((check) => check.rule_id === 'plan_review').reason, /stale/i);
  await writeFile(api, settledApi);

  // Nothing of the flow needed a Spec, and Git sees the project's documents and code but no Harness file.
  for (const spec of ['product-spec.md', 'architecture-spec.md']) assert.equal(await readFile(join(workspace, 'docs/specs', planSetId, spec), 'utf8').catch(() => null), null);
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '');
  assert.match(execFileSync('git', ['-C', workspace, 'check-ignore', '-v', '.codex/internal-skills/tactical-code/GUIDE.md', '.harness/src/workflow/tactical-tickets.mjs', '.io/runtime/orchestrator/state.json'], { encoding: 'utf8' }), /exclude/);
});

// What the previous release installed: the tactical flow without ticket stages, and the plan-and-publish workflow that asked for a Spec review.
const PREVIOUS_TACTICAL_TO_CODE = `schema_version: 1
id: tactical-to-code
orchestrator: orchestrator
roles: [tactical_designer, tactical_implementation_agent]
skills: [orchestrator, tactical-technology, tactical-ui, tactical-api, tactical-data, tactical-code]
hooks:
  before_dispatch: [dependency, resource_conflict, workspace, permission_preflight]
  before_handoff: [checkpoint_completeness, evidence_flush]
  before_complete: [required_outcome, tests, evidence]
  after_merge: []
stages:
  - id: tactical-technology
    role: tactical_designer
    skill: tactical-technology
    model_tier: low_performance
    needs: []
  - id: tactical-code
    role: tactical_implementation_agent
    skill: tactical-code
    model_tier: implementation
    needs: [tactical-technology]
`;
const PREVIOUS_TO_TICKET = `schema_version: 1
id: to-ticket
orchestrator: orchestrator
roles: [to_ticket, tracker_publisher, pr_author]
skills: [orchestrator, worktree-create, to-ticket, plan-review, tracker-publish, gh-open-pr]
hooks:
  before_dispatch: [dependency, resource_conflict, workspace, permission_preflight, spec_reviews]
  before_handoff: [checkpoint_completeness]
  before_complete: [tracker_sync, plans_index, plan_review]
  after_merge: []
stages:
  - id: to-ticket
    role: to_ticket
    skill: to-ticket
    needs: []
  - id: tracker-publish
    role: tracker_publisher
    skill: tracker-publish
    needs: [to-ticket]
  - id: plan-pr
    role: pr_author
    skill: gh-open-pr
    needs: [tracker-publish]
`;

test('an update from the previous release brings the ticket stages and keeps project-owned documents visible while Harness files stay ignored', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tactical-ticket-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const sha = (content) => createHash('sha256').update(content).digest('hex');
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'app.txt'), 'original\n');
  git('add', 'app.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  const lockPath = join(root, '.codex/harness-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const ticketGuide = '.codex/internal-skills/to-ticket/GUIDE.md';
  for (const [path, content] of [['.codex/workflows/tactical-to-code.yaml', PREVIOUS_TACTICAL_TO_CODE], ['.codex/workflows/to-ticket.yaml', PREVIOUS_TO_TICKET], [ticketGuide, '# Previous authoring instructions\n']]) {
    await writeFile(join(root, path), content);
    lock.files[path].installed_sha256 = sha(content);
    lock.files[path].upstream_sha256 = sha(content);
  }
  await writeFile(lockPath, JSON.stringify(lock));
  const documents = { 'docs/specs/old/tactical-design.md': '# project design\n', 'docs/plans/old/plans.md': '# project plans\n', 'docs/agents/EXEC.md': 'project execution notes\n' };
  for (const [path, content] of Object.entries(documents)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  await writeFile(join(root, 'app.txt'), 'application edit\n');

  await updateProject({ sourceRoot, targetRoot: root });
  assert.match(await readFile(join(root, ticketGuide), 'utf8'), /exact design paths in `input_refs`/);
  for (const name of ['tactical-to-code', 'to-ticket']) assert.equal(await readFile(join(root, `.codex/workflows/${name}.yaml`), 'utf8'), await readFile(join(sourceRoot, `.codex/workflows/${name}.yaml`), 'utf8'), `${name} is replaced by the new release`);
  const installed = await import(pathToFileURL(join(root, '.harness/src/workflow/loader.mjs')).href);
  assert.deepEqual((await installed.loadNamedWorkflow('tactical-to-code', { root })).stages.map(({ id }) => id), TACTICAL_IMPLEMENTATION_STAGES);
  assert.ok(!Object.values((await installed.loadNamedWorkflow('to-ticket', { root })).hooks).flat().includes('spec_reviews'));
  const errors = (await runDoctor({ root, sourceRoot })).diagnostics.filter(({ severity, code }) => severity === 'error' && ['execution_asset_missing', 'workflow_invalid', 'tracker_publisher_stage_missing', 'tracker_publisher_sandbox', 'dangerous_sandbox_scope'].includes(code));
  assert.deepEqual(errors, []);
  const status = git('status', '--short', '--untracked-files=all');
  assert.match(status, /^ M app\.txt$/m);
  for (const path of Object.keys(documents)) assert.match(status, new RegExp(`\\?\\? ${path.replaceAll('.', '\\.')}`), `${path} stays visible`);
  assert.doesNotMatch(status, /\.codex\/|\.harness\/|\.agents\/|\.claude\/|\.io\//);
  assert.match(git('check-ignore', '-v', ticketGuide, '.harness/src/workflow/plan-review.mjs'), /info\/exclude/);
  for (const [path, content] of Object.entries(documents)) assert.equal(await readFile(join(root, path), 'utf8'), content, `${path} is untouched`);
});
