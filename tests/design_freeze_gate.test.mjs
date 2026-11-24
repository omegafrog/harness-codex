import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { consumerWorkflow, SETUP } from './support/consumer-workflow.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { TACTICAL_DESIGN_STAGES } from '../.harness/src/workflow/worktree-stages.mjs';
import { DesignFreezeError, assertDesignFreezeGate, checkDesignFreeze, checkWorkspaceDesignFreeze, designNotFrozen, evaluateDesignFreezeGate, freezeFailureInstruction } from '../.harness/src/workflow/design-freeze-gate.mjs';
import { dependencyOwnerErrors, OWNER_REQUIRED_STAGES } from '../.harness/src/workflow/stage-reopen.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(sourceRoot, '.harness/scripts/harness-design-freeze-check.mjs');

const REQUIREMENTS = `# 요구사항 명세

### BIZ-01 계산기 이용 (SD-01)

- 업무 주체: 사용자: 계산한다
- 업무 규칙:
  - INV-01 사칙연산을 한다
- 완료 조건:
  - AC-01 계산 결과를 본다

### BIZ-02 사용자 인증 (SD-02)

- 업무 주체: 사용자: 가입과 로그인을 한다
- 업무 규칙:
  - INV-03 이메일과 비밀번호로 가입하고 로그인한다
- 완료 조건:
  - AC-03 로그인에 성공한다

### BIZ-05 결제 정산 (SD-04)

- 업무 주체: 외부 결제 시스템
- 업무 규칙:
  - INV-09 외부 시스템이 정산한다

## 3. 용어
`;

const DESIGN = `# 전술 설계

## 1. 모델 후보

| 요구 | 소유 모델 |
|---|---|
| BIZ-05 | 외부 시스템 |

## 4. Application Service

| AS | 이름 | 업무 |
|---|---|---|
| AS-01 | 계산기 이용 | BIZ-01 |
| AS-02 | 사용자 가입 | BIZ-02 |
| AS-03 | 사용자 로그인 | BIZ-02 |

## 5. 통합 설계
`;

const API = (rows) => `# API\n\n| Method / path | 요청 | 성공 응답 | 근거 |\n|---|---|---|---|\n${rows.join('\n')}\n`;
const GOOD_ROWS = ['| `POST /calculations` | `{ "operator": "add" \\| "divide" }` | `200` | AS-01 (BIZ-01) |', '| `POST /auth/signup` | 입력 | `201` | AS-02 (BIZ-02, INV-03) |', '| `POST /auth/login` | 입력 | `200` | AS-03 |'];
const DATA = '# 데이터\n\n| 소유 컨텍스트 | 저장 상태 | 최소 값 | 근거 |\n|---|---|---|---|\n| 사용자 인증 | 사용자 | 이메일 | AS-02, INV-03 |\n| 계산 | 없음 | - | - |\n';
const TECHNOLOGY = `| 항목 | 판정 | 결정·근거 |
|---|---|---|
| runtime | SETTLED | Node.js 22.x |
| language-build | SETTLED | JavaScript ESM, npm |
| server-api | SETTLED | node:http, node src/server.mjs |
| ui | NOT_APPLICABLE | 인증 API만 제공한다 |
| storage | SETTLED | PostgreSQL 18 |
| storage-access | SETTLED | pg 8 |
| migration | SETTLED | psql로 버전 관리 SQL을 적용한다 |
| transactions | SETTLED | pg PoolClient 단일 트랜잭션 |
| outbound | SETTLED | pg 8로 인증 Repository를 연결한다 |
| unit-test-tool | SETTLED | node:test |
| unit-test-cli | SETTLED | node --test |
`;
const PORT = 'UserRepository | save(user: User) → UserId | auth 도메인 | AS-02 Auth.signup | 저장 실패를 반환한다';
const CONTEXT_DESIGN = `# 전술 설계

<!-- tactical-design: context-components-v1 -->

## BC calculator

| AS | 메서드 | 업무 | 호출 순서 | 트랜잭션 경계 | 사용 인터페이스 |
|---|---|---|---|---|---|
| AS-01 | Calculator.calculate(input: Calculation) → Result | BIZ-01 | 계산한다 | 없음 — 읽기 | 없음 — 순수 계산 |

## BC auth

| AS | 메서드 | 업무 | 호출 순서 | 트랜잭션 경계 | 사용 인터페이스 |
|---|---|---|---|---|---|
| AS-02 | Auth.signup(input: Signup) → UserId | BIZ-02 | UserRepository.save(user) | T1: User — 저장 직전에 시작 | UserRepository |
| AS-03 | Auth.login(input: Credentials) → Session | BIZ-02 | 인증한다 | 없음 — 읽기 | 없음 — 기존 인증 사용 |

| 인터페이스 | 시그니처 | 소유 위치 | 사용 메서드 | 실패 계약 |
|---|---|---|---|---|
| ${PORT} |

## BC payment

| 모델 | 종류 | 업무 | 식별자 | 필드·구성 값 | 메서드 |
|---|---|---|---|---|---|
| Settlement | 외부 시스템 | BIZ-05 | settlementId | id: SettlementId | settle(input: Settlement) → Result |
`;
const DATA_WITH_BINDING = `${DATA}
## 인프라 바인딩

| 컨텍스트 | 인터페이스 | 시그니처 | 소유 위치 | 사용 메서드 | 실패 계약 | 인터페이스 경로 | 구현체 | 구현체 경로 | 기술·구현 선언 | 조립 위치 | 데이터 매핑 | 트랜잭션 공유 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| auth | ${PORT} | src/auth/domain/user-repository.ts | SqlUserRepository | src/auth/infra/sql-user-repository.ts | PostgreSQL INSERT users | src/server.ts의 wireAuth | User.email → users.email, 오류를 호출 실패로 변환 | AS-02의 T1 DbClient 공유 |
`;
const check = (documents) => checkDesignFreeze({ requirements: REQUIREMENTS, tacticalDesign: DESIGN, documents });
const found = (verdict) => verdict.errors.map((error) => [error.code, error.id, error.owner_stage]);

test('a fully traced design freezes, and tables that hold escaped pipes are still read', () => {
  assert.deepEqual(check({ api: API(GOOD_ROWS), data: DATA }), { ok: true, errors: [] });
  assert.deepEqual(check({}), { ok: true, errors: [] }, 'no API/UI/data tables: nothing to trace');
});

test('freeze requires concrete applicable stack decisions and a reason for omitted surfaces', () => {
  const documents = { api: API(GOOD_ROWS), data: DATA };
  const incomplete = TECHNOLOGY
    .replace('SETTLED | Node.js 22.x', 'UNRESOLVED | 애플리케이션이 없다')
    .replace('SETTLED | node:http, node src/server.mjs', 'NOT_APPLICABLE | 아직 framework를 선택하지 않았다')
    .replace('SETTLED | pg 8', 'SETTLED | 미정')
    .replace('SETTLED | node --test', 'SETTLED | -');
  assert.deepEqual(found(check({ ...documents, technology: incomplete })), ['runtime', 'server-api', 'storage-access', 'unit-test-cli'].map((area) => ['TECHNOLOGY_COVERAGE_INCOMPLETE', area, 'tactical-technology']));
  assert.deepEqual(found(check({ ...documents, technology: '# 미정\n' })), [['TECHNOLOGY_COVERAGE_MISSING', undefined, 'tactical-technology']]);
  assert.deepEqual(check({ ...documents, technology: TECHNOLOGY }), { ok: true, errors: [] });
  const frontendApproved = checkDesignFreeze({ requirements: REQUIREMENTS, tacticalDesign: DESIGN, documents: { ...documents, technology: TECHNOLOGY }, frontendApproved: true });
  assert.deepEqual(found(frontendApproved), [['TECHNOLOGY_COVERAGE_INCOMPLETE', 'ui', 'tactical-technology']]);
  const contextTechnology = TECHNOLOGY.replace('SETTLED | pg PoolClient 단일 트랜잭션', 'NOT_APPLICABLE | 트랜잭션이 없다')
    .replace('SETTLED | pg 8로 인증 Repository를 연결한다', 'NOT_APPLICABLE | 인터페이스가 없다');
  const components = checkDesignFreeze({ requirements: REQUIREMENTS, tacticalDesign: CONTEXT_DESIGN, documents: { api: API(GOOD_ROWS), data: DATA_WITH_BINDING, technology: contextTechnology } });
  assert.deepEqual(found(components), ['transactions', 'outbound'].map((area) => ['TECHNOLOGY_COVERAGE_INCOMPLETE', area, 'tactical-technology']));
});

test('context component design freezes with bindings for its actual outbound interfaces', () => {
  const checkComponents = (data, tacticalDesign = CONTEXT_DESIGN) => checkDesignFreeze({ requirements: REQUIREMENTS, tacticalDesign, documents: { api: API(GOOD_ROWS), data } });
  const bindingId = 'auth / UserRepository';
  assert.deepEqual(checkComponents(DATA_WITH_BINDING), { ok: true, errors: [] });
  assert.deepEqual(found(checkComponents(DATA)), [['INFRASTRUCTURE_BINDING_MISSING', bindingId, 'tactical-data']]);
  const incomplete = checkComponents(DATA_WITH_BINDING.replace('src/server.ts의 wireAuth', '미정'));
  assert.deepEqual(found(incomplete), [['INFRASTRUCTURE_BINDING_INCOMPLETE', bindingId, 'tactical-data']]);
  assert.match(incomplete.errors[0].message, /조립 위치/);
  assert.match(checkComponents(DATA_WITH_BINDING.replace('src/auth/infra/sql-user-repository.ts', '../infra/repository.ts')).errors[0].message, /구현체 경로/);
  assert.deepEqual(found(checkComponents(DATA_WITH_BINDING.replace('AS-02 Auth.signup', 'AS-03 Auth.login'))), [['INFRASTRUCTURE_BINDING_MISMATCH', bindingId, 'tactical-data']]);
  assert.match(checkComponents(DATA_WITH_BINDING.replace('save(user: User)', 'save(user: *User)')).errors[0].message, /시그니처/);
  const duplicate = DATA_WITH_BINDING.trim().split('\n').at(-1);
  assert.deepEqual(found(checkComponents(`${DATA_WITH_BINDING}${duplicate}\n`)), [['INFRASTRUCTURE_BINDING_DUPLICATE', bindingId, 'tactical-data']]);
  assert.deepEqual(found(checkComponents(`${DATA_WITH_BINDING}${duplicate.replace('UserRepository', 'NewPort')}\n`)), [['INFRASTRUCTURE_BINDING_UNDECLARED', 'auth / NewPort', 'tactical-data']]);
  const noPort = CONTEXT_DESIGN.replace(/^\| UserRepository .*\n/m, '').replace('UserRepository.save(user) | T1: User — 저장 직전에 시작 | UserRepository', '입력을 검증한다 | 없음 — 조회만 수행 | 없음 — 외부 호출 없음');
  assert.deepEqual(checkComponents('## 인프라 바인딩\n\n- 판정: 해당 없음 — 외부 호출 없이 계산한다.\n', noPort), { ok: true, errors: [] });
  assert.deepEqual(found(checkComponents('', noPort)), [['INFRASTRUCTURE_BINDING_MISSING', undefined, 'tactical-data']]);
  assert.deepEqual(found(checkComponents('\x60\x60\x60md\n## 인프라 바인딩\n\n- 판정: 해당 없음 — 예시\n\x60\x60\x60\n', noPort)), [['INFRASTRUCTURE_BINDING_MISSING', undefined, 'tactical-data']]);
});

test('an endpoint that no use case serves is UNTRACED_ITEM owned by tactical-api', () => {
  const invented = [...GOOD_ROWS, '| `POST /auth/logout` | 인증 정보 | `204` | BIZ-02 |', '| `GET /auth/session` | 인증 정보 | `200` | AS-09 |', '| `GET /admin` | - | `200` | INV-77 |'];
  const verdict = check({ api: API(invented), data: DATA });
  assert.equal(verdict.ok, false);
  assert.deepEqual(found(verdict), [['UNTRACED_ITEM', 'POST /auth/logout', 'tactical-api'], ['UNTRACED_ITEM', 'GET /auth/session', 'tactical-api'], ['UNTRACED_ITEM', 'GET /admin', 'tactical-api']]);
  assert.match(verdict.errors[1].message, /AS-09/);
});

test('a table without the 근거 column leaves every endpoint and stored entity untraced', () => {
  const api = '| Method / path | 요청 | 성공 응답 |\n|---|---|---|\n| `POST /calculations` | x | `200` |\n';
  const data = '| 소유 컨텍스트 | 저장 상태 |\n|---|---|\n| 사용자 인증 | 사용자 |\n| 계산 | 없음 — 저장 안 함 |\n';
  const verdict = check({ api, data });
  assert.deepEqual(found(verdict).filter(([code]) => code === 'UNTRACED_ITEM').map(([, id, owner]) => [id, owner]), [['POST /calculations', 'tactical-api'], ['사용자 인증 사용자', 'tactical-data']], 'the 없음 row is not an entity');
  assert.match(check({ api }).errors[0].message, /no `근거` column/);
});

test('a stored entity and a screen must cite a use case or a requirement that exists', () => {
  const data = DATA.replace('AS-02, INV-03', 'AS-42');
  const ui = '| 화면 | 근거 |\n|---|---|\n| 로그인 | AS-03 |\n| 설정 | - |\n';
  assert.deepEqual(found(check({ data, ui })), [['UNTRACED_ITEM', '설정', 'tactical-ui'], ['REQUIREMENT_UNCOVERED', 'BIZ-01', 'tactical-ui'], ['UNTRACED_ITEM', '사용자 인증 사용자', 'tactical-data']]);
});

test('a BIZ without a use case is REQUIREMENT_UNCOVERED owned by application-service, unless an external system owns it alone', () => {
  const without = DESIGN.replace(/^\| AS-0[23] .*\n/gm, '');
  const verdict = checkDesignFreeze({ requirements: REQUIREMENTS, tacticalDesign: without, documents: {} });
  assert.deepEqual(found(verdict), [['REQUIREMENT_UNCOVERED', 'BIZ-02', 'application-service']]);
});

test('a user-facing BIZ with use cases but no endpoint or screen is REQUIREMENT_UNCOVERED owned by tactical-api', () => {
  const verdict = check({ api: API(GOOD_ROWS.slice(0, 2)) });
  assert.deepEqual(found(verdict), []);
  const onlyCalculation = check({ api: API(GOOD_ROWS.slice(0, 1)) });
  assert.deepEqual(found(onlyCalculation), [['REQUIREMENT_UNCOVERED', 'BIZ-02', 'tactical-api']]);
});

test('the gate is run only by the runner on the completed result of tactical-data, and to-ticket does not start while it fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'design-freeze-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/specs/set'), { recursive: true });
  await mkdir(join(root, 'docs/implementation/set'), { recursive: true });
  await writeFile(join(root, 'docs/specs/set/requirements.md'), REQUIREMENTS);
  await writeFile(join(root, 'docs/specs/set/tactical-design.md'), DESIGN);
  const api = join(root, 'docs/implementation/set/api.md');
  const technology = join(root, 'docs/implementation/set/technology.md');
  await writeFile(technology, TECHNOLOGY);
  const input = (skill, planSetId = 'set') => ({ skill, context: planSetId ? { plan_set_id: planSetId } : {} });
  const completed = { status: 'completed', code: 'OK' };

  await writeFile(api, API([...GOOD_ROWS, '| `POST /auth/logout` | 인증 정보 | `204` | BIZ-02 |']));
  assert.equal(await designNotFrozen({ root, planSetId: 'set' }).then((message) => /^DESIGN_NOT_FROZEN: .*UNTRACED_ITEM POST \/auth\/logout \[tactical-api\]/.test(message)), true);
  const verdict = await evaluateDesignFreezeGate({ root, input: input('tactical-data'), envelope: completed });
  assert.deepEqual(found(verdict), [['UNTRACED_ITEM', 'POST /auth/logout', 'tactical-api']]);
  await assert.rejects(assertDesignFreezeGate({ root, input: input('tactical-data'), envelope: completed }), (error) => error instanceof DesignFreezeError && /^Design-freeze gate failed for tactical-data: UNTRACED_ITEM \(POST \/auth\/logout\) \[tactical-api\]/.test(error.message));
  assert.match(freezeFailureInstruction(verdict), /blocked \/ DEPENDENCY_INCOMPLETE with result\.owner_stage tactical-api/);
  assert.match(freezeFailureInstruction(verdict), /Never ask the user whether to include the item in scope/);
  assert.match(freezeFailureInstruction({ stage: 'tactical-data', errors: [{ owner_stage: 'tactical-data' }] }), /Repair your own document/);

  // Other stages, other statuses and a missing plan set never reach the gate.
  for (const stage of ['tactical-ui', 'context-boundary', 'to-ticket']) assert.equal(await evaluateDesignFreezeGate({ root, input: input(stage), envelope: completed }), null, stage);
  for (const envelope of [{ status: 'blocked', code: 'DEPENDENCY_INCOMPLETE' }, { status: 'action_required', code: 'USER_DECISION_REQUIRED' }]) assert.equal(await evaluateDesignFreezeGate({ root, input: input('tactical-data'), envelope }), null);
  assert.equal(await evaluateDesignFreezeGate({ root, input: input('tactical-data', null), envelope: completed }), null);

  await writeFile(api, API(GOOD_ROWS));
  assert.equal(await designNotFrozen({ root, planSetId: 'set' }), null);
  assert.deepEqual(await assertDesignFreezeGate({ root, input: input('tactical-data'), envelope: completed }), { stage: 'tactical-data', ok: true, errors: [] });

  // A plan set that skipped the requirements flow, or has no tactical design to trace to, has nothing to check.
  await rm(join(root, 'docs/specs/set/tactical-design.md'));
  await writeFile(api, API(['| `POST /anything` | - | `200` | - |']));
  assert.deepEqual(await checkWorkspaceDesignFreeze({ root, planSetId: 'set' }), { ok: true, skipped: true, errors: [] });
});

test('tactical-api fails its own stage on placeholders and missing requirement trace, without needing data.md or technology.md', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'design-freeze-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/specs/set'), { recursive: true });
  await mkdir(join(root, 'docs/implementation/set'), { recursive: true });
  await writeFile(join(root, 'docs/specs/set/requirements.md'), REQUIREMENTS);
  await writeFile(join(root, 'docs/specs/set/tactical-design.md'), DESIGN);
  const api = join(root, 'docs/implementation/set/api.md');
  const input = { skill: 'tactical-api', context: { plan_set_id: 'set' } };
  const completed = { status: 'completed', code: 'OK' };
  const run = (envelope = completed) => evaluateDesignFreezeGate({ root, input, envelope });

  await writeFile(api, `${API(GOOD_ROWS)}\n- region: unknown\n- identity 공급자 미정\n\`\`\`\nTBD in a fence is ignored\n\`\`\`\n`);
  const placeholders = await run();
  assert.deepEqual(placeholders.errors.map((error) => error.code), ['PLACEHOLDER_REMAINS', 'PLACEHOLDER_REMAINS']);
  assert.equal(placeholders.errors.every((error) => error.owner_stage === 'tactical-api'), true);
  await assert.rejects(assertDesignFreezeGate({ root, input, envelope: completed }), (error) => error instanceof DesignFreezeError && /Design-freeze gate failed for tactical-api/.test(error.message));
  assert.match(freezeFailureInstruction(placeholders), /Repair your own document \(api\.md\)/);

  await writeFile(api, `${API(GOOD_ROWS)}\n- 범위 밖: 요청 본문 크기 제한, CORS·CSRF 정책은 승인된 요구가 정하지 않아 미정\n- Non-goal: 운영 배포 방식 TBD\n`);
  assert.deepEqual(await run(), { stage: 'tactical-api', ok: true, errors: [] });
  await writeFile(api, `${API(GOOD_ROWS)}\n- 범위 밖: CORS 정책 미정\n- | region | unknown |\n- identity 공급자 미정\n`);
  assert.deepEqual((await run()).errors.map((error) => error.code), ['PLACEHOLDER_REMAINS', 'PLACEHOLDER_REMAINS']);

  await writeFile(api, API([...GOOD_ROWS, '| `POST /auth/logout` | 인증 정보 | `204` | BIZ-02 |']));
  assert.deepEqual(found(await run()), [['UNTRACED_ITEM', 'POST /auth/logout', 'tactical-api']]);
  await writeFile(api, API(GOOD_ROWS.slice(0, 1)));
  assert.deepEqual(found(await run()), [['REQUIREMENT_UNCOVERED', 'BIZ-02', 'tactical-api']]);

  await writeFile(api, API(GOOD_ROWS));
  assert.deepEqual(await run(), { stage: 'tactical-api', ok: true, errors: [] });
  assert.equal(await run({ status: 'blocked', code: 'DEPENDENCY_INCOMPLETE' }), null);
});

test('the command prints the verdict and fails the process on a failing design', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'design-freeze-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = { requirements: join(directory, 'requirements.md'), design: join(directory, 'tactical-design.md'), api: join(directory, 'api.md') };
  await writeFile(files.requirements, REQUIREMENTS);
  await writeFile(files.design, DESIGN);
  await writeFile(files.api, API(GOOD_ROWS));
  const run = () => spawnSync(process.execPath, [SCRIPT, '--requirements', files.requirements, '--tactical-design', files.design, '--api', files.api], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  await writeFile(files.api, API([...GOOD_ROWS, '| `GET /auth/session` | 인증 정보 | `200` | BIZ-02 |']));
  const failed = run();
  assert.equal(failed.status, 1);
  assert.deepEqual(JSON.parse(failed.stdout).errors.map((error) => [error.code, error.owner_stage]), [['UNTRACED_ITEM', 'tactical-api']]);
  const relative = spawnSync(process.execPath, [SCRIPT, '--workspace-root', 'relative'], { encoding: 'utf8' });
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /absolute path/);
});

test('to-ticket can identify an earlier owner for a design gap discovered during ticket splitting', () => {
  assert.equal(OWNER_REQUIRED_STAGES.includes('to-ticket'), true);
  const owned = dependencyOwnerErrors({ skill: 'to-ticket', raw: { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', result: { owner_stage: 'tactical-api', dependency_gap: 'GET /data-bundles is absent from api.md' } } });
  assert.equal(owned, null);
  assert.equal(dependencyOwnerErrors({ skill: 'to-ticket', raw: { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', result: {} } })[0].path, '$.result.owner_stage');
  assert.equal(dependencyOwnerErrors({ skill: 'to-ticket', raw: { status: 'blocked', code: 'INPUT_MISSING', result: {} } }), null);
  assert.equal(dependencyOwnerErrors({ skill: 'tactical-data', raw: { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', result: { owner_stage: 'tactical-api', dependency_gap: 'x' } } }), null);
});

test('the guidance forbids new scope in every tactical and implementation-design stage', async () => {
  const read = (path) => readFile(join(sourceRoot, path), 'utf8');
  const shared = await read('.harness/internal-skills/domain-model/references/deepening.md');
  assert.match(shared, /요구의 범위를 추가하지 않는다\.[\s\S]*범위 추가는 사용자가 요구사항 단계에서 결정한다/);
  for (const stage of ['domain-model', 'aggregate-design', 'domain-service', 'application-service', 'integration-design', 'context-boundary']) assert.match(await read(`.harness/internal-skills/${stage}/GUIDE.md`), /deepening\.md/, stage);
  for (const stage of ['tactical-technology', 'tactical-ui', 'tactical-api', 'tactical-data']) assert.match(await read(`.harness/internal-skills/${stage}/GUIDE.md`), /## 범위 추가 금지[\s\S]*범위 질문/, stage);
  assert.match(await read('.harness/internal-skills/tactical-api/GUIDE.md'), /`근거` 열[\s\S]*UNTRACED_ITEM/);
  const toTicket = await read('.harness/internal-skills/to-ticket/GUIDE.md');
  assert.match(toTicket, /DEPENDENCY_INCOMPLETE/);
  assert.match(toTicket, /orchestrator reopens the named owner/);
});

test('update restores the design-freeze gate of an installed consumer, Doctor requires it and Git ignores it', async (t) => {
  const { primary } = await consumerWorkflow(t, '계산기 웹 앱을 만든다');
  const git = (...args) => spawnSync('git', ['-C', primary, ...args], { encoding: 'utf8' }).stdout;
  const assets = [
    '.harness/src/workflow/design-freeze-gate.mjs',
    '.harness/scripts/harness-design-freeze-check.mjs',
    '.harness/internal-skills/tactical-data/GUIDE.md',
    '.harness/internal-skills/to-ticket/references/split.md',
  ];
  const projectFile = 'docs/contracts/README.md';
  await mkdir(join(primary, 'docs/contracts'), { recursive: true });
  await writeFile(join(primary, projectFile), '소비 프로젝트 계약\n');
  for (const path of assets) assert.equal(await readFile(join(primary, path), 'utf8'), await readFile(join(sourceRoot, path), 'utf8'), `a fresh install has ${path}`);
  const lockPath = join(primary, '.harness/harness-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  for (const path of assets) { await unlink(join(primary, path)); delete lock.files[path]; }
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const missing = (await runDoctor({ root: primary, sourceRoot })).diagnostics.filter((item) => item.code === 'execution_asset_missing').map((item) => item.path);
  for (const path of assets) assert.ok(missing.includes(join(primary, path)), `Doctor requires ${path}`);
  await updateProject({ sourceRoot, targetRoot: primary });
  for (const path of assets) {
    assert.ok(existsSync(join(primary, path)), `update installs ${path}`);
    assert.ok(JSON.parse(await readFile(lockPath, 'utf8')).files[path], `update records ${path}`);
    assert.match(git('check-ignore', '-v', path), /info\/exclude/);
  }
  assert.equal((await runDoctor({ root: primary, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  assert.equal(git('status', '--short', '--untracked-files=all').trim(), `?? ${projectFile}`, 'only the project-owned file appears in Git status');
  assert.equal(await readFile(join(primary, projectFile), 'utf8'), '소비 프로젝트 계약\n');
  for (const stage of ['tactical-api', 'tactical-data']) assert.match(await readFile(join(primary, `.harness/internal-skills/${stage}/GUIDE.md`), 'utf8'), /## 범위 추가 금지/, `the installed ${stage} guide forbids new scope`);
  assert.match(await readFile(join(primary, '.harness/internal-skills/domain-model/references/deepening.md'), 'utf8'), /요구의 범위를 추가하지 않는다/);
  const cli = (requirements, tacticalDesign, api, data) => {
    const args = ['--requirements', requirements, '--tactical-design', tacticalDesign, '--api', api, '--data', data].map((arg) => arg.startsWith('--') ? arg : join(primary, arg));
    return spawnSync(process.execPath, [join(primary, '.harness/scripts/harness-design-freeze-check.mjs'), ...args], { cwd: primary, encoding: 'utf8' });
  };
  const fixture = ['requirements.md', 'tactical-design.md', 'api.md', 'data.md'];
  for (const [index, content] of [REQUIREMENTS, CONTEXT_DESIGN, API(GOOD_ROWS), DATA_WITH_BINDING.replace('src/server.ts의 wireAuth', '-')].entries()) {
    await writeFile(join(primary, fixture[index]), content);
  }
  const incomplete = cli(...fixture);
  assert.equal(incomplete.status, 1, incomplete.stderr);
  assert.deepEqual(found(JSON.parse(incomplete.stdout)), [['INFRASTRUCTURE_BINDING_INCOMPLETE', 'auth / UserRepository', 'tactical-data']]);
  await writeFile(join(primary, 'data.md'), DATA_WITH_BINDING);
  const complete = cli(...fixture);
  assert.equal(complete.status, 0, complete.stderr);
  assert.deepEqual(JSON.parse(complete.stdout), { ok: true, errors: [] });
});

test('installed consumer: tactical-data must complete a binding, and to-ticket only starts on a frozen context component design', async (t) => {
  const flow = await consumerWorkflow(t, '커뮤니티 로그인을 구현한다');
  const { workspace, planSetId, treeGit, runStage, beginStage, submitStage, finishStage, invoke } = flow;
  await writeFile(join(workspace, '.harness/harness.yaml'), SETUP);
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  const prepare = (...args) => spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-prepare-input.mjs'), '--verbose', ...args], { cwd: workspace, encoding: 'utf8' });
  const seeded = await state();
  for (const stage of TACTICAL_DESIGN_STAGES) seeded.stages[stage] = { status: 'completed', code: 'OK', result_ref: `runtime/executions/${stage}/result.json` };
  await writeFile(statePath, JSON.stringify(seeded, null, 2) + '\n');
  const spec = `docs/specs/${planSetId}`;
  await mkdir(join(workspace, spec), { recursive: true });
  await writeFile(join(workspace, spec, 'requirements.md'), REQUIREMENTS);
  await writeFile(join(workspace, spec, 'tactical-design.md'), CONTEXT_DESIGN);
  treeGit('add', 'docs'); treeGit('commit', '-qm', 'design fixtures');
  const impl = `docs/implementation/${planSetId}`;
  const api = `${impl}/api.md`;
  const invented = API([...GOOD_ROWS, '| `POST /auth/logout` | 인증 정보 | `204` | BIZ-02 |']);
  const technology = `${impl}/technology.md`;
  await runStage('tactical-technology', { files: { [technology]: TECHNOLOGY } });
  await runStage('tactical-ui', { expectCommit: false });
  // tactical-api is rejected on its own stage for an untraced endpoint, and nothing is recorded.
  const apiStage = await beginStage('tactical-api');
  await submitStage(apiStage, { files: { [api]: invented }, summary: 'API 계약' });
  const apiRejected = finishStage(apiStage);
  assert.equal(apiRejected.status, 1, apiRejected.stdout);
  const apiVerdict = JSON.parse(apiRejected.stdout);
  assert.equal(apiVerdict.gate, 'design_freeze_check');
  assert.equal(apiVerdict.stage, 'tactical-api');
  assert.deepEqual(found(apiVerdict), [['UNTRACED_ITEM', 'POST /auth/logout', 'tactical-api']]);
  assert.equal((await state()).stages['tactical-api'].status, 'running', 'nothing was recorded');
  await submitStage(apiStage, { files: { [api]: `${API(GOOD_ROWS)}\n- 지역: 미정\n` }, summary: 'API 계약' });
  assert.deepEqual(found(JSON.parse(finishStage(apiStage).stdout)).map((item) => item[0]), ['PLACEHOLDER_REMAINS']);
  await submitStage(apiStage, { files: { [api]: API(GOOD_ROWS) }, summary: 'API 계약' });
  assert.equal(invoke(workspace, 'harness-native-stage.mjs', ['finish', ...apiStage.base]).code, 'OK');

  const binding = await beginStage('tactical-data');
  await submitStage(binding, { files: { [`${impl}/data.md`]: DATA }, summary: '데이터' });
  const missingBinding = finishStage(binding);
  assert.equal(missingBinding.status, 1, missingBinding.stdout);
  assert.deepEqual(found(JSON.parse(missingBinding.stdout)), [['INFRASTRUCTURE_BINDING_MISSING', 'auth / UserRepository', 'tactical-data']]);
  assert.equal((await state()).stages['tactical-data'].status, 'running');
  await submitStage(binding, { files: { [`${impl}/data.md`]: DATA_WITH_BINDING }, summary: '인프라 바인딩 확정' });
  assert.equal(invoke(workspace, 'harness-native-stage.mjs', ['finish', ...binding.base]).code, 'OK');
  assert.equal(invoke(workspace, 'harness-design-freeze-check.mjs', ['--workspace-root', workspace]).ok, true, 'the installed command agrees with the runner');

  // to-ticket starts on a frozen design, and not once a document changed to add scope after the freeze.
  await writeFile(join(workspace, api), invented);
  await writeFile(join(workspace, technology), TECHNOLOGY.replace('SETTLED | pg 8', 'PARTIAL | 드라이버 미정'));
  treeGit('add', 'docs'); treeGit('commit', '-qm', 'scope added after the freeze');
  const refused = prepare('--stage-id', 'to-ticket');
  assert.notEqual(refused.status, 0, refused.stdout);
  const explained = JSON.parse(refused.stderr.trim().split('\n').pop());
  assert.equal(explained.code, 'DESIGN_NOT_FROZEN', refused.stderr);
  assert.match(explained.why, /TECHNOLOGY_COVERAGE_INCOMPLETE storage-access \[tactical-technology\]/);
  assert.match(explained.why, /UNTRACED_ITEM POST \/auth\/logout \[tactical-api\]/);
  await writeFile(join(workspace, api), API(GOOD_ROWS));
  await writeFile(join(workspace, technology), TECHNOLOGY);
  treeGit('add', 'docs'); treeGit('commit', '-qm', 'scope removed');
  const started = await beginStage('to-ticket');
  assert.equal(started.prepared.input.skill, 'to-ticket');

  // A post-freeze decision gap found during decomposition returns to its API owner and revalidates tactical-data and to-ticket.
  await submitStage(started, { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: '사용자가 정한 조회 API가 설계에 없다', resultExtra: { owner_stage: 'tactical-api', dependency_gap: 'api.md에 사용자가 정한 GET /data-bundles와 GeoJSON 사각형 교차 규칙이 없다' } });
  const blockedTicket = invoke(workspace, 'harness-native-stage.mjs', ['finish', ...started.base]);
  assert.equal(blockedTicket.code, 'DEPENDENCY_INCOMPLETE');
  assert.match(blockedTicket.next, new RegExp(`launch --stage-id tactical-api --reopen-for ${started.prepared.input.execution_id}`));
  const reopenedTicketOwner = await beginStage('tactical-api', { extraArgs: ['--reopen-for', started.prepared.input.execution_id] });
  assert.equal(reopenedTicketOwner.prepared.input.context.reopen.blocked_stage, 'to-ticket');
  const staleState = await state();
  assert.ok(staleState.stages['tactical-data'].stale);
  assert.ok(staleState.stages['to-ticket'].stale);
});
