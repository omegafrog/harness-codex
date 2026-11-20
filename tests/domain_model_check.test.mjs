import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTacticalDesign, parseRequirements, parseTables } from '../.harness/scripts/harness-domain-model-check.mjs';
import { TACTICAL_DESIGN_STAGES } from '../.harness/src/workflow/worktree-stages.mjs';
import { FINAL_TACTICAL_STAGE, TacticalGateError, assertTacticalDesignGate, checkWorkspaceTacticalDesign, evaluateTacticalDesignGate, gateFailureInstruction, stakeholderAnalysisSkipped } from '../.harness/src/workflow/domain-model-gate.mjs';
import { READ_ONLY_DOCUMENT, READ_ONLY_REQUIREMENTS, REQUIREMENTS, STATELESS_DOCUMENT, STATELESS_REQUIREMENTS, templateDocument as loadTemplate, upTo } from './support/domain-model-fixture.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(sourceRoot, '.harness/scripts/harness-domain-model-check.mjs');
const [DOMAIN_MODEL, AGGREGATE_DESIGN, DOMAIN_SERVICE, APPLICATION_SERVICE, INTEGRATION_DESIGN, CONTEXT_BOUNDARY] = TACTICAL_DESIGN_STAGES;

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

const passes = (document, requirements, why) => assert.deepEqual(run(document, requirements), { ok: true, errors: [] }, why);

test('the gate is one check of the whole document, owned by the last tactical stage of the flow', () => {
  assert.equal(FINAL_TACTICAL_STAGE, CONTEXT_BOUNDARY);
  assert.equal(FINAL_TACTICAL_STAGE, TACTICAL_DESIGN_STAGES.at(-1));
  assert.deepEqual(TACTICAL_DESIGN_STAGES, ['domain-model', 'aggregate-design', 'domain-service', 'application-service', 'integration-design', 'context-boundary']);
});

test('the requirements parser reads BIZ headings and the INV and EX bullets, not AC lines, and the table parser reads cleaned headers', () => {
  assert.deepEqual(parseRequirements(REQUIREMENTS), { business: ['BIZ-01', 'BIZ-02', 'BIZ-03', 'BIZ-04'], rules: ['INV-01', 'EX-01', 'INV-02', 'INV-03', 'INV-04'] });
  assert.deepEqual(parseTables('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n\n| 열 | **값** |\n|:--|--:|\n| x | - |\n| - | - |\n'), [{ header: ['열', '값'], rows: [{ 열: 'x', 값: '-' }] }], 'fenced tables are ignored, header markup is dropped and an empty row is dropped');
});

test('the template example, the stateless-calculator document and a read-only-aggregate document pass the gate', async () => {
  passes(await templateDocument());
  passes(STATELESS_DOCUMENT, STATELESS_REQUIREMENTS);
  passes(READ_ONLY_DOCUMENT, READ_ONLY_REQUIREMENTS);
});

test('documents: a missing document is reported against the stage that owes it, and each missing section against the stage that fills it', async () => {
  const document = await templateDocument();
  assert.deepEqual(run('# 전술 설계\n').errors.map((error) => [error.code, error.owner_stage]), TACTICAL_DESIGN_STAGES.map((stage) => ['SECTION_MISSING', stage]));
  assert.deepEqual(run(upTo(document, 3)).errors.map((error) => [error.code, error.owner_stage]), [['SECTION_MISSING', APPLICATION_SERVICE], ['SECTION_MISSING', INTEGRATION_DESIGN], ['SECTION_MISSING', CONTEXT_BOUNDARY]]);
  assert.deepEqual(run(upTo(document, 2)).errors.map((error) => error.owner_stage), [DOMAIN_SERVICE, APPLICATION_SERVICE, INTEGRATION_DESIGN, CONTEXT_BOUNDARY]);
  // Decision history (section 7) is not gated, and headings are read the way people write them.
  passes(document.split('## 7.')[0]);
  passes(document.replace('## 5. 통합 설계', '## 5 통합 설계'));
  assert.equal(run(document.replace('## 5. 통합 설계', '### 5. 통합 설계')).ok, false, 'a deeper heading is no section');
  assert.equal(run(document.replace('## 5. 통합 설계', '```\n## 5. 통합 설계\n```')).ok, false, 'a heading inside a code block is no section');
});

test('domain-model section: every BIZ maps to a model or an external-system marker and every INV and EX has an owning model', async () => {
  const document = await templateDocument();
  failing(change(document, '| BIZ-03 | 신고 | 신고 | 신고를 접수한다 |\n', ''), 'BIZ_UNMAPPED', DOMAIN_MODEL);
  failing(change(document, '| BIZ-02 | 커뮤니티 | 게시글 |', '| BIZ-02 | 커뮤니티 | 게시물 |'), 'BIZ_UNMAPPED', DOMAIN_MODEL);
  failing(change(document, '| BIZ-02 | 커뮤니티 | 게시글 |', '| BIZ-02 | 커뮤니티 | - |'), 'BIZ_UNMAPPED', DOMAIN_MODEL);
  failing(document, 'BIZ_UNMAPPED', DOMAIN_MODEL, `${REQUIREMENTS}\n### BIZ-05 신고 취소 (SD-02)\n`);
  failing(change(document, '| INV-04 | 신고 | 신고 | 같은 회원의 같은 글 신고를 막는다 |\n', ''), 'RULE_NO_OWNER', DOMAIN_MODEL);
  failing(change(document, '| EX-01 | 인증 | 인증 시스템 |', '| EX-01 | 인증 | - |'), 'RULE_NO_OWNER', DOMAIN_MODEL);
  failing(document, 'RULE_NO_OWNER', DOMAIN_MODEL, REQUIREMENTS.replace('- 업무 규칙: 없음', '- 업무 규칙:\n  - EX-07 취소는 접수 뒤 한 시간 안에만 된다'));
  // Read tolerantly: one declared owner is enough, remarks and markup around a name are ignored, and an external marker owns what it names.
  passes(change(document, '| BIZ-04 | 인증 | 인증 시스템 |', '| BIZ-04 | 인증 | 인증 시스템, 로그인 기록 |'));
  passes(change(document, '| BIZ-02 | 커뮤니티 | 게시글 |', '| BIZ-02 | 커뮤니티 | **`게시글`** (Entity) |'));
  passes(change(document, '| BIZ-04 | 인증 | 인증 시스템 |', '| BIZ-04 | 인증 | 외부 시스템: 결제 |'));
  passes(change(document, '| BIZ-02 | 커뮤니티 | 게시글 |', '| BIZ-02, BIZ-05 | 커뮤니티 | 게시글 |'));
});

test('aggregate-design section: every INV and EX has an enforcing behaviour of any form', async () => {
  const document = await templateDocument();
  failing(change(document, '| INV-02 | 게시글 | `게시글.삭제()` | Aggregate 안 |\n', ''), 'RULE_NO_ENFORCEMENT', AGGREGATE_DESIGN);
  for (const empty of ['', '-', '없음', '없음 — 아직 정하지 않았다']) failing(change(document, '| INV-02 | 게시글 | `게시글.삭제()` |', `| INV-02 | 게시글 | ${empty} |`), 'RULE_NO_ENFORCEMENT', AGGREGATE_DESIGN);
  // Any non-empty form enforces it: a method (whether or not the Aggregate lists it), a Value Object rule, a Domain Service, an external system.
  passes(change(document, '| INV-02 | 게시글 | `게시글.삭제()` |', '| INV-02 | 게시글 | `게시글.숨기기()` |'));
  passes(change(document, '| INV-01 | 게시글 | `게시글.작성()` |', '| INV-01 | 게시글 | Value Object: 본문.검증() |'));
  passes(change(document, '| INV-01 | 게시글 | `게시글.작성()` |', '| INV-01 | - | Value Object: 본문 |'));
  passes(change(document, '| EX-01 | - | 외부 시스템: 인증 시스템 |', '| EX-01 | - | 인증 시스템이 거절한다 |'));
  passes(change(document, '| INV-01 | 게시글 | `게시글.작성()` |', '| INV-01 | 게시글 | Domain Service |'));
  // One row naming several rules enforces each of them.
  passes(change(change(document, '| INV-01 | 게시글 | `게시글.작성()` | Aggregate 안 |\n', ''), '| INV-02 | 게시글 | `게시글.삭제()` |', '| INV-01, INV-02 | 게시글 | `게시글.작성()`, `게시글.삭제()` |'));
  // The table is found by its key columns: the Aggregate and scope columns are optional.
  passes(change(document, '| 요구 | Aggregate | 강제 행위 | 일관성 범위 |\n|---|---|---|---|\n| INV-01 | 게시글 | `게시글.작성()` | Aggregate 안 |\n| INV-02 | 게시글 | `게시글.삭제()` | Aggregate 안 |\n| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | CON-01 |\n| INV-04 | 신고 | Domain Service | Aggregate 안 |\n| EX-01 | - | 외부 시스템: 인증 시스템 | Aggregate 안 |', '| 요구 | 강제 행위 |\n|---|---|\n| INV-01 | `게시글.작성()` |\n| INV-02 | `게시글.삭제()` |\n| INV-03 | `게시글.삭제()`, `신고.닫기()` |\n| INV-04 | Domain Service |\n| EX-01 | 외부 시스템: 인증 시스템 |'));
});

test('aggregate-design section: a rule that spans Aggregates cites a consistency decision of kind 즉시 or 최종 whose source is not an agent proposal alone', async () => {
  const document = await templateDocument();
  const spanning = '| INV-03 | 게시글, 신고 | `게시글.삭제()`, `신고.닫기()` | CON-01 |';
  const source = '| 최종 | 분리: 게시글이 삭제된 뒤 신고를 닫는다. 삭제는 신고가 닫히기를 기다리지 않는다 | answers.json `<question_id>` |';
  const decided = (text) => change(document, source, source.replace('answers.json `<question_id>`', text));
  // No decision: the scope names none, names one that 2.3 does not declare, and no decision lists the rule either.
  failing(change(change(document, spanning, spanning.replace('CON-01', 'Aggregate 안')), '| CON-01 | INV-03 |', '| CON-01 | INV-02 |'), 'CROSS_AGGREGATE_NO_DECISION', AGGREGATE_DESIGN);
  const unknown = failing(change(change(document, spanning, spanning.replace('CON-01', 'CON-09')), '| CON-01 | INV-03 |', '| CON-01 | INV-02 |'), 'CROSS_AGGREGATE_NO_DECISION', AGGREGATE_DESIGN);
  assert.match(unknown.errors.find((error) => error.code === 'CROSS_AGGREGATE_NO_DECISION').message, /cites CON-09, which section 2\.3 does not declare/);
  // A decision that lists the rule is cited too, from either side; the rule may name one Aggregate when its decision names more.
  passes(change(document, spanning, spanning.replace('CON-01', 'Aggregate 안')));
  passes(change(document, spanning, '| INV-03 | 게시글 | `게시글.삭제()` | CON-01 |'));
  // The kind is 즉시 or 최종, in any markup.
  failing(change(document, '| 게시글, 신고 | - | 최종 |', '| 게시글, 신고 | - | 거의 즉시 |'), 'DECISION_KIND_INVALID', AGGREGATE_DESIGN);
  failing(change(document, '| 게시글, 신고 | - | 최종 |', '| 게시글, 신고 | - | |'), 'DECISION_KIND_INVALID', AGGREGATE_DESIGN);
  passes(change(document, '| 게시글, 신고 | - | 최종 |', '| 게시글, 신고 | - | **즉시** 일관성 |').replace('Outbox: 삭제와 같은 transaction에 이벤트를 기록한다', '없음 — 호출한 쪽이 응답을 기다린다'));
  // The source is the user or the requirements, never an agent proposal alone or nothing.
  failing(decided('요청 해석(에이전트 제안)'), 'DECISION_NO_SOURCE', AGGREGATE_DESIGN);
  failing(decided(''), 'DECISION_NO_SOURCE', AGGREGATE_DESIGN);
  const noSource = failing(decided('에이전트 제안'), 'DECISION_NO_SOURCE', AGGREGATE_DESIGN);
  assert.match(noSource.errors.find((error) => error.code === 'DECISION_NO_SOURCE').message, /an agent proposal alone is not a source/);
  for (const accepted of ['INV-03', 'BIZ-02, CONTEXT-MAP.md `## 3`', '요청 원문', 'CAND-02 채택', '사용자 수정 지시']) passes(decided(accepted));
  // Only the decisions that a rule cites are judged, and a decision that no rule cites needs nothing.
  passes(change(document, '\n\n`일관성`은', '\n| CON-02 | INV-01 | 게시글 | - | 아무거나 | - | |\n\n`일관성`은'));
  // A rule inside one Aggregate needs no decision at all, and the optional read-only column may be absent.
  passes(change(change(document, spanning, '| INV-03 | 게시글 | `게시글.삭제()` | Aggregate 안 |'), '| CON-01 | INV-03 |', '| CON-01 | INV-02 |'));
  passes(change(document, '| CON | 규칙 | 걸친 Aggregate | 조회 전용 Aggregate | 일관성 |', '| CON | 규칙 | 걸친 Aggregate | 일관성 |').replace('|---|---|---|---|---|---|---|\n| CON-01 | INV-03 | 게시글, 신고 | - | 최종 |', '|---|---|---|---|---|---|\n| CON-01 | INV-03 | 게시글, 신고 | 최종 |'));
});

test('application-service section: each transaction boundary changes at most one Aggregate', async () => {
  const document = await templateDocument();
  const boundary = (text) => change(document, '| T1: 신고 | 신고 |', `| ${text} | 신고 |`);
  for (const many of ['T1: 신고, 게시글', 'T1: `신고` + `게시글`', 'T1: 게시글 및 신고', 'T1: 게시글, 신고 (CON-01)']) failing(boundary(many), 'MULTI_AGGREGATE_TRANSACTION', APPLICATION_SERVICE);
  const found = failing(boundary('T1: 신고, 게시글'), 'MULTI_AGGREGATE_TRANSACTION', APPLICATION_SERVICE).errors.find((error) => error.code === 'MULTI_AGGREGATE_TRANSACTION');
  assert.equal(found.id, 'AS-04');
  assert.match(found.message, /AS-04 transaction "T1: 신고, 게시글" changes 게시글, 신고; one transaction changes exactly one Aggregate/);
  // One Aggregate per transaction, however the transactions are listed, noted or left empty.
  for (const fine of ['T1: 신고; T2: 게시글 (CON-01)', 'T1: 신고, T2: 게시글', 'T1: 신고 (게시글 확인 포함)', 'T1: 신고 — 게시글은 읽기만 한다', '없음 — 신고와 게시글을 바꾸지 않는다', '없음', '', '-', 'T1: 알 수 없는 것', 'T1: 신고 (변경 시)']) passes(boundary(fine));
  // The table is found by its key columns, and a context without Aggregates has nothing to count.
  passes(STATELESS_DOCUMENT.replace('| 없음 — 저장하지 않고 Aggregate를 바꾸지 않는다 |', '| T1: 계산 요청, 계산 결과 |'), STATELESS_REQUIREMENTS);
});

test('integration-design section: Saga and Outbox appear only on a row tied to an eventual-consistency decision', async () => {
  const document = await templateDocument();
  const row = '| 비동기 이벤트 | CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |';
  const tied = (cited, saga = 'Outbox: 삭제와 같은 transaction에 이벤트를 기록한다') => change(document, row, `| 비동기 이벤트 | ${cited} | ${saga} |`);
  failing(tied('-'), 'SAGA_WITHOUT_EVENTUAL', INTEGRATION_DESIGN);
  failing(tied('CON-05'), 'SAGA_WITHOUT_EVENTUAL', INTEGRATION_DESIGN);
  failing(change(tied('CON-01'), '| 게시글, 신고 | - | 최종 |', '| 게시글, 신고 | - | 즉시 |'), 'SAGA_WITHOUT_EVENTUAL', INTEGRATION_DESIGN);
  failing(tied('-', 'Saga: 보상 transaction'), 'SAGA_WITHOUT_EVENTUAL', INTEGRATION_DESIGN);
  const refused = failing(tied('-'), 'SAGA_WITHOUT_EVENTUAL', INTEGRATION_DESIGN).errors[0];
  assert.deepEqual([refused.id, refused.owner_stage], ['INT-01', INTEGRATION_DESIGN]);
  assert.match(refused.message, /INT-01 chooses Outbox: .* but cites no eventual-consistency \(최종\) decision of section 2\.3/);
  // Tied to an eventual decision it may choose either; a row without one writes nothing or `없음 — <reason>`; nothing else is asked of section 5.
  passes(tied('CON-01'));
  passes(tied('CON-01', 'Saga: 보상 transaction'));
  passes(tied('-', '없음 — 이벤트를 곧바로 발행한다'));
  passes(tied('-', '없음'));
  passes(tied('-', ''));
  passes(tied('CON-01', '없음 — 이벤트를 곧바로 발행한다'));
  passes(document.replace(/^\| INT-01 .*\n/m, ''));
  passes(document.replace(/^\| INT-01 .*\n/m, '').replace('| INT | 상류 BC |', '해당 없음 — 컨텍스트 하나다\n\n| INT | 상류 BC |'));
  passes(change(document, '| INT | 상류 BC | 하류 BC | 명령 | 응답 | 이벤트 | 통신 방식 | 일관성 결정 | Saga·Outbox | 근거·출처 |', '| INT | 상류 BC | 하류 BC | 통신 방식 | 일관성 결정 | 근거·출처 |').replace('|---|---|---|---|---|---|---|---|---|---|\n| INT-01 | 커뮤니티 | 신고 | 없음 | 없음 | 게시글이 삭제됨 | 비동기 이벤트 | CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |', '|---|---|---|---|---|---|\n| INT-01 | 커뮤니티 | 신고 | 비동기 이벤트 | CON-01 |'));
});

test('contextual DDD judgement is no gate finding: it stays with the stage guides and the reviews', async () => {
  const document = await templateDocument();
  const post = '| 게시글 | 커뮤니티 | 게시글 | 게시글 ID | 게시글, 본문 |';
  const report = '| 신고 | 신고 | 신고 | 신고 ID | 신고 | `신고.접수()`, `신고.닫기()` | 대상은 게시글 ID로만 가진다 |\n';
  const ds = /^\| DS-01 .*\n/m.exec(document)[0];
  const mutations = {
    'Root is not an Entity': change(document, post, '| 게시글 | 커뮤니티 | 본문 | 게시글 ID | 게시글, 본문 |'),
    'an Entity in no Aggregate': change(document, report, ''),
    'an Entity in two Aggregates': change(document, '| 신고 | 신고 | 신고 | 신고 ID | 신고 |', '| 신고 | 신고 | 신고 | 신고 ID | 게시글 |'),
    'a duplicated model and an invalid kind': change(change(document, '| 신고 | Entity | 신고 |', '| 신고 | Entity | 커뮤니티 | 한 번 더 | accepted-target | BIZ-03 |\n| 신고 | Entity | 신고 |'), '| 본문 | Value Object |', '| 본문 | Value Obj |'),
    'an Aggregate member that section 1 does not declare': change(document, post, '| 게시글 | 커뮤니티 | 게시글 | 게시글 ID | 게시글, 첨부 |'),
    'a Value Object enforcement that names an unrelated model': change(change(document, '| INV-01 | 게시글 | `게시글.작성()` |', '| INV-01 | 신고 | Value Object: 신고.검증() |'), '| EX-01 | - | 외부 시스템: 인증 시스템 |', '| EX-01 | - | 외부 시스템: 신고 |'),
    'a rule row that lists other Aggregates than its owner': change(document, '| INV-02 | 게시글 | `게시글.삭제()` |', '| INV-02 | 신고 | `신고.접수()` |'),
    'a rule whose decision lists another rule': change(document, '| CON-01 | INV-03 |', '| CON-01 | INV-02 |'),
    'a rule row that names an Aggregate that 2.1 lacks': change(document, '| INV-02 | 게시글 | `게시글.삭제()` |', '| INV-02 | 쓰레기 | `게시글.삭제()` |'),
    'a requirement that requirements.md does not have': change(document, '| INV-04 | 신고 | 신고 | 같은 회원의 같은 글 신고를 막는다 |\n', '| INV-04 | 신고 | 신고 | 같은 회원의 같은 글 신고를 막는다 |\n| INV-09 | 신고 | 신고 | 없는 규칙이다 |\n'),
    'a Domain Service that is missing, redundant, empty or unknown': [document.replace(ds, ''), change(document, '| 신고 | INV-04 | `중복 신고 판정.판정()` |', '| 신고 | INV-01 | `중복 신고 판정.판정()` |'), change(document, '| 신고 | INV-04 | `중복 신고 판정.판정()` |', '| 신고 | - | - |'), change(document, '| 신고 | INV-04 |', '| 신고 | INV-77 |')],
    'a section 3 that says nothing': document.replace(/\| DS \| 이름 \|[\s\S]*?(?=\n\nDomain Service는)/, ''),
    'a business activity with no Application Service': change(document, '| 신고 | BIZ-03 |', '| 신고 | BIZ-09 |'),
    'a missing transaction boundary or an unknown consistency in it': [change(document, '| T1: 게시글 | 게시글 | 없음 |\n| AS-02', '| | 게시글 | 없음 |\n| AS-02'), change(document, '| T2: 신고 (CON-01) |', '| T2: 신고 (CON-09) |')],
    'a decision history that is missing a stage or a source': [change(document, '| DEC-01 | domain-model |', '| DEC-01 | domain-service |'), change(document, '| 새 게시물 모델 | `src/community/post.ts:12`, BIZ-01 |', '| 새 게시물 모델 | - |')],
    'an incomplete integration row, or a cross-context decision with none': [change(document, '| 커뮤니티 | 신고 | 없음 | 없음 | 게시글이 삭제됨 | 비동기 이벤트 |', '| 커뮤니티 | 신고 | 없음 | 없음 | 게시글이 삭제됨 | |'), document.replace(/^\| INT-01 .*\n/m, '')],
    'an eventual decision that spans one Aggregate, or a repeated decision': [change(document, '| 게시글, 신고 | - | 최종 |', '| 게시글 | - | 최종 |'), change(document, '\n\n`일관성`은', '\n| CON-01 | INV-03 | 게시글, 신고 | - | 최종 | 한 번 더 | answers.json `<question_id>` |\n\n`일관성`은')],
    'an eventual Saga choice that is left blank': change(document, '| CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |', '| CON-01 | |'),
  };
  for (const [what, variants] of Object.entries(mutations)) for (const variant of [variants].flat()) passes(variant, undefined, what);
  // Immediate consistency is never a merge and never an INT row: the decision may span Aggregates of one context or of several.
  const immediate = (text) => change(text, '| 게시글, 신고 | - | 최종 |', '| 게시글, 신고 | - | 즉시 |').replace('| T2: 신고 (CON-01) |', '| T2: 신고 |').replace('| 비동기 이벤트 | CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |', '| 비동기 이벤트 | CON-01 | 없음 — 이벤트를 곧바로 발행한다 |');
  passes(immediate(document));
  passes(immediate(change(document, '| 신고 | 신고 | 신고 | 신고 ID | 신고 |', '| 신고 | 커뮤니티 | 신고 | 신고 ID | 신고 |')));
  // A bounded context with no state lifecycle needs no Aggregate and no reason for it, but its rules are still enforced.
  passes(change(STATELESS_DOCUMENT, '| 계산기 | 상태와 생애주기가 없다. 계산 요청과 결과는 값으로만 존재한다 |\n', ''), STATELESS_REQUIREMENTS);
  passes(change(STATELESS_DOCUMENT, '| 계산 요청 | Value Object | 계산기 |', '| 계산 요청 | Entity | 계산기 |'), STATELESS_REQUIREMENTS);
  failing(change(STATELESS_DOCUMENT, '| INV-01 | - | Value Object: 계산 요청.생성() | 값 안 |\n', ''), 'RULE_NO_ENFORCEMENT', AGGREGATE_DESIGN, STATELESS_REQUIREMENTS);
  failing(change(STATELESS_DOCUMENT, '| INV-01 | 계산기 | 계산 요청 | 지원하는 연산자는 요청의 값이 정한다 |\n', ''), 'RULE_NO_OWNER', DOMAIN_MODEL, STATELESS_REQUIREMENTS);
});

test('the three false positives of a real run stay gone: a Value Object without Aggregate, a read-only Aggregate, an immediate decision across contexts', () => {
  // A context of Value Objects declares no Aggregate and no Root, and `Value Object: <모델>` needs no method.
  passes(READ_ONLY_DOCUMENT, READ_ONLY_REQUIREMENTS);
  // The decision is 즉시 across contexts and the Aggregates are not merged; the rows list the Aggregate they change, or all of them.
  passes(READ_ONLY_DOCUMENT.replace('| EX-03 | 커뮤니티 글 | `커뮤니티 글.인증된 사용자 확인()` | CON-01 |', '| EX-03 | 사용자, 커뮤니티 글 | `커뮤니티 글.인증된 사용자 확인()` | CON-01 |'), READ_ONLY_REQUIREMENTS);
  passes(READ_ONLY_DOCUMENT.replace(/\| 조회 전용 Aggregate /, '').replace('| 사용자 | 즉시 |', '| 즉시 |').replace('|---|---|---|---|---|---|---|\n| CON-01', '|---|---|---|---|---|---|\n| CON-01'), READ_ONLY_REQUIREMENTS);
  // What it still enforces about that document: the decision is judged for its kind and source because EX-03 spans both Aggregates through it.
  failing(READ_ONLY_DOCUMENT.replace('requirements.md BIZ-03, EX-03, EX-04; CONTEXT-MAP.md `## 3`', '요청 해석(에이전트 제안)'), 'DECISION_NO_SOURCE', AGGREGATE_DESIGN, READ_ONLY_REQUIREMENTS);
  failing(READ_ONLY_DOCUMENT.replace('| 사용자 | 즉시 |', '| 사용자 | 곧 |'), 'DECISION_KIND_INVALID', AGGREGATE_DESIGN, READ_ONLY_REQUIREMENTS);
  failing(READ_ONLY_DOCUMENT.replace('| EX-03, EX-04, 이벤트: 인증 성공 수신 |', '| EX-04 |').replace('| EX-03 | 커뮤니티 글 | `커뮤니티 글.인증된 사용자 확인()` | CON-01 |', '| EX-03 | 사용자, 커뮤니티 글 | `커뮤니티 글.인증된 사용자 확인()` | 값 안 |'), 'CROSS_AGGREGATE_NO_DECISION', AGGREGATE_DESIGN, READ_ONLY_REQUIREMENTS);
  failing(READ_ONLY_DOCUMENT.replace('| T1: 사용자 |', '| T1: 사용자, 커뮤니티 글 |'), 'MULTI_AGGREGATE_TRANSACTION', APPLICATION_SERVICE, READ_ONLY_REQUIREMENTS);
});

test('the final gate requires each integration to have a complete, sourced boundary decision', async () => {
  const document = await templateDocument();
  const missing = document.replace(/^\| 커뮤니티 \| 신고 \|.*\n/m, '');
  failing(missing, 'INTEGRATION_BOUNDARY_MISSING', CONTEXT_BOUNDARY, REQUIREMENTS);
  const incomplete = document.replace('| 커뮤니티 | 신고 | 관계 패턴은 근거가 말해 주는 경우에만 기록 | section 5에서 쓰는 코드 의존 형태 | 코드 경계에 적합한 검사 방식, 미정이면 근거와 함께 미정 | 각 컨텍스트가 자기 데이터 소유, 다른 테이블·Repository 접근과 내부 타입 전달 금지 | CONTEXT-MAP.md `## 3`, INT-01 |', '| 커뮤니티 | 신고 | - | section 5에서 쓰는 코드 의존 형태 | 코드 경계에 적합한 검사 방식 | 각 컨텍스트가 자기 데이터를 소유한다 | - |');
  failing(incomplete, 'BOUNDARY_DECISION_INCOMPLETE', CONTEXT_BOUNDARY, REQUIREMENTS);
  const emptyBoundary = document.replace(/^\| 커뮤니티 \| 신고 \|.*\n/m, '');
  failing(emptyBoundary, 'BOUNDARY_DECISION_MISSING', CONTEXT_BOUNDARY, REQUIREMENTS);
});

test('the findings come earliest stage first, so the first one names the stage to reopen', async () => {
  const document = await templateDocument();
  const broken = [
    ['| CON-01 | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |', '| - | Outbox: 삭제와 같은 transaction에 이벤트를 기록한다 |'],
    ['| T1: 신고 | 신고 |', '| T1: 신고, 게시글 | 신고 |'],
    ['answers.json `<question_id>` |\n\n`일관성`은', '요청 해석(에이전트 제안) |\n\n`일관성`은'],
    ['| BIZ-03 | 신고 | 신고 | 신고를 접수한다 |\n', ''],
  ].reduce((text, [from, to]) => change(text, from, to), document);
  assert.deepEqual(run(broken).errors.map((error) => [error.code, error.owner_stage]), [['BIZ_UNMAPPED', DOMAIN_MODEL], ['DECISION_NO_SOURCE', AGGREGATE_DESIGN], ['MULTI_AGGREGATE_TRANSACTION', APPLICATION_SERVICE], ['SAGA_WITHOUT_EVENTUAL', INTEGRATION_DESIGN]]);
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
  assert.deepEqual(JSON.parse(failed.stdout).errors.map((error) => [error.code, error.owner_stage]), [['SECTION_MISSING', APPLICATION_SERVICE], ['SECTION_MISSING', INTEGRATION_DESIGN], ['SECTION_MISSING', CONTEXT_BOUNDARY]]);
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
  assert.deepEqual(codes(failing), ['SECTION_MISSING', 'SECTION_MISSING', 'SECTION_MISSING', 'SECTION_MISSING']);

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

test('a legacy numbered design retains the final whole-document check', async (t) => {
  const document = await templateDocument();
  const input = (skill, planSetId = 'set') => ({ skill, context: planSetId ? { plan_set_id: planSetId } : {} });
  const failingDocument = document.replace(/^(\| CON-01 \|.*\| )answers\.json `<question_id>` \|$/m, '$1에이전트 제안 |');
  assert.notEqual(failingDocument, document);
  const root = await planSetWorkspace(t, { 'requirements.md': REQUIREMENTS, 'tactical-design.md': failingDocument });

  // A finding of an earlier stage's section is reported against that stage, on the last stage's result.
  const verdict = await evaluateTacticalDesignGate({ root, input: input(CONTEXT_BOUNDARY), envelope: completed });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.stage, CONTEXT_BOUNDARY);
  assert.deepEqual(verdict.errors.map((error) => [error.code, error.id, error.owner_stage]), [['DECISION_NO_SOURCE', 'CON-01', AGGREGATE_DESIGN]]);
  await assert.rejects(assertTacticalDesignGate({ root, input: input(CONTEXT_BOUNDARY), envelope: completed }), (error) => {
    assert.ok(error instanceof TacticalGateError);
    assert.deepEqual(error.verdict, verdict);
    assert.match(error.message, /^Tactical design gate failed for context-boundary: DECISION_NO_SOURCE \(CON-01\) \[aggregate-design\] CON-01 has no source/);
    return true;
  });

  // Legacy partial documents defer the findings until the last stage.
  for (const stage of [DOMAIN_MODEL, AGGREGATE_DESIGN, DOMAIN_SERVICE, APPLICATION_SERVICE, INTEGRATION_DESIGN]) {
    assert.deepEqual(await assertTacticalDesignGate({ root, input: input(stage), envelope: completed }), { stage, ok: true, skipped: true, errors: [] });
  }
  const partial = await planSetWorkspace(t, { 'requirements.md': REQUIREMENTS, 'tactical-design.md': upTo(document, 1) });
  for (const stage of [DOMAIN_MODEL, AGGREGATE_DESIGN, DOMAIN_SERVICE, APPLICATION_SERVICE, INTEGRATION_DESIGN]) assert.equal((await assertTacticalDesignGate({ root: partial, input: input(stage), envelope: completed })).skipped, true, `${stage} with only section 1`);
  for (const envelope of [{ status: 'blocked', code: 'INPUT_MISSING' }, { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE' }, { status: 'action_required', code: 'USER_DECISION_REQUIRED' }, { status: 'failed', code: 'EXECUTION_ERROR' }]) assert.equal(await evaluateTacticalDesignGate({ root, input: input(CONTEXT_BOUNDARY), envelope }), null, envelope.code);
  assert.equal(await evaluateTacticalDesignGate({ root, input: input('requirements-fix'), envelope: completed }), null, 'another stage');
  assert.equal(await evaluateTacticalDesignGate({ root, input: input(CONTEXT_BOUNDARY, null), envelope: completed }), null, 'no plan set');
  assert.equal(await assertTacticalDesignGate({ root, input: input('to-ticket'), envelope: completed }), null);

  // The last stage is accepted once the whole document passes, and an incomplete document fails it.
  await writeFile(join(root, 'docs/specs/set/tactical-design.md'), document);
  assert.deepEqual(await assertTacticalDesignGate({ root, input: input(CONTEXT_BOUNDARY), envelope: completed }), { stage: CONTEXT_BOUNDARY, ok: true, errors: [] });
  await writeFile(join(root, 'docs/specs/set/tactical-design.md'), upTo(document, 4));
  assert.deepEqual((await evaluateTacticalDesignGate({ root, input: input(CONTEXT_BOUNDARY), envelope: completed })).errors.map((error) => [error.code, error.owner_stage]), [['SECTION_MISSING', INTEGRATION_DESIGN], ['SECTION_MISSING', CONTEXT_BOUNDARY]]);
});

test('the rejection tells the stage to repair its own section, or to block and name the earlier stage to reopen', () => {
  const verdict = (...owners) => ({ stage: CONTEXT_BOUNDARY, ok: false, errors: owners.map((owner_stage, index) => ({ code: 'X', message: 'm', id: `ID-${index}`, owner_stage })) });
  const own = gateFailureInstruction(verdict(CONTEXT_BOUNDARY));
  assert.match(own, /once on the whole tactical-design\.md for context-boundary and it failed/);
  assert.match(own, /Nothing was committed or recorded, and the stage is still running/);
  assert.match(own, /same subagent so it repairs its own section/);
  assert.doesNotMatch(own, /DEPENDENCY_INCOMPLETE/);
  const earlier = gateFailureInstruction(verdict(DOMAIN_MODEL, AGGREGATE_DESIGN, INTEGRATION_DESIGN));
  assert.match(earlier, /owner_stage is domain-model, aggregate-design, integration-design are in sections of earlier stages/);
  assert.match(earlier, /returns blocked \/ DEPENDENCY_INCOMPLETE with result\.owner_stage domain-model \(the earliest stage to reopen\)/);
  assert.match(earlier, /without editing any earlier section/);
  assert.match(earlier, /reopens domain-model itself with --reopen-for/);
});

test('the runner gate refuses a document that is a symlink out of the workspace', async (t) => {
  const document = await templateDocument();
  const root = await planSetWorkspace(t, { 'requirements.md': REQUIREMENTS });
  const outside = await planSetWorkspace(t, { 'tactical-design.md': document });
  await symlink(join(outside, 'docs/specs/set/tactical-design.md'), join(root, 'docs/specs/set/tactical-design.md'));
  await assert.rejects(assertTacticalDesignGate({ root, input: { skill: CONTEXT_BOUNDARY, context: { plan_set_id: 'set' } }, envelope: completed }), /outside case workspace/);
});
