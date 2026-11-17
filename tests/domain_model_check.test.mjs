import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTacticalDesign, parseRequirements, parseTables } from '../.codex/scripts/harness-domain-model-check.mjs';
import { TACTICAL_DESIGN_STAGES } from '../.harness/src/workflow/worktree-stages.mjs';
import { FINAL_TACTICAL_STAGE, TacticalGateError, assertTacticalDesignGate, checkWorkspaceTacticalDesign, evaluateTacticalDesignGate, gateFailureInstruction, stakeholderAnalysisSkipped } from '../.harness/src/workflow/domain-model-gate.mjs';
import { REQUIREMENTS, STATELESS_DOCUMENT, STATELESS_REQUIREMENTS, templateDocument as loadTemplate, upTo } from './support/domain-model-fixture.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(sourceRoot, '.codex/scripts/harness-domain-model-check.mjs');
const [DOMAIN_MODEL, AGGREGATE_DESIGN, DOMAIN_SERVICE, APPLICATION_SERVICE, INTEGRATION_DESIGN] = TACTICAL_DESIGN_STAGES;

const templateDocument = () => loadTemplate(sourceRoot);

const change = (document, from, to) => { assert.ok(document.includes(from), `fixture text exists: ${from}`); return document.replace(from, to); };
const codes = (verdict) => verdict.errors.map((error) => error.code);
// The gate always reads the whole document; `owner` is the stage whose section the finding must point at.
const run = (document, requirements = REQUIREMENTS) => checkTacticalDesign({ requirements, tacticalDesign: document });
const failing = (document, code, owner, requirements) => {
  const verdict = run(document, requirements);
  assert.equal(verdict.ok, false, `fails with ${code}`);
  const found = verdict.errors.filter((error) => error.code === code);
  assert.ok(found.length, `reports ${code}, got ${codes(verdict)}`);
  if (owner) assert.ok(found.some((error) => error.owner_stage === owner), `${code} is owned by ${owner}, got ${found.map((error) => error.owner_stage)}`);
  return verdict;
};

test('the gate is one check of the whole document, owned by the last tactical stage of the flow', () => {
  assert.equal(FINAL_TACTICAL_STAGE, INTEGRATION_DESIGN);
  assert.equal(FINAL_TACTICAL_STAGE, TACTICAL_DESIGN_STAGES.at(-1));
  assert.deepEqual(TACTICAL_DESIGN_STAGES, ['domain-model', 'aggregate-design', 'domain-service', 'application-service', 'integration-design']);
});

test('the requirements parser reads BIZ headings and the INV and EX bullets, not AC lines', () => {
  assert.deepEqual(parseRequirements(REQUIREMENTS), { business: ['BIZ-01', 'BIZ-02', 'BIZ-03', 'BIZ-04'], rules: ['INV-01', 'EX-01', 'INV-02', 'INV-03', 'INV-04'] });
  assert.deepEqual(parseTables('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n\n| 열 | 값 |\n|:--|--:|\n| x | - |\n| - | - |\n'), [{ header: ['열', '값'], rows: [{ 열: 'x', 값: '-' }] }], 'fenced tables are ignored and an empty row is dropped');
});

test('the template example passes the gate, so the template and the gate cannot drift apart', async () => {
  const document = await templateDocument();
  assert.deepEqual(run(document), { ok: true, errors: [] });
});

test('domain-model section: every BIZ maps to a model or an external-system marker and every INV and EX has an owning model', async () => {
  const document = await templateDocument();
  failing(change(document, '| BIZ-03 | 신고 | 신고 | 신고를 접수한다 |\n', ''), 'BIZ_UNMAPPED', DOMAIN_MODEL);
  failing(change(document, '| INV-04 | 신고 | 신고 | 같은 회원의 같은 글 신고를 막는다 |\n', ''), 'RULE_NO_OWNER', DOMAIN_MODEL);
  failing(change(document, '| EX-01 | 인증 | 인증 시스템 |', '| EX-01 | 인증 | - |'), 'RULE_NO_OWNER', DOMAIN_MODEL);
  failing(change(document, '| BIZ-02 | 커뮤니티 | 게시글 |', '| BIZ-02 | 커뮤니티 | 게시물 |'), 'UNKNOWN_MODEL', DOMAIN_MODEL);
  failing(change(document, '| BIZ-04 | 인증 | 인증 시스템 |', '| BIZ-04 | 인증 | 인증 시스템, 로그인 기록 |'), 'UNKNOWN_MODEL', DOMAIN_MODEL);
  failing(change(document, '| 본문 | Value Object |', '| 본문 | Value Obj |'), 'MODEL_KIND_INVALID', DOMAIN_MODEL);
  failing(change(document, '| 신고 | Entity | 신고 |', '| 게시글 | Entity | 신고 |'), 'MODEL_DUPLICATE', DOMAIN_MODEL);
  failing(change(document, '| INV-04 | 신고 | 신고 |', '| INV-09 | 신고 | 신고 |'), 'UNKNOWN_REQUIREMENT', DOMAIN_MODEL);
  failing(document, 'BIZ_UNMAPPED', DOMAIN_MODEL, `${REQUIREMENTS}\n### BIZ-05 신고 취소 (SD-02)\n`);
  failing(document, 'RULE_NO_OWNER', DOMAIN_MODEL, REQUIREMENTS.replace('- 업무 규칙: 없음', '- 업무 규칙:\n  - EX-07 취소는 접수 뒤 한 시간 안에만 된다'));
  // An external system owns what the requirements hand to it, so a generic subdomain needs no model of its own.
  assert.equal(run(document).ok, true);
});

test('decision history: every stage records a decision with a source, and a missing one names the stage that owes it', async () => {
  const document = await templateDocument();
  failing(change(document, '| DEC-01 | domain-model |', '| DEC-01 | domain-service |'), 'NO_DECISION_RECORD', DOMAIN_MODEL);
  failing(change(document, '| DEC-04 | application-service |', '| DEC-04 | domain-service |'), 'NO_DECISION_RECORD', APPLICATION_SERVICE);
  failing(change(document, '| 새 게시물 모델 | `src/community/post.ts:12`, BIZ-01 |', '| 새 게시물 모델 | - |'), 'DECISION_RECORD_NO_SOURCE', DOMAIN_MODEL);
  failing(change(document, '| 이벤트로 전달한다 | 동기 호출 | answers.json `<question_id>`, CONTEXT-MAP.md `## 3` |', '| 이벤트로 전달한다 | 동기 호출 | |'), 'DECISION_RECORD_NO_SOURCE', INTEGRATION_DESIGN);
  assert.deepEqual(run(document.split('## 6.')[0]).errors.map((error) => [error.code, error.owner_stage]), TACTICAL_DESIGN_STAGES.map((stage) => ['NO_DECISION_RECORD', stage]), 'a document without section 6 owes a record from every stage');
});

test('a document that misses sections reports each missing section against the stage that fills it', async () => {
  const document = await templateDocument();
  assert.deepEqual(run('# 전술 설계\n').errors.map((error) => [error.code, error.owner_stage]), TACTICAL_DESIGN_STAGES.map((stage) => ['SECTION_MISSING', stage]));
  assert.deepEqual(run(upTo(document, 3)).errors.map((error) => [error.code, error.owner_stage]), [['SECTION_MISSING', APPLICATION_SERVICE], ['SECTION_MISSING', INTEGRATION_DESIGN]]);
  assert.deepEqual(run(upTo(document, 2)).errors.map((error) => error.owner_stage), [DOMAIN_SERVICE, APPLICATION_SERVICE, INTEGRATION_DESIGN]);
});

test('aggregate-design section: every rule has an enforcing behaviour and every cross-aggregate rule a consistency decision with a source', async () => {
  const document = await templateDocument();
  failing(change(document, '| INV-02 | 게시글 | `게시글.삭제()` | Aggregate 안 |\n', ''), 'RULE_NO_ENFORCEMENT', AGGREGATE_DESIGN);
  failing(change(document, '| INV-02 | 게시글 | `게시글.삭제()` |', '| INV-02 | 게시글 | `게시글.숨기기()` |'), 'RULE_NO_ENFORCEMENT', AGGREGATE_DESIGN);
  failing(change(document, '| EX-01 | - | 외부 시스템: 인증 시스템 |', '| EX-01 | - | 외부 시스템: 신고 |'), 'EXTERNAL_ENFORCEMENT_INVALID', AGGREGATE_DESIGN);
  // A rule that spans Aggregates needs a decision; hiding it behind one Aggregate or naming no decision both fail.
  failing(change(document, '| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | CON-01 |', '| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | Aggregate 안 |'), 'CROSS_AGGREGATE_NO_DECISION', AGGREGATE_DESIGN);
  failing(change(document, '| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | CON-01 |', '| INV-03 | 게시글 | `게시글.삭제()` | Aggregate 안 |'), 'RULE_AGGREGATE_MISMATCH', AGGREGATE_DESIGN);
  failing(change(document, '| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | CON-01 |', '| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | CON-09 |'), 'UNKNOWN_DECISION', AGGREGATE_DESIGN);
  failing(change(document, '| CON-01 | INV-03 |', '| CON-01 | INV-02 |'), 'DECISION_RULE_MISMATCH', AGGREGATE_DESIGN);
  // The source of a consistency decision is the user or the requirements, never an agent proposal alone.
  failing(change(document, '| 최종 | 분리: 게시글이 삭제된 뒤 신고를 닫는다. 삭제는 신고가 닫히기를 기다리지 않는다 | answers.json `<question_id>` |', '| 최종 | 분리: 게시글이 삭제된 뒤 신고를 닫는다. 삭제는 신고가 닫히기를 기다리지 않는다 | 요청 해석(에이전트 제안) |'), 'DECISION_NO_SOURCE', AGGREGATE_DESIGN);
  failing(change(document, '| 최종 | 분리: 게시글이 삭제된 뒤 신고를 닫는다. 삭제는 신고가 닫히기를 기다리지 않는다 | answers.json `<question_id>` |', '| 최종 | 분리: 게시글이 삭제된 뒤 신고를 닫는다. 삭제는 신고가 닫히기를 기다리지 않는다 | |'), 'DECISION_NO_SOURCE', AGGREGATE_DESIGN);
  assert.equal(run(change(document, 'answers.json `<question_id>` |\n\n`일관성`은', 'INV-03 |\n\n`일관성`은')).ok, true, 'a requirements ID is a source too');
  failing(change(document, '| 게시글, 신고 | - | 최종 |', '| 게시글 | - | 최종 |'), 'EVENTUAL_NOT_SEPARATE', AGGREGATE_DESIGN);
  failing(change(document, '| 게시글, 신고 | - | 최종 |', '| 게시글, 신고 | - | 거의 즉시 |'), 'DECISION_KIND_INVALID', AGGREGATE_DESIGN);
  // Immediate consistency of Aggregates that one operation changes together merges them: the Aggregates become one and the rows say so.
  const merged = change(change(change(change(document, '| 게시글, 신고 | - | 최종 | 분리: 게시글이 삭제된 뒤 신고를 닫는다. 삭제는 신고가 닫히기를 기다리지 않는다 |', '| 게시글 | - | 즉시 | 병합: 신고를 게시글 Aggregate에 넣어 한 번에 바꾼다 |'), '| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | CON-01 |', '| INV-03 | 게시글 | `게시글.삭제()` | CON-01 |'), '| 신고 | 신고 | 신고 | 신고 ID | 신고 | `신고.접수()`, `신고.닫기()` | 대상은 게시글 ID로만 가진다 |\n', ''), '| 게시글 | 커뮤니티 | 게시글 | 게시글 ID | 게시글, 본문 |', '| 게시글 | 커뮤니티 | 게시글 | 게시글 ID | 게시글, 본문, 신고 |');
  failing(merged, 'RULE_AGGREGATE_MISMATCH', AGGREGATE_DESIGN);
  assert.ok(!codes(run(merged)).includes('IMMEDIATE_NOT_MERGED'), 'the merged Aggregate is not asked to merge again');
  // Aggregate structure: one Aggregate per Entity, an Entity root, declared members.
  failing(change(document, '| 신고 | 신고 | 신고 | 신고 ID | 신고 |', '| 신고 | 신고 | 신고 | 신고 ID | 게시글 |'), 'ENTITY_IN_SEVERAL_AGGREGATES', AGGREGATE_DESIGN);
  failing(change(document, '| 신고 | 신고 | 신고 | 신고 ID | 신고 | `신고.접수()`, `신고.닫기()` | 대상은 게시글 ID로만 가진다 |\n', ''), 'ENTITY_UNPLACED', AGGREGATE_DESIGN);
  failing(change(document, '| 게시글 | 커뮤니티 | 게시글 | 게시글 ID | 게시글, 본문 |', '| 게시글 | 커뮤니티 | 본문 | 게시글 ID | 게시글, 본문 |'), 'ROOT_NOT_ENTITY', AGGREGATE_DESIGN);
  failing(change(document, '| 게시글 | 커뮤니티 | 게시글 | 게시글 ID | 게시글, 본문 |', '| 게시글 | 커뮤니티 | 게시글 | 게시글 ID | 게시글, 첨부 |'), 'UNKNOWN_MODEL', AGGREGATE_DESIGN);
  failing(change(document, '| INV-04 | 신고 | Domain Service |', '| INV-04 | 신고, 쓰레기 | Domain Service |'), 'UNKNOWN_AGGREGATE', AGGREGATE_DESIGN);
  // One document, one verdict: a hole in section 1 is reported next to the later problems, earliest stage first.
  const holes = run(change(change(document, '| BIZ-03 | 신고 | 신고 | 신고를 접수한다 |\n', ''), '| INV-02 | 게시글 | `게시글.삭제()` | Aggregate 안 |\n', ''));
  assert.deepEqual(holes.errors.map((error) => [error.code, error.owner_stage]), [['BIZ_UNMAPPED', DOMAIN_MODEL], ['RULE_NO_ENFORCEMENT', AGGREGATE_DESIGN]]);
});

// The template's consistency decision CON-01 (게시글 of 커뮤니티, 신고 of 신고) turned into an immediate one. The two Aggregates
// sit in different bounded contexts unless `sameContext` moves 신고 into 커뮤니티.
const immediate = (document, { readOnly = '-', sameContext = false } = {}) => [
  ['| 게시글, 신고 | - | 최종 |', `| 게시글, 신고 | ${readOnly} | 즉시 |`],
  ...(sameContext ? [['| 신고 | 신고 | 신고 | 신고 ID | 신고 |', '| 신고 | 커뮤니티 | 신고 | 신고 ID | 신고 |']] : []),
  ['| T2: 신고 (CON-01) |', '| T2: 신고 |'],
].reduce((text, [from, to]) => change(text, from, to), document);
const INTEGRATION_ROW = '| 비동기 이벤트 | CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |';
const synchronous = (document, method = '동기 호출') => change(document, INTEGRATION_ROW, `| ${method} | CON-01 | 없음 — 호출한 쪽이 응답을 기다린다 |`);

test('immediate consistency merges only Aggregates of one bounded context that one operation changes together', async () => {
  const document = await templateDocument();
  // Two Aggregates of the same context that one operation changes together must be one Aggregate.
  const together = immediate(document, { sameContext: true });
  const verdict = failing(together, 'IMMEDIATE_NOT_MERGED', AGGREGATE_DESIGN);
  const message = verdict.errors.find((error) => error.code === 'IMMEDIATE_NOT_MERGED').message;
  assert.match(message, /^CON-01 has one operation change 게시글, 신고 of 커뮤니티 together/);
  assert.match(message, /merge them \(결정 names 병합, 걸친 Aggregate lists the merged Aggregate\)/);
  assert.match(message, /list it in 조회 전용 Aggregate instead/, 'the message names the way out for a read-only precondition');
  assert.ok(!codes(run(together)).some((code) => code.startsWith('IMMEDIATE_CROSS_CONTEXT')), 'one context needs no integration row');
  // An Aggregate that the operation only reads is no change to merge, and neither is a single listed Aggregate.
  assert.ok(!codes(run(immediate(document, { sameContext: true, readOnly: '신고' }))).includes('IMMEDIATE_NOT_MERGED'), 'a read-only Aggregate of the same context is not merged');
  assert.ok(!codes(run(immediate(document, { sameContext: true, readOnly: '게시글, 신고' }))).includes('IMMEDIATE_NOT_MERGED'), 'a rule that changes nothing needs no merge');
  assert.ok(!codes(run(change(immediate(document), '| 게시글, 신고 | - | 즉시 |', '| 게시글 | - | 즉시 |'))).includes('IMMEDIATE_NOT_MERGED'), 'one listed Aggregate has nothing to merge, with or without the word 병합');
  // The read-only marker has to name Aggregates the decision spans, and an immediate decision has to span one.
  failing(immediate(document, { sameContext: true, readOnly: '인증' }), 'READ_ONLY_NOT_SPANNED', AGGREGATE_DESIGN);
  failing(change(immediate(document), '| 게시글, 신고 | - | 즉시 |', '| - | - | 즉시 |'), 'DECISION_NO_AGGREGATE', AGGREGATE_DESIGN);
  // A document written before the column existed reads as "the rule changes every Aggregate it spans".
  const legacy = immediate(document, { sameContext: true }).replace('| 걸친 Aggregate | 조회 전용 Aggregate | 일관성 |', '| 걸친 Aggregate | 일관성 |').replace('|---|---|---|---|---|---|---|\n| CON-01 | INV-03 | 게시글, 신고 | - | 즉시 |', '|---|---|---|---|---|---|\n| CON-01 | INV-03 | 게시글, 신고 | 즉시 |');
  assert.notEqual(legacy, immediate(document, { sameContext: true }));
  failing(legacy, 'IMMEDIATE_NOT_MERGED', AGGREGATE_DESIGN);
});

test('immediate consistency across bounded contexts is never a merge: section 5 must record it as a synchronous check or call with its source', async () => {
  const document = await templateDocument();
  // 게시글 (커뮤니티) and 신고 (신고) are in different contexts: no merge, whether the operation changes or only reads the other side.
  for (const readOnly of ['-', '신고']) {
    const crossing = immediate(document, { readOnly });
    assert.ok(!codes(run(crossing)).includes('IMMEDIATE_NOT_MERGED'), `no merge across contexts (조회 전용: ${readOnly})`);
    assert.deepEqual(run(synchronous(crossing)), { ok: true, errors: [] }, `a synchronous row that cites the decision realises it (조회 전용: ${readOnly})`);
    assert.deepEqual(run(synchronous(crossing, '동기 확인')), { ok: true, errors: [] }, 'a synchronous check is one too');
    assert.deepEqual(run(synchronous(crossing, '비동기 알림과 동기 확인')), { ok: true, errors: [] }, 'a row may combine styles when one of them is synchronous');
  }
  const crossing = immediate(document, { readOnly: '신고' });
  // The integration-design stage owns every way the realisation can be missing, and each message says what to write.
  const unrealised = failing(crossing, 'IMMEDIATE_CROSS_CONTEXT_NOT_SYNCHRONOUS', INTEGRATION_DESIGN);
  assert.match(unrealised.errors.find((error) => error.code === 'IMMEDIATE_CROSS_CONTEXT_NOT_SYNCHRONOUS').message, /^CON-01 needs immediate consistency across 커뮤니티, 신고\. Aggregates of different bounded contexts are never merged, so section 5 must record it as a synchronous check or call, but INT-01 \(비동기 이벤트\) citing it is not synchronous\. Make its 통신 방식 synchronous/);
  assert.deepEqual(unrealised.errors.map((error) => [error.code, error.id, error.owner_stage]), [['SAGA_WITHOUT_EVENTUAL', 'INT-01', INTEGRATION_DESIGN], ['IMMEDIATE_CROSS_CONTEXT_NOT_SYNCHRONOUS', 'CON-01', INTEGRATION_DESIGN]], 'nothing of an earlier stage is blamed');
  const missing = failing(synchronous(crossing).replace(/^\| INT-01 .*\n/m, '| INT-01 | 신고 | 커뮤니티 | 없음 | 없음 | 신고가 접수됨 | 비동기 이벤트 | - | 없음 — 이벤트를 곧바로 발행한다 | CONTEXT-MAP.md |\n'), 'IMMEDIATE_CROSS_CONTEXT_NOT_INTEGRATED', INTEGRATION_DESIGN);
  assert.match(missing.errors.find((error) => error.code === 'IMMEDIATE_CROSS_CONTEXT_NOT_INTEGRATED').message, /and no integration row cites it\. Add an INT row whose 일관성 결정 is CON-01, whose 통신 방식 is synchronous \(동기 확인, 동기 호출\) and whose 근거·출처 names its source/);
  failing(synchronous(crossing).replace(/^\| INT-01 .*\n/m, ''), 'IMMEDIATE_CROSS_CONTEXT_NOT_INTEGRATED', INTEGRATION_DESIGN);
  failing(change(synchronous(crossing), '| 없음 — 호출한 쪽이 응답을 기다린다 | CONTEXT-MAP.md `## 3` 커뮤니티 → 신고, answers.json `<question_id>` |', '| 없음 — 호출한 쪽이 응답을 기다린다 | - |'), 'IMMEDIATE_INTEGRATION_NO_SOURCE', INTEGRATION_DESIGN);
  // Several rows may cite the decision; one synchronous row with a source is enough.
  const two = change(synchronous(crossing), '\n\n`통신 방식`은', '\n| INT-02 | 신고 | 커뮤니티 | 없음 | 없음 | 신고가 닫힘 | 비동기 이벤트 | CON-01 | 없음 — 이벤트를 곧바로 발행한다 | CONTEXT-MAP.md |\n\n`통신 방식`은');
  assert.deepEqual(run(two), { ok: true, errors: [] });
  // The cross-context requirement is for immediate decisions only: an eventual one keeps its own check and needs no synchronous row.
  assert.deepEqual(run(document), { ok: true, errors: [] });
  failing(change(document, '| 비동기 이벤트 | CON-01 |', '| 비동기 이벤트 | - |'), 'CROSS_CONTEXT_NOT_INTEGRATED', INTEGRATION_DESIGN);
  assert.ok(!codes(run(document)).some((code) => code.startsWith('IMMEDIATE_')));
});

test('a rule that a Value Object owns is enforced by that Value Object, with no Entity or Aggregate invented for it', async () => {
  const document = await templateDocument();
  // INV-01 (the length of the body) belongs to the Value Object 본문, and the Aggregate that holds it is named like any member.
  const owned = change(document, '| INV-01 | 게시글 | `게시글.작성()` | Aggregate 안 |', '| INV-01 | 게시글 | Value Object: 본문.검증() | Aggregate 안 |');
  assert.deepEqual(run(owned), { ok: true, errors: [] });
  assert.equal(run(change(owned, 'Value Object: 본문.검증()', 'Value Object: 본문')).ok, true, 'the construction rule needs no method name');
  assert.equal(run(change(owned, 'Value Object: 본문.검증()', '`Value Object: 본문.검증()`')).ok, true, 'a code-formatted cell is read the same way');
  // Only a Value Object that owns the rule in section 1 can enforce it.
  failing(change(owned, 'Value Object: 본문.검증()', 'Value Object: 신고.검증()'), 'VALUE_OBJECT_ENFORCEMENT_INVALID', AGGREGATE_DESIGN);
  failing(change(owned, 'Value Object: 본문.검증()', 'Value Object: 게시글.검증()'), 'VALUE_OBJECT_ENFORCEMENT_INVALID', AGGREGATE_DESIGN);
  failing(change(owned, 'Value Object: 본문.검증()', 'Value Object: 쓰레기'), 'VALUE_OBJECT_ENFORCEMENT_INVALID', AGGREGATE_DESIGN);
  failing(change(owned, '| INV-01 | 게시글 | Value Object: 본문.검증() |', '| INV-01 | 신고 | Value Object: 본문.검증() |'), 'RULE_AGGREGATE_MISMATCH', AGGREGATE_DESIGN);
  // The section 3 stage still refuses a rule that a Value Object already enforces.
  failing(change(document, '| 신고 | INV-04 | `중복 신고 판정.판정()` |', '| 신고 | INV-01 | `중복 신고 판정.판정()` |'), 'DOMAIN_SERVICE_REDUNDANT', DOMAIN_SERVICE);
  failing(change(owned, '| 신고 | INV-04 | `중복 신고 판정.판정()` |', '| 신고 | INV-01 | `중복 신고 판정.판정()` |'), 'DOMAIN_SERVICE_REDUNDANT', DOMAIN_SERVICE);
});

test('a bounded context with no state lifecycle may have no Aggregate when the document says why', async () => {
  // The calculator: a calculation request and its result are Value Objects, and the request enforces both rules.
  assert.deepEqual(run(STATELESS_DOCUMENT, STATELESS_REQUIREMENTS), { ok: true, errors: [] });
  const reason = '| 계산기 | 상태와 생애주기가 없다. 계산 요청과 결과는 값으로만 존재한다 |\n';
  failing(change(STATELESS_DOCUMENT, reason, ''), 'AGGREGATES_MISSING', AGGREGATE_DESIGN, STATELESS_REQUIREMENTS);
  failing(change(STATELESS_DOCUMENT, reason, '| 계산기 | - |\n'), 'AGGREGATES_MISSING', AGGREGATE_DESIGN, STATELESS_REQUIREMENTS);
  failing(change(STATELESS_DOCUMENT, reason, '| 환율 | 값이 바뀌지 않는다 |\n'), 'AGGREGATE_ABSENCE_UNEXPLAINED', AGGREGATE_DESIGN, STATELESS_REQUIREMENTS);
  // A section that declares no Aggregate at all may say so in one line.
  const whole = change(STATELESS_DOCUMENT, `| BC | Aggregate 없음 사유 |\n|---|---|\n${reason}`, '해당 없음 — 상태와 생애주기가 없다\n');
  assert.equal(run(whole, STATELESS_REQUIREMENTS).ok, true);
  // The Value Object that enforces the rule must be one of its owners; an Entity cannot be invented without a home.
  failing(change(STATELESS_DOCUMENT, '| 계산 요청 | Value Object | 계산기 |', '| 계산 요청 | Entity | 계산기 |'), 'ENTITY_UNPLACED', AGGREGATE_DESIGN, STATELESS_REQUIREMENTS);
  failing(change(STATELESS_DOCUMENT, '| INV-01 | - | Value Object: 계산 요청.생성() |', '| INV-01 | - | Value Object: 계산 결과.생성() |'), 'VALUE_OBJECT_ENFORCEMENT_INVALID', AGGREGATE_DESIGN, STATELESS_REQUIREMENTS);
  failing(change(STATELESS_DOCUMENT, '| INV-01 | - | Value Object: 계산 요청.생성() | 값 안 |\n', ''), 'RULE_NO_ENFORCEMENT', AGGREGATE_DESIGN, STATELESS_REQUIREMENTS);
  // Every other rule keeps applying: a Root is an Entity once an Aggregate exists, and the use case still names its transaction.
  const rooted = change(change(STATELESS_DOCUMENT, '|---|---|---|---|---|---|---|\n\n| BC |', '|---|---|---|---|---|---|---|\n| 계산 | 계산기 | 계산 요청 | 계산 ID | 계산 요청, 계산 결과 | `계산 요청.생성()` | - |\n\n| BC |'), '| INV-01 | - |', '| INV-01 | 계산 |');
  failing(rooted, 'ROOT_NOT_ENTITY', AGGREGATE_DESIGN, STATELESS_REQUIREMENTS);
  failing(change(STATELESS_DOCUMENT, '| 없음 — 저장하지 않고 Aggregate를 바꾸지 않는다 |', '| |'), 'TRANSACTION_MISSING', APPLICATION_SERVICE, STATELESS_REQUIREMENTS);
  // Mixed with Aggregates: only a context that has none needs its own reason.
  const community = await templateDocument();
  const withScore = (reasonRow) => community
    .replace(/^(\| 인증 시스템 \| 외부 시스템 \|.*)$/m, '$1\n| 점수 | Value Object | 점수 | 값이 의미를 갖는다. 같은 값이면 같은 점수다 | accepted-target | INV-05 |')
    .replace(/^(\| EX-01 \| 인증 \| 인증 시스템 \|.*)$/m, '$1\n| BIZ-05 | 점수 | 점수 | 점수를 계산한다 |\n| INV-05 | 점수 | 점수 | 점수는 0 이상이다 |')
    .replace(/^(\| EX-01 \| - \| 외부 시스템: 인증 시스템 \|.*)$/m, '$1\n| INV-05 | - | Value Object: 점수.생성() | 값 안 |')
    .replace(/^(\| AS-04 \|.*)$/m, '$1\n| AS-05 | 점수 계산 | 점수 | BIZ-05 | 점수 만들기 | 없음 — Aggregate를 바꾸지 않는다 | 없음 | 없음 |')
    .replace('\n### 2.2 규칙 강제', `${reasonRow}\n### 2.2 규칙 강제`);
  const scoreRequirements = `${REQUIREMENTS}\n### BIZ-05 점수 계산 (SD-04)\n\n- 업무 규칙:\n  - INV-05 점수는 0 이상이다 — 출처: 요청 원문\n`;
  const table = '\n| BC | Aggregate 없음 사유 |\n|---|---|\n| 점수 | 상태가 없고 값만 있다 |\n';
  assert.deepEqual(run(withScore(table), scoreRequirements), { ok: true, errors: [] });
  failing(withScore(''), 'AGGREGATE_ABSENCE_UNEXPLAINED', AGGREGATE_DESIGN, scoreRequirements);
});

test('domain-service section: every rule handed over has a service and no service takes a rule an Aggregate enforces', async () => {
  const document = await templateDocument();
  failing(document.replace(/^\| DS-01 .*\n/m, ''), 'DOMAIN_SERVICE_MISSING', DOMAIN_SERVICE);
  failing(change(document, '| 신고 | INV-04 | `중복 신고 판정.판정()` |', '| 신고 | INV-01 | `중복 신고 판정.판정()` |'), 'DOMAIN_SERVICE_REDUNDANT', DOMAIN_SERVICE);
  failing(change(document, '| 신고 | INV-04 | `중복 신고 판정.판정()` |', '| 신고 | INV-04 | - |'), 'SERVICE_NO_BEHAVIOR', DOMAIN_SERVICE);
  failing(change(document, '| 신고 | INV-04 |', '| 신고 | - |'), 'SERVICE_NO_RULE', DOMAIN_SERVICE);
  failing(change(document, '| 신고 | INV-04 |', '| 신고 | INV-77 |'), 'UNKNOWN_REQUIREMENT', DOMAIN_SERVICE);
  // A plan set may need no Domain Service when every rule has an Aggregate behaviour.
  const noService = change(change(document, '| INV-04 | 신고 | Domain Service |', '| INV-04 | 신고 | `신고.접수()` |'), /\| DS-01 .*\n/.exec(document)[0], '').replace('| DS | 이름 |', '해당 없음 — 모든 규칙을 Aggregate 행위가 강제한다\n\n| DS | 이름 |');
  assert.equal(run(noService).ok, true);
  failing(change(noService, '| INV-04 | 신고 | `신고.접수()` |', '| INV-04 | 신고 | Domain Service |'), 'DOMAIN_SERVICE_MISSING', DOMAIN_SERVICE);
});

test('application-service section: every business activity has a use case and every transaction changes one Aggregate', async () => {
  const document = await templateDocument();
  failing(change(document, '| 신고 | BIZ-03 |', '| 신고 | BIZ-09 |'), 'BIZ_NO_APPLICATION_SERVICE', APPLICATION_SERVICE);
  failing(change(document, '| T1: 신고 | 신고 |', '| T1: 신고, 게시글 | 신고 |'), 'MULTI_AGGREGATE_TRANSACTION', APPLICATION_SERVICE);
  failing(change(document, '| T1: 신고 | 신고 |', '| T1: 쓰레기 | 신고 |'), 'MULTI_AGGREGATE_TRANSACTION', APPLICATION_SERVICE);
  failing(change(document, '| T1: 게시글 | 게시글 | 게시글이 삭제됨 이벤트 |', '| T1: 게시글; T2: 신고 (CON-09) | 게시글 | 게시글이 삭제됨 이벤트 |'), 'TRANSACTION_CONSISTENCY_INVALID', APPLICATION_SERVICE);
  failing(change(document, '| T1: 게시글 | 게시글 | 없음 |\n| AS-02', '| | 게시글 | 없음 |\n| AS-02'), 'TRANSACTION_MISSING', APPLICATION_SERVICE);
  assert.equal(run(change(document, '| T1: 게시글 | 게시글 | 없음 |\n| AS-02', '| 없음 — 조회만 한다 | 게시글 | 없음 |\n| AS-02')).ok, true);
  // The business activity that only an external system serves needs no use case.
  assert.equal(run(document).ok, true);
});

test('integration-design section: Saga and Outbox appear only for eventual consistency and every cross-context decision is integrated', async () => {
  const document = await templateDocument();
  failing(change(document, '| 비동기 이벤트 | CON-01 |', '| 비동기 이벤트 | - |'), 'CROSS_CONTEXT_NOT_INTEGRATED', INTEGRATION_DESIGN);
  failing(change(document, '| CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |', '| - | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |'), 'SAGA_WITHOUT_EVENTUAL', INTEGRATION_DESIGN);
  failing(change(document, '| CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |', '| CON-01 | |'), 'SAGA_OUTBOX_UNCONSIDERED', INTEGRATION_DESIGN);
  failing(change(document, '| CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |', '| CON-05 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |'), 'UNKNOWN_DECISION', INTEGRATION_DESIGN);
  failing(change(document, '| 커뮤니티 | 신고 | 없음 | 없음 | 게시글이 삭제됨 | 비동기 이벤트 |', '| 커뮤니티 | 신고 | 없음 | 없음 | 게시글이 삭제됨 | |'), 'INTEGRATION_INCOMPLETE', INTEGRATION_DESIGN);
  failing(document.replace(/^\| INT-01 .*\n/m, ''), 'CROSS_CONTEXT_NOT_INTEGRATED', INTEGRATION_DESIGN);
  // A plan set with no cross-context decision and no relationship says so.
  const single = change(document, '| 신고 | 신고 | 신고 | 신고 ID |', '| 신고 | 커뮤니티 | 신고 | 신고 ID |').replace(/^\| INT-01 .*\n/m, '').replace('| INT | 상류 BC |', '해당 없음 — 컨텍스트 하나다\n\n| INT | 상류 BC |');
  assert.equal(run(single).ok, true);
  // Saga or Outbox on a row without an eventual-consistency decision is refused even for a plausible integration.
  const withoutSaga = change(document, '| CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |', '| CON-01 | 없음 — 이벤트를 곧바로 발행한다 |');
  assert.equal(run(withoutSaga).ok, true, 'a considered and rejected Saga/Outbox is a valid record');
});

test('the findings come earliest stage first, so the first one names the stage to reopen', async () => {
  const document = await templateDocument();
  const broken = change(change(change(document, '| CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |', '| - | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |'), '| INV-04 | 신고 | Domain Service |', '| INV-04 | 신고 | `신고.접수()` |'), '| BIZ-03 | 신고 | 신고 | 신고를 접수한다 |\n', '');
  assert.deepEqual(run(broken).errors.map((error) => [error.code, error.owner_stage]), [['BIZ_UNMAPPED', DOMAIN_MODEL], ['DOMAIN_SERVICE_REDUNDANT', DOMAIN_SERVICE], ['SAGA_WITHOUT_EVENTUAL', INTEGRATION_DESIGN], ['CROSS_CONTEXT_NOT_INTEGRATED', INTEGRATION_DESIGN]]);
});

test('the gate command reads the two documents, prints the verdict and fails the process on a failing gate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'domain-model-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const document = await templateDocument();
  await writeFile(join(directory, 'requirements.md'), REQUIREMENTS);
  await writeFile(join(directory, 'tactical-design.md'), document);
  const command = (...extra) => spawnSync(process.execPath, [SCRIPT, '--requirements', join(directory, 'requirements.md'), '--tactical-design', join(directory, 'tactical-design.md'), ...extra], { encoding: 'utf8' });
  const passed = command();
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(JSON.parse(passed.stdout), { ok: true, errors: [] });
  await writeFile(join(directory, 'tactical-design.md'), upTo(document, 3));
  const failed = command();
  assert.equal(failed.status, 1);
  assert.deepEqual(JSON.parse(failed.stdout).errors.map((error) => [error.code, error.owner_stage]), [['SECTION_MISSING', APPLICATION_SERVICE], ['SECTION_MISSING', INTEGRATION_DESIGN]]);
  // The stage no longer selects anything: the only input is the documents.
  const staged = command('--stage', 'domain-service');
  assert.equal(staged.status, 1);
  assert.match(staged.stderr, /^Usage: harness-domain-model-check\.mjs --workspace-root <absolute-workspace-root> \| --requirements <path> --tactical-design <path>/);
  const relative = spawnSync(process.execPath, [SCRIPT, '--workspace-root', 'relative/path'], { encoding: 'utf8' });
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
  const root = await planSetWorkspace(t, { 'requirements.md': REQUIREMENTS, 'tactical-design.md': document });
  assert.deepEqual(await checkWorkspaceTacticalDesign({ root, planSetId: 'set' }), { ok: true, errors: [] });
  await writeFile(join(root, 'docs/specs/set/tactical-design.md'), upTo(document, 2));
  const failing = await checkWorkspaceTacticalDesign({ root, planSetId: 'set' });
  assert.equal(failing.ok, false);
  assert.deepEqual(codes(failing), ['SECTION_MISSING', 'SECTION_MISSING', 'SECTION_MISSING']);

  const empty = await planSetWorkspace(t, {});
  const missing = await checkWorkspaceTacticalDesign({ root: empty, planSetId: 'set' });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.errors.map((error) => [error.code, error.owner_stage]), [['DOCUMENT_MISSING', 'requirements-fix'], ['DOCUMENT_MISSING', DOMAIN_MODEL]]);
  assert.match(missing.errors[0].message, /docs\/specs\/set\/requirements\.md does not exist/);
  assert.match(missing.errors[1].message, /docs\/specs\/set\/tactical-design\.md does not exist/);
});

test('only a stakeholder-analysis that decided to skip lets the gate pass without documents', async (t) => {
  assert.equal(stakeholderAnalysisSkipped('## 2. 판정\n\n- 판정: 생략\n- 사유: 기존 Spec 안의 변경\n'), true);
  assert.equal(stakeholderAnalysisSkipped('판정: 생략\n'), true);
  for (const text of ['- 판정: 실행\n', '- 판정: 실행 | 생략\n', '- 판정: 생략하지 않는다\n', '판정을 생략으로 적지 않았다\n', '']) assert.equal(stakeholderAnalysisSkipped(text), false, text);
  const skipped = await planSetWorkspace(t, { 'stakeholder-analysis.md': '# Stakeholder 분석\n\n- 판정: 생략\n' });
  assert.deepEqual(await checkWorkspaceTacticalDesign({ root: skipped, planSetId: 'set' }), { ok: true, skipped: true, errors: [] });
  const executed = await planSetWorkspace(t, { 'stakeholder-analysis.md': '# Stakeholder 분석\n\n- 판정: 실행\n' });
  assert.deepEqual((await checkWorkspaceTacticalDesign({ root: executed, planSetId: 'set' })).errors.map((error) => error.code), ['DOCUMENT_MISSING', 'DOCUMENT_MISSING']);
});

test('the runner gates only the completed result of the last tactical stage, with the whole document', async (t) => {
  const document = await templateDocument();
  const input = (skill, planSetId = 'set') => ({ skill, context: planSetId ? { plan_set_id: planSetId } : {} });
  const failingDocument = document.replace(/^(\| CON-01 \|.*\| )answers\.json `<question_id>` \|$/m, '$1에이전트 제안 |');
  assert.notEqual(failingDocument, document);
  const root = await planSetWorkspace(t, { 'requirements.md': REQUIREMENTS, 'tactical-design.md': failingDocument });

  // A finding of an earlier stage's section is reported against that stage, on the last stage's result.
  const verdict = await evaluateTacticalDesignGate({ root, input: input(INTEGRATION_DESIGN), envelope: completed });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.stage, INTEGRATION_DESIGN);
  assert.deepEqual(verdict.errors.map((error) => [error.code, error.id, error.owner_stage]), [['DECISION_NO_SOURCE', 'CON-01', AGGREGATE_DESIGN]]);
  await assert.rejects(assertTacticalDesignGate({ root, input: input(INTEGRATION_DESIGN), envelope: completed }), (error) => {
    assert.ok(error instanceof TacticalGateError);
    assert.deepEqual(error.verdict, verdict);
    assert.match(error.message, /^Tactical design gate failed for integration-design: DECISION_NO_SOURCE \(CON-01\) \[aggregate-design\] CON-01 has no source/);
    return true;
  });

  // The earlier stages are accepted without a gate even when the document is incomplete or wrong; blocks and questions never reach it.
  for (const stage of [DOMAIN_MODEL, AGGREGATE_DESIGN, DOMAIN_SERVICE, APPLICATION_SERVICE]) {
    assert.equal(await evaluateTacticalDesignGate({ root, input: input(stage), envelope: completed }), null, stage);
    assert.equal(await assertTacticalDesignGate({ root, input: input(stage), envelope: completed }), null, stage);
  }
  const partial = await planSetWorkspace(t, { 'requirements.md': REQUIREMENTS, 'tactical-design.md': upTo(document, 1) });
  for (const stage of [DOMAIN_MODEL, AGGREGATE_DESIGN, DOMAIN_SERVICE, APPLICATION_SERVICE]) assert.equal(await assertTacticalDesignGate({ root: partial, input: input(stage), envelope: completed }), null, `${stage} with only section 1`);
  for (const envelope of [{ status: 'blocked', code: 'INPUT_MISSING' }, { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE' }, { status: 'action_required', code: 'USER_DECISION_REQUIRED' }, { status: 'failed', code: 'EXECUTION_ERROR' }]) assert.equal(await evaluateTacticalDesignGate({ root, input: input(INTEGRATION_DESIGN), envelope }), null, envelope.code);
  assert.equal(await evaluateTacticalDesignGate({ root, input: input('requirements-fix'), envelope: completed }), null, 'another stage');
  assert.equal(await evaluateTacticalDesignGate({ root, input: input(INTEGRATION_DESIGN, null), envelope: completed }), null, 'no plan set');
  assert.equal(await assertTacticalDesignGate({ root, input: input('spec-me'), envelope: completed }), null);

  // The last stage is accepted once the whole document passes, and an incomplete document fails it.
  await writeFile(join(root, 'docs/specs/set/tactical-design.md'), document);
  assert.deepEqual(await assertTacticalDesignGate({ root, input: input(INTEGRATION_DESIGN), envelope: completed }), { stage: INTEGRATION_DESIGN, ok: true, errors: [] });
  await writeFile(join(root, 'docs/specs/set/tactical-design.md'), upTo(document, 4));
  assert.deepEqual((await evaluateTacticalDesignGate({ root, input: input(INTEGRATION_DESIGN), envelope: completed })).errors.map((error) => [error.code, error.owner_stage]), [['SECTION_MISSING', INTEGRATION_DESIGN]]);
});

test('the rejection tells the stage to repair its own section, or to block and name the earlier stage to reopen', () => {
  const verdict = (...owners) => ({ stage: INTEGRATION_DESIGN, ok: false, errors: owners.map((owner_stage, index) => ({ code: 'X', message: 'm', id: `ID-${index}`, owner_stage })) });
  const own = gateFailureInstruction(verdict(INTEGRATION_DESIGN));
  assert.match(own, /once on the whole tactical-design\.md for integration-design and it failed/);
  assert.match(own, /Nothing was committed or recorded, and the stage is still running/);
  assert.match(own, /same subagent so it repairs its own section/);
  assert.doesNotMatch(own, /DEPENDENCY_INCOMPLETE/);
  const earlier = gateFailureInstruction(verdict(DOMAIN_MODEL, AGGREGATE_DESIGN, INTEGRATION_DESIGN));
  assert.match(earlier, /owner_stage is domain-model, aggregate-design are in sections of earlier stages/);
  assert.match(earlier, /returns blocked \/ DEPENDENCY_INCOMPLETE naming domain-model as the earliest stage to reopen/);
  assert.match(earlier, /without editing any earlier section/);
  assert.match(earlier, /reopens domain-model with --restart-requirements true or --user-revision true --feedback/);
});

test('the runner gate refuses a document that is a symlink out of the workspace', async (t) => {
  const document = await templateDocument();
  const root = await planSetWorkspace(t, { 'requirements.md': REQUIREMENTS });
  const outside = await planSetWorkspace(t, { 'tactical-design.md': document });
  await symlink(join(outside, 'docs/specs/set/tactical-design.md'), join(root, 'docs/specs/set/tactical-design.md'));
  await assert.rejects(assertTacticalDesignGate({ root, input: { skill: INTEGRATION_DESIGN, context: { plan_set_id: 'set' } }, envelope: completed }), /outside case workspace/);
});
