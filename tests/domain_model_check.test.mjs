import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TACTICAL_STAGE_LEVEL, checkDomainModel, parseRequirements, parseTables } from '../.codex/scripts/harness-domain-model-check.mjs';
import { TACTICAL_DESIGN_STAGES } from '../.harness/src/workflow/worktree-stages.mjs';
import { TacticalGateError, assertTacticalDesignGate, checkWorkspaceDomainModel, evaluateTacticalDesignGate, stakeholderAnalysisSkipped } from '../.harness/src/workflow/domain-model-gate.mjs';
import { REQUIREMENTS, templateDocument as loadTemplate, upTo } from './support/domain-model-fixture.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(sourceRoot, '.codex/scripts/harness-domain-model-check.mjs');
const STAGES = Object.keys(TACTICAL_STAGE_LEVEL);

const templateDocument = () => loadTemplate(sourceRoot);

const change = (document, from, to) => { assert.ok(document.includes(from), `fixture text exists: ${from}`); return document.replace(from, to); };
const codes = (verdict) => verdict.errors.map((error) => error.code);
const run = (document, stage, requirements = REQUIREMENTS) => checkDomainModel({ requirements, domainModel: upTo(document, TACTICAL_STAGE_LEVEL[stage]), stage });
const failing = (document, stage, code, requirements) => { const verdict = run(document, stage, requirements); assert.equal(verdict.ok, false, `${stage} fails with ${code}`); assert.ok(codes(verdict).includes(code), `${stage} reports ${code}, got ${codes(verdict)}`); return verdict; };

test('the gate knows exactly the tactical design stages of the flow', () => {
  assert.deepEqual(STAGES, [...TACTICAL_DESIGN_STAGES]);
  assert.deepEqual(Object.values(TACTICAL_STAGE_LEVEL), [1, 2, 3, 4, 5]);
  assert.throws(() => checkDomainModel({ requirements: REQUIREMENTS, domainModel: '', stage: 'spec-me' }), /Unknown tactical design stage/);
});

test('the requirements parser reads BIZ headings and the INV and EX bullets, not AC lines', () => {
  assert.deepEqual(parseRequirements(REQUIREMENTS), { business: ['BIZ-01', 'BIZ-02', 'BIZ-03', 'BIZ-04'], rules: ['INV-01', 'EX-01', 'INV-02', 'INV-03', 'INV-04'] });
  assert.deepEqual(parseTables('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n\n| 열 | 값 |\n|:--|--:|\n| x | - |\n| - | - |\n'), [{ header: ['열', '값'], rows: [{ 열: 'x', 값: '-' }] }], 'fenced tables are ignored and an empty row is dropped');
});

test('the template example passes the gate at every stage, so the template and the gate cannot drift apart', async () => {
  const document = await templateDocument();
  for (const stage of STAGES) assert.deepEqual(run(document, stage), { ok: true, stage, level: TACTICAL_STAGE_LEVEL[stage], errors: [] }, stage);
});

test('domain-model: every BIZ maps to a model or an external-system marker and every INV and EX has an owning model', async () => {
  const document = await templateDocument();
  failing(change(document, '| BIZ-03 | 신고 | 신고 | 신고를 접수한다 |\n', ''), 'domain-model', 'BIZ_UNMAPPED');
  failing(change(document, '| INV-04 | 신고 | 신고 | 같은 회원의 같은 글 신고를 막는다 |\n', ''), 'domain-model', 'RULE_NO_OWNER');
  failing(change(document, '| EX-01 | 인증 | 인증 시스템 |', '| EX-01 | 인증 | - |'), 'domain-model', 'RULE_NO_OWNER');
  failing(change(document, '| BIZ-02 | 커뮤니티 | 게시글 |', '| BIZ-02 | 커뮤니티 | 게시물 |'), 'domain-model', 'UNKNOWN_MODEL');
  failing(change(document, '| BIZ-04 | 인증 | 인증 시스템 |', '| BIZ-04 | 인증 | 인증 시스템, 로그인 기록 |'), 'domain-model', 'UNKNOWN_MODEL');
  failing(change(document, '| 본문 | Value Object |', '| 본문 | Value Obj |'), 'domain-model', 'MODEL_KIND_INVALID');
  failing(change(document, '| 신고 | Entity | 신고 |', '| 게시글 | Entity | 신고 |'), 'domain-model', 'MODEL_DUPLICATE');
  failing(change(document, '| INV-04 | 신고 | 신고 |', '| INV-09 | 신고 | 신고 |'), 'domain-model', 'UNKNOWN_REQUIREMENT');
  failing(document, 'domain-model', 'BIZ_UNMAPPED', `${REQUIREMENTS}\n### BIZ-05 신고 취소 (SD-02)\n`);
  failing(document, 'domain-model', 'RULE_NO_OWNER', REQUIREMENTS.replace('- 업무 규칙: 없음', '- 업무 규칙:\n  - EX-07 취소는 접수 뒤 한 시간 안에만 된다'));
  // An external system owns what the requirements hand to it, so a generic subdomain needs no model of its own.
  assert.equal(run(document, 'domain-model').ok, true);
  // The record of this stage's decisions is part of the gate.
  failing(change(document, '| DEC-01 | domain-model |', '| DEC-01 | domain-service |'), 'domain-model', 'NO_DECISION_RECORD');
  failing(change(document, '| 새 게시물 모델 | `src/community/post.ts:12`, BIZ-01 |', '| 새 게시물 모델 | - |'), 'domain-model', 'DECISION_RECORD_NO_SOURCE');
  failing('# 도메인 모델\n', 'domain-model', 'SECTION_MISSING');
});

test('aggregate-design: every rule has an enforcing behaviour and every cross-aggregate rule a consistency decision with a source', async () => {
  const document = await templateDocument();
  failing(change(document, '| INV-02 | 게시글 | `게시글.삭제()` | Aggregate 안 |\n', ''), 'aggregate-design', 'RULE_NO_ENFORCEMENT');
  failing(change(document, '| INV-02 | 게시글 | `게시글.삭제()` |', '| INV-02 | 게시글 | `게시글.숨기기()` |'), 'aggregate-design', 'RULE_NO_ENFORCEMENT');
  failing(change(document, '| EX-01 | - | 외부 시스템: 인증 시스템 |', '| EX-01 | - | 외부 시스템: 신고 |'), 'aggregate-design', 'EXTERNAL_ENFORCEMENT_INVALID');
  // A rule that spans Aggregates needs a decision; hiding it behind one Aggregate or naming no decision both fail.
  failing(change(document, '| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | CON-01 |', '| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | Aggregate 안 |'), 'aggregate-design', 'CROSS_AGGREGATE_NO_DECISION');
  failing(change(document, '| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | CON-01 |', '| INV-03 | 게시글 | `게시글.삭제()` | Aggregate 안 |'), 'aggregate-design', 'RULE_AGGREGATE_MISMATCH');
  failing(change(document, '| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | CON-01 |', '| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | CON-09 |'), 'aggregate-design', 'UNKNOWN_DECISION');
  failing(change(document, '| CON-01 | INV-03 |', '| CON-01 | INV-02 |'), 'aggregate-design', 'DECISION_RULE_MISMATCH');
  // The source of a consistency decision is the user or the requirements, never an agent proposal alone.
  failing(change(document, '| 최종 | 분리: 게시글이 삭제된 뒤 신고를 닫는다. 삭제는 신고가 닫히기를 기다리지 않는다 | answers.json `<question_id>` |', '| 최종 | 분리: 게시글이 삭제된 뒤 신고를 닫는다. 삭제는 신고가 닫히기를 기다리지 않는다 | 요청 해석(에이전트 제안) |'), 'aggregate-design', 'DECISION_NO_SOURCE');
  failing(change(document, '| 최종 | 분리: 게시글이 삭제된 뒤 신고를 닫는다. 삭제는 신고가 닫히기를 기다리지 않는다 | answers.json `<question_id>` |', '| 최종 | 분리: 게시글이 삭제된 뒤 신고를 닫는다. 삭제는 신고가 닫히기를 기다리지 않는다 | |'), 'aggregate-design', 'DECISION_NO_SOURCE');
  assert.equal(run(change(document, 'answers.json `<question_id>` |\n\n`일관성`은', 'INV-03 |\n\n`일관성`은'), 'aggregate-design').ok, true, 'a requirements ID is a source too');
  failing(change(document, '| 게시글, 신고 | 최종 |', '| 게시글 | 최종 |'), 'aggregate-design', 'EVENTUAL_NOT_SEPARATE');
  failing(change(document, '| 게시글, 신고 | 최종 |', '| 게시글, 신고 | 거의 즉시 |'), 'aggregate-design', 'DECISION_KIND_INVALID');
  failing(change(document, '| 게시글, 신고 | 최종 |', '| 게시글, 신고 | 즉시 |'), 'aggregate-design', 'IMMEDIATE_NOT_MERGED');
  // Immediate consistency merges: the Aggregates become one and the rows say so.
  const merged = change(change(change(change(document, '| 게시글, 신고 | 최종 | 분리: 게시글이 삭제된 뒤 신고를 닫는다. 삭제는 신고가 닫히기를 기다리지 않는다 |', '| 게시글 | 즉시 | 병합: 신고를 게시글 Aggregate에 넣어 한 번에 바꾼다 |'), '| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | CON-01 |', '| INV-03 | 게시글 | `게시글.삭제()` | CON-01 |'), '| 신고 | 신고 | 신고 | 신고 ID | 신고 | `신고.접수()`, `신고.닫기()` | 대상은 게시글 ID로만 가진다 |\n', ''), '| 게시글 | 커뮤니티 | 게시글 | 게시글 ID | 게시글, 본문 |', '| 게시글 | 커뮤니티 | 게시글 | 게시글 ID | 게시글, 본문, 신고 |');
  failing(merged, 'aggregate-design', 'RULE_AGGREGATE_MISMATCH');
  // Aggregate structure: one Aggregate per Entity, an Entity root, declared members.
  failing(change(document, '| 신고 | 신고 | 신고 | 신고 ID | 신고 |', '| 신고 | 신고 | 신고 | 신고 ID | 게시글 |'), 'aggregate-design', 'ENTITY_IN_SEVERAL_AGGREGATES');
  failing(change(document, '| 신고 | 신고 | 신고 | 신고 ID | 신고 | `신고.접수()`, `신고.닫기()` | 대상은 게시글 ID로만 가진다 |\n', ''), 'aggregate-design', 'ENTITY_UNPLACED');
  failing(change(document, '| 게시글 | 커뮤니티 | 게시글 | 게시글 ID | 게시글, 본문 |', '| 게시글 | 커뮤니티 | 본문 | 게시글 ID | 게시글, 본문 |'), 'aggregate-design', 'ROOT_NOT_ENTITY');
  failing(change(document, '| 게시글 | 커뮤니티 | 게시글 | 게시글 ID | 게시글, 본문 |', '| 게시글 | 커뮤니티 | 게시글 | 게시글 ID | 게시글, 첨부 |'), 'aggregate-design', 'UNKNOWN_MODEL');
  failing(change(document, '| INV-04 | 신고 | Domain Service |', '| INV-04 | 신고, 쓰레기 | Domain Service |'), 'aggregate-design', 'UNKNOWN_AGGREGATE');
  // The gate is cumulative: a hole in section 1 still fails every later stage.
  const hole = change(document, '| BIZ-03 | 신고 | 신고 | 신고를 접수한다 |\n', '');
  for (const stage of STAGES) failing(hole, stage, 'BIZ_UNMAPPED');
});

test('domain-service: every rule handed over has a service and no service takes a rule an Aggregate enforces', async () => {
  const document = await templateDocument();
  failing(document.replace(/^\| DS-01 .*\n/m, ''), 'domain-service', 'DOMAIN_SERVICE_MISSING');
  failing(change(document, '| 신고 | INV-04 | `중복 신고 판정.판정()` |', '| 신고 | INV-01 | `중복 신고 판정.판정()` |'), 'domain-service', 'DOMAIN_SERVICE_REDUNDANT');
  failing(change(document, '| 신고 | INV-04 | `중복 신고 판정.판정()` |', '| 신고 | INV-04 | - |'), 'domain-service', 'SERVICE_NO_BEHAVIOR');
  failing(change(document, '| 신고 | INV-04 |', '| 신고 | - |'), 'domain-service', 'SERVICE_NO_RULE');
  failing(change(document, '| 신고 | INV-04 |', '| 신고 | INV-77 |'), 'domain-service', 'UNKNOWN_REQUIREMENT');
  failing(upTo(document, 2), 'domain-service', 'SECTION_MISSING');
  // A plan set may need no Domain Service when every rule has an Aggregate behaviour.
  const noService = change(change(document, '| INV-04 | 신고 | Domain Service |', '| INV-04 | 신고 | `신고.접수()` |'), /\| DS-01 .*\n/.exec(document)[0], '').replace('| DS | 이름 |', '해당 없음 — 모든 규칙을 Aggregate 행위가 강제한다\n\n| DS | 이름 |');
  assert.equal(run(noService, 'domain-service').ok, true);
  failing(change(noService, '| INV-04 | 신고 | `신고.접수()` |', '| INV-04 | 신고 | Domain Service |'), 'domain-service', 'DOMAIN_SERVICE_MISSING');
});

test('application-service: every business activity has a use case and every transaction changes one Aggregate', async () => {
  const document = await templateDocument();
  failing(change(document, '| 신고 | BIZ-03 |', '| 신고 | BIZ-09 |'), 'application-service', 'BIZ_NO_APPLICATION_SERVICE');
  failing(change(document, '| T1: 신고 | 신고 |', '| T1: 신고, 게시글 | 신고 |'), 'application-service', 'MULTI_AGGREGATE_TRANSACTION');
  failing(change(document, '| T1: 신고 | 신고 |', '| T1: 쓰레기 | 신고 |'), 'application-service', 'MULTI_AGGREGATE_TRANSACTION');
  failing(change(document, '| T1: 게시글 | 게시글 | 게시글이 삭제됨 이벤트 |', '| T1: 게시글; T2: 신고 (CON-09) | 게시글 | 게시글이 삭제됨 이벤트 |'), 'application-service', 'TRANSACTION_CONSISTENCY_INVALID');
  failing(change(document, '| T1: 게시글 | 게시글 | 없음 |\n| AS-02', '| | 게시글 | 없음 |\n| AS-02'), 'application-service', 'TRANSACTION_MISSING');
  assert.equal(run(change(document, '| T1: 게시글 | 게시글 | 없음 |\n| AS-02', '| 없음 — 조회만 한다 | 게시글 | 없음 |\n| AS-02'), 'application-service').ok, true);
  // The business activity that only an external system serves needs no use case.
  assert.equal(run(document, 'application-service').ok, true);
});

test('integration-design: Saga and Outbox appear only for eventual consistency and every cross-context decision is integrated', async () => {
  const document = await templateDocument();
  failing(change(document, '| 비동기 이벤트 | CON-01 |', '| 비동기 이벤트 | - |'), 'integration-design', 'CROSS_CONTEXT_NOT_INTEGRATED');
  failing(change(document, '| CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |', '| - | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |'), 'integration-design', 'SAGA_WITHOUT_EVENTUAL');
  failing(change(document, '| CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |', '| CON-01 | |'), 'integration-design', 'SAGA_OUTBOX_UNCONSIDERED');
  failing(change(document, '| CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |', '| CON-05 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |'), 'integration-design', 'UNKNOWN_DECISION');
  failing(change(document, '| 커뮤니티 | 신고 | 없음 | 없음 | 게시글이 삭제됨 | 비동기 이벤트 |', '| 커뮤니티 | 신고 | 없음 | 없음 | 게시글이 삭제됨 | |'), 'integration-design', 'INTEGRATION_INCOMPLETE');
  failing(document.replace(/^\| INT-01 .*\n/m, ''), 'integration-design', 'CROSS_CONTEXT_NOT_INTEGRATED');
  // A plan set with no cross-context decision and no relationship says so.
  const single = change(document, '| 신고 | 신고 | 신고 | 신고 ID |', '| 신고 | 커뮤니티 | 신고 | 신고 ID |').replace(/^\| INT-01 .*\n/m, '').replace('| INT | 상류 BC |', '해당 없음 — 컨텍스트 하나다\n\n| INT | 상류 BC |');
  assert.equal(run(single, 'integration-design').ok, true);
  // Saga or Outbox on a row without an eventual-consistency decision is refused even for a plausible integration.
  const withoutSaga = change(document, '| CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |', '| CON-01 | 없음 — 이벤트를 곧바로 발행한다 |');
  assert.equal(run(withoutSaga, 'integration-design').ok, true, 'a considered and rejected Saga/Outbox is a valid record');
});

test('the gate command reads the two documents, prints the verdict and fails the process on a failing gate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'domain-model-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const document = await templateDocument();
  await writeFile(join(directory, 'requirements.md'), REQUIREMENTS);
  await writeFile(join(directory, 'domain-model.md'), upTo(document, 3));
  const run = (stage) => spawnSync(process.execPath, [SCRIPT, '--stage', stage, '--requirements', join(directory, 'requirements.md'), '--domain-model', join(directory, 'domain-model.md')], { encoding: 'utf8' });
  const passed = run('domain-service');
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(JSON.parse(passed.stdout), { ok: true, stage: 'domain-service', level: 3, errors: [] });
  const failed = run('application-service');
  assert.equal(failed.status, 1);
  assert.deepEqual(JSON.parse(failed.stdout).errors.map((error) => error.code), ['SECTION_MISSING']);
  const unknown = run('spec-me');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /--stage must be one of domain-model, aggregate-design/);
  const relative = spawnSync(process.execPath, [SCRIPT, '--stage', 'domain-model', '--workspace-root', 'relative/path'], { encoding: 'utf8' });
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /absolute path/);
});

// The runner side of the gate: the documents of a workspace's plan set, and the verdict on a result that claims completion.
async function planSetWorkspace(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'domain-model-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/specs/set'), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, 'docs/specs/set', name), content);
  return root;
}
const completed = { status: 'completed', code: 'OK' };

test('the runner gate checks the plan set documents of a workspace and reports a missing document instead of throwing', async (t) => {
  const document = await templateDocument();
  const root = await planSetWorkspace(t, { 'requirements.md': REQUIREMENTS, 'domain-model.md': upTo(document, 2) });
  assert.deepEqual(await checkWorkspaceDomainModel({ root, planSetId: 'set', stage: 'aggregate-design' }), { ok: true, stage: 'aggregate-design', level: 2, errors: [] });
  const failing = await checkWorkspaceDomainModel({ root, planSetId: 'set', stage: 'application-service' });
  assert.equal(failing.ok, false);
  assert.deepEqual(codes(failing), ['SECTION_MISSING', 'SECTION_MISSING']);
  await assert.rejects(checkWorkspaceDomainModel({ root, planSetId: 'set', stage: 'spec-me' }), /Unknown tactical design stage/);

  const empty = await planSetWorkspace(t, {});
  const missing = await checkWorkspaceDomainModel({ root: empty, planSetId: 'set', stage: 'domain-model' });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.errors.map((error) => error.code), ['DOCUMENT_MISSING', 'DOCUMENT_MISSING']);
  assert.match(missing.errors[0].message, /docs\/specs\/set\/requirements\.md does not exist/);
  assert.match(missing.errors[1].message, /docs\/specs\/set\/domain-model\.md does not exist/);
});

test('only a stakeholder-analysis that decided to skip lets the tactical gate pass without documents', async (t) => {
  assert.equal(stakeholderAnalysisSkipped('## 2. 판정\n\n- 판정: 생략\n- 사유: 기존 Spec 안의 변경\n'), true);
  assert.equal(stakeholderAnalysisSkipped('판정: 생략\n'), true);
  for (const text of ['- 판정: 실행\n', '- 판정: 실행 | 생략\n', '- 판정: 생략하지 않는다\n', '판정을 생략으로 적지 않았다\n', '']) assert.equal(stakeholderAnalysisSkipped(text), false, text);
  const skipped = await planSetWorkspace(t, { 'stakeholder-analysis.md': '# Stakeholder 분석\n\n- 판정: 생략\n' });
  for (const stage of STAGES) assert.deepEqual(await checkWorkspaceDomainModel({ root: skipped, planSetId: 'set', stage }), { ok: true, stage, level: TACTICAL_STAGE_LEVEL[stage], skipped: true, errors: [] });
  const executed = await planSetWorkspace(t, { 'stakeholder-analysis.md': '# Stakeholder 분석\n\n- 판정: 실행\n' });
  assert.deepEqual((await checkWorkspaceDomainModel({ root: executed, planSetId: 'set', stage: 'domain-model' })).errors.map((error) => error.code), ['DOCUMENT_MISSING', 'DOCUMENT_MISSING']);
});

test('the runner accepts a completed result only when the gate passes, and leaves every other result alone', async (t) => {
  const document = await templateDocument();
  const input = (skill, planSetId = 'set') => ({ skill, context: planSetId ? { plan_set_id: planSetId } : {} });
  const failingDocument = upTo(document, 2).replace(/^(\| CON-01 \|.*\| )answers\.json `<question_id>` \|$/m, '$1에이전트 제안 |');
  assert.notEqual(failingDocument, upTo(document, 2));
  const root = await planSetWorkspace(t, { 'requirements.md': REQUIREMENTS, 'domain-model.md': failingDocument });

  const verdict = await evaluateTacticalDesignGate({ root, input: input('aggregate-design'), envelope: completed });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.errors.map((error) => [error.code, error.id]), [['DECISION_NO_SOURCE', 'CON-01']]);
  await assert.rejects(assertTacticalDesignGate({ root, input: input('aggregate-design'), envelope: completed }), (error) => {
    assert.ok(error instanceof TacticalGateError);
    assert.deepEqual(error.verdict, verdict);
    assert.match(error.message, /^Tactical design gate failed for aggregate-design: DECISION_NO_SOURCE \(CON-01\) CON-01 has no source/);
    return true;
  });

  // The gate decides only a completed result of a tactical stage that belongs to a plan set; blocks and questions are never gated.
  for (const envelope of [{ status: 'blocked', code: 'INPUT_MISSING' }, { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE' }, { status: 'action_required', code: 'USER_DECISION_REQUIRED' }, { status: 'failed', code: 'EXECUTION_ERROR' }]) assert.equal(await evaluateTacticalDesignGate({ root, input: input('aggregate-design'), envelope }), null, envelope.code);
  assert.equal(await evaluateTacticalDesignGate({ root, input: input('requirements-fix'), envelope: completed }), null, 'another stage');
  assert.equal(await evaluateTacticalDesignGate({ root, input: input('aggregate-design', null), envelope: completed }), null, 'no plan set');
  assert.equal(await assertTacticalDesignGate({ root, input: input('spec-me'), envelope: completed }), null);

  // Each stage is checked at its own level: the same document passes the stage that owns less of it.
  assert.equal((await assertTacticalDesignGate({ root, input: input('domain-model'), envelope: completed })).ok, true);
  await writeFile(join(root, 'docs/specs/set/domain-model.md'), upTo(document, 2));
  assert.equal((await assertTacticalDesignGate({ root, input: input('aggregate-design'), envelope: completed })).ok, true);
});

test('the runner gate refuses a document that is a symlink out of the workspace', async (t) => {
  const document = await templateDocument();
  const root = await planSetWorkspace(t, { 'requirements.md': REQUIREMENTS });
  const outside = await planSetWorkspace(t, { 'domain-model.md': upTo(document, 1) });
  await symlink(join(outside, 'docs/specs/set/domain-model.md'), join(root, 'docs/specs/set/domain-model.md'));
  await assert.rejects(assertTacticalDesignGate({ root, input: { skill: 'domain-model', context: { plan_set_id: 'set' } }, envelope: completed }), /outside case workspace/);
});
