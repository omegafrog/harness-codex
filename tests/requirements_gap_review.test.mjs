import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRequirementsDocument, evaluateRequirementsDocumentGate } from '../.harness/src/workflow/requirements-document-gate.mjs';
import { finishNext } from '../.harness/src/workflow/stage-cli.mjs';
import { STAGE_REFERENCES, MAX_INLINED_REFERENCE_BYTES, referenceBlocks } from '../.harness/src/workflow/stage-references.mjs';
import { SOLO_STAGE_SKILLS } from '../.harness/src/workflow/stage-runtime.mjs';
import { transformSourceContent } from '../.harness/src/installer/transforms.mjs';
import { FRESH_AGENT_TYPES, freshAgentDecision } from '../.harness/scripts/harness-fresh-agent.mjs';
import { consumerWorkflow, sourceRoot } from './support/consumer-workflow.mjs';

const read = (path) => readFile(join(sourceRoot, path), 'utf8');
const ITEMS = ['데이터 출처', '표시 항목', '누락·부분 데이터', '빈 상태', '불러오기 실패'];
const BIZ = (id = 'BIZ-01') => `### ${id} 장소 보기 (SD-01)

- 상태: draft
- 정상 시나리오:
  1. SC-01 방문자가 지도에서 핀 목록을 본다
- 업무 규칙:
  - INV-01 장소는 준비된 고정 데이터에서 온다 — 출처: answers.json \`e:2\`
- 예외 시나리오:
  - EX-01 위치 정보가 없는 항목은 목록에 표시하지 않는다 — 출처: answers.json \`e:1\`
- 완료 조건:
  - AC-01 [SC-01] 준비된 장소가 핀으로 보인다
`;
const DISPLAY = `\n### 6.5 조회·표시 점검\n\n| BIZ | 자료 | 항목 | 판정 | 근거 |\n|---|---|---|---|---|\n${ITEMS.map((item) => `| BIZ-01 | ${item === '데이터 출처' || item === '불러오기 실패' ? '장소 목록' : '전체'} | ${item} | 확정 | ${item === '누락·부분 데이터' || item === '불러오기 실패' ? 'EX-01' : 'INV-01'} |`).join('\n')}\n`;
const gapTable = (...rows) => `\n### 6.6 빈틈 검토\n\n| GAP | BIZ | 추측해야 하는 것 | 처리 | 근거 |\n|---|---|---|---|---|\n${rows.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n`;
const NONE = '\n### 6.6 빈틈 검토\n\n없음 — 검토자가 실행됐고 남은 추측이 없다\n';
const doc = (gaps, display = DISPLAY) => `# 요구사항 명세\n\n## 2. 업무\n\n${BIZ()}\n## 6. 공통\n\n### 6.1 범위·비목표\n\n- 포함: 지도\n${display}${gaps}`;
const check = (text, stage = 'requirements-fix', analysis = null) => checkRequirementsDocument({ requirements: text, stage, complete: true, analysis });
const codes = (verdict) => verdict.errors.map(({ code }) => code);

const resourceOf = (item) => item === '데이터 출처' || item === '불러오기 실패' ? '장소 목록' : '전체';
const REVIEWED = ITEMS.filter((item) => item !== '빈 상태').map((item) => ({ biz: 'BIZ-01', resource: resourceOf(item), item, answered: true, why: '문장이 답한다' }))
  .concat([{ biz: 'BIZ-01', resource: '전체', item: '빈 상태', answered: true, why: '업무 이유' }]);
const output = (extra = {}) => ({ rows: REVIEWED, gaps: [], missing_resources: [], ...extra });

test('6.6 is required at requirements-fix completion: a table of judged rows or the one `없음 — reason` line', () => {
  assert.deepEqual(codes(check(doc(NONE))), []);
  assert.deepEqual(codes(check(doc(gapTable(['GAP-01', 'BIZ-01', '글을 지우면 달린 댓글이 보이는지', '확정', 'INV-01'])))), []);
  assert.deepEqual(codes(check(doc(gapTable(['GAP-01', 'BIZ-01', '핀을 누르면 무엇이 보이는지', '해당 없음', '이 업무는 지도에 핀을 그리기만 하고 누르는 동작을 다루지 않는다'])))), []);
  assert.deepEqual(codes(check(doc(''))), ['GAP_REVIEW_INCOMPLETE'], 'the section is required');
  assert.equal(check(doc('')).errors[0].owner_stage, 'requirements-fix');
  const bad = (...row) => check(doc(gapTable(row)));
  assert.deepEqual(codes(bad('GAP-01', 'BIZ-01', '추측', '확정', '요청 원문')), ['GAP_REVIEW_INCOMPLETE'], 'no id cited');
  assert.deepEqual(codes(bad('GAP-01', 'BIZ-01', '추측', '확정', 'INV-09')), ['GAP_REVIEW_INCOMPLETE'], 'an id of nowhere');
  assert.deepEqual(codes(bad('GAP-01', 'BIZ-09', '추측', '확정', 'INV-01')), ['GAP_REVIEW_INCOMPLETE'], 'not a BIZ of the document');
  assert.deepEqual(codes(bad('GAP-01', 'BIZ-01', '추측', '해당 없음', '요청에 없음')), ['GAP_REVIEW_INCOMPLETE'], 'the 6.5 reason rules apply');
  assert.deepEqual(codes(bad('GAP-01', 'BIZ-01', '추측', '미정', 'INV-01')), ['GAP_REVIEW_INCOMPLETE'], 'only 확정 or 해당 없음');
  assert.deepEqual(codes(bad('1', 'BIZ-01', '추측', '확정', 'INV-01')), ['GAP_REVIEW_INCOMPLETE'], 'GAP id shape');
  assert.deepEqual(codes(check(doc(gapTable(['GAP-01', 'BIZ-01', '추측', '확정', 'INV-01'], ['GAP-01', 'BIZ-01', '또 추측', '확정', 'INV-01'])))), ['GAP_REVIEW_INCOMPLETE'], 'a GAP id is used once');
  assert.deepEqual(codes(check(doc('\n### 6.6 빈틈 검토\n\n없음\n'))), ['GAP_REVIEW_INCOMPLETE'], 'a bare 없음 has no reason');
  assert.match(bad('GAP-01', 'BIZ-01', '추측', '확정', 'INV-09').errors[0].message, /6\.6 GAP-01 \(BIZ-01\)/);
});

test('6.6 has the exemptions of 6.5 and bounded-context checks it only when present', () => {
  assert.deepEqual(codes(check(doc(''), 'bounded-context')), [], 'absent at bounded-context');
  assert.deepEqual(codes(check(doc(gapTable(['GAP-01', 'BIZ-01', '추측', '확정', 'INV-09'])), 'bounded-context')), ['GAP_REVIEW_INCOMPLETE'], 'present and wrong at bounded-context');
  assert.deepEqual(codes(check(doc(NONE), 'bounded-context')), []);
  assert.deepEqual(codes(check(doc(''), 'requirements-fix', '# 분석\n\n- 판정: 생략\n')), [], 'a skipped analysis');
  assert.deepEqual(codes(check(doc('', '').replace('## 2. 업무', '## 2. 이벤트 흐름'))), [], 'an unnumbered document');
  assert.deepEqual(codes(checkRequirementsDocument({ requirements: doc(''), stage: 'requirements-fix', complete: false })), [], 'only completion checks');
});

test('runner evidence: the hook record shows the reviewer ran and every gap it returned has a row', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gap-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = 'community';
  const write = async (path, text) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); };
  const record = (...events) => write('.io/runtime/executions/rf-1/subagents.jsonl', `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const reviewer = (result) => [{ event: 'SubagentStart', agent_id: 'r1', agent_type: 'requirements_gap_reviewer' }, { event: 'SubagentStop', agent_id: 'r1', agent_type: 'requirements_gap_reviewer', result: typeof result === 'string' ? result : JSON.stringify(result) }];
  const gap = (biz = 'BIZ-01') => ({ biz, gap: '삭제 뒤 댓글', why_it_changes_the_result: '댓글이 남거나 사라진다', quote: '게시글 삭제' });
  const gate = async (requirements) => {
    await write(`docs/specs/${plan}/requirements.md`, requirements);
    return evaluateRequirementsDocumentGate({ root, input: { skill: 'requirements-fix', execution_id: 'rf-1', context: { plan_set_id: plan } }, envelope: { status: 'completed', code: 'OK' } });
  };
  const withGap = doc(gapTable(['GAP-01', 'BIZ-01', '삭제 뒤 댓글이 보이는지', '확정', 'INV-01']));

  // No hook log at all (nothing recorded this execution, provider unknown): the document check alone applies.
  assert.equal((await gate(doc(NONE))).ok, true);
  await record({ event: 'SubagentStart', agent_id: 'w1', agent_type: 'workflow_stage' });
  const never = await gate(doc(NONE));
  assert.equal(never.ok, false);
  assert.match(never.errors[0].message, /recorded no finished requirements_gap_reviewer/);
  await record(...reviewer(output()));
  assert.equal((await gate(doc(NONE))).ok, true, 'it ran and found nothing');
  await record(...reviewer(output({ gaps: [gap()] })));
  const missing = await gate(doc(NONE));
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0].message, /returned 1 gap\(s\) for BIZ-01 but 6\.6 has 0 row/);
  assert.equal((await gate(withGap)).ok, true, 'every returned gap has a row');
  await record(...reviewer(output({ gaps: [gap(), gap()] })));
  assert.equal((await gate(withGap)).ok, false, 'two gaps, one row');
  await record(...reviewer('not json'));
  assert.match((await gate(withGap)).errors[0].message, /not the JSON object/);
  await record(...reviewer('```json\n' + JSON.stringify(output()) + '\n```'));
  assert.equal((await gate(doc(NONE))).ok, true, 'a fenced answer is read');
  await record(...reviewer({ gaps: [] }));
  assert.match((await gate(doc(NONE))).errors[0].message, /no "rows" and "missing_resources"[\s\S]*Run the review again/, 'output of the older GUIDE is refused');

  // Regression of the live miss (a): the live INV-01 names no source but already cites an answer, of event-storming. Unchanged, it must not pass.
  const LIVE = '  - INV-01 지도를 열 때마다 최신 준비된 장소를 핀으로 표시한다 — 출처: answers.json `event-storming-d6a6f1a6-4749-4d3e-9fa3-6f3174c76ecc:1`';
  const live = (text) => text.replace(/  - INV-01 .*/, LIVE);
  const unanswered = output({ rows: REVIEWED.map((row) => row.item === '데이터 출처' ? { ...row, answered: false } : row) });
  await record(...reviewer(unanswered));
  const same = await gate(live(doc(NONE)));
  assert.equal(same.ok, false);
  assert.match(same.errors[0].message, /"데이터 출처".*does not itself answer the item and the row is unchanged/);
  // For a BIZ that shows data 해당 없음 is refused by the display rules, so the way out is a 확정 by an id of this chain's own recorded answer.
  const settleWith = (cite) => live(doc(NONE)).replace('| BIZ-01 | 장소 목록 | 데이터 출처 | 확정 | INV-01 |', '| BIZ-01 | 장소 목록 | 데이터 출처 | 확정 | INV-02 |')
    .replace(LIVE, `  - INV-02 장소 목록은 운영자가 미리 정해 둔 고정 장소다 — 출처: answers.json \`${cite}\`\n${LIVE}`);
  assert.equal((await gate(settleWith('event-storming-d6a6f1a6-4749-4d3e-9fa3-6f3174c76ecc:1'))).ok, false, 'an earlier stage\'s answer does not settle it');
  assert.equal((await gate(settleWith('rf-1:4'))).ok, false, 'a made-up id of this chain has no recorded answer');
  assert.equal((await gate(settleWith('요청 해석(에이전트 제안)'))).ok, false, 'the author\'s own sentence does not settle it');
  await write('.io/runtime/executions/rf-1/decision-answers.json', JSON.stringify([{ question_id: 'rf-1:4', answer: '운영자가 미리 정해 둔 고정 장소 (A)' }]));
  assert.equal((await gate(settleWith('rf-1:4'))).ok, true, 'a recorded answer of this chain settles it');
  assert.equal((await gate(settleWith('rf-1:5'))).ok, false, 'only the recorded question id counts');
  // An answer recorded before the review does not settle a row the review judged afterwards.
  await record(...reviewer(unanswered).map((event) => ({ ...event, recorded_at: '2999-01-01T00:00:00.000Z' })));
  assert.equal((await gate(settleWith('rf-1:4'))).ok, false, 'the answer is older than the review');
  await record(...reviewer(unanswered));
  await rm(join(root, '.io/runtime/executions/rf-1/decision-answers.json'));

  // Regression of the live miss (b): the map screen itself has no rows; the reviewer names it.
  await record(...reviewer(output({ missing_resources: [{ biz: 'BIZ-01', resource: '지도 화면', why: '화면 자체의 불러오기' }] })));
  const noResource = await gate(doc(NONE));
  assert.equal(noResource.ok, false);
  assert.match(noResource.errors.map((error) => error.message).join('\n'), /resource "지도 화면" of BIZ-01 as missing, but 6\.5 has no "데이터 출처" row/);
  const withMap = doc(NONE, DISPLAY.replace('| BIZ-01 | 장소 목록 | 불러오기 실패 | 확정 | EX-01 |', '| BIZ-01 | 장소 목록 | 불러오기 실패 | 확정 | EX-01 |\n| BIZ-01 | 지도 화면 | 불러오기 실패 | 확정 | EX-01 |').replace('| BIZ-01 | 장소 목록 | 데이터 출처 | 확정 | INV-01 |', '| BIZ-01 | 장소 목록 | 데이터 출처 | 확정 | INV-01 |\n| BIZ-01 | 지도 화면 | 데이터 출처 | 확정 | INV-01 |'));
  const added = await gate(withMap);
  assert.equal(added.ok, true, 'the named resource now has both rows (the unseen-row check is per BIZ and item, not per resource)');
  // Questions are returned before the review's rows exist: only completion needs the evidence.
  await write(`docs/specs/${plan}/requirements.md`, doc(''));
  await record({ event: 'SubagentStart', agent_id: 'w1', agent_type: 'workflow_stage' });
  const asking = await evaluateRequirementsDocumentGate({ root, input: { skill: 'requirements-fix', execution_id: 'rf-1', context: { plan_set_id: plan } }, envelope: { status: 'action_required' } });
  assert.equal(asking.ok, true);
});

test('a review older than the latest reopen of requirements-fix does not count', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gap-review-since-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = 'community';
  const write = async (path, text) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); };
  const input = (id, context) => ({ schema_version: 1, execution_id: id, skill: 'requirements-fix', context: { stage_id: 'requirements-fix', plan_set_id: plan, ...context } });
  await write(`.io/${plan}/requirements-fix/rf-old/input.json`, JSON.stringify(input('rf-old', {})));
  await write(`.io/${plan}/requirements-fix/rf-new/input.json`, JSON.stringify(input('rf-new', { reopen: { reason: 'dependency_gap' } })));
  await write('.io/runtime/orchestrator/state.json', JSON.stringify({ orchestrator_provider: 'codex', stages: { 'requirements-fix': { execution_id: 'rf-new', started_at: '2026-02-01T00:00:00.000Z', attempts: [{ execution_id: 'rf-old', started_at: '2026-01-01T00:00:00.000Z' }] } } }));
  await write(`docs/specs/${plan}/requirements.md`, doc(NONE));
  const stop = (recorded_at) => `${JSON.stringify({ event: 'SubagentStop', agent_id: 'r', agent_type: 'requirements_gap_reviewer', result: JSON.stringify(output()), recorded_at })}\n`;
  const gate = () => evaluateRequirementsDocumentGate({ root, input: { skill: 'requirements-fix', execution_id: 'rf-new', context: { plan_set_id: plan } }, envelope: { status: 'completed', code: 'OK' } });
  await write('.io/runtime/executions/rf-old/subagents.jsonl', stop('2026-01-15T00:00:00.000Z'));
  await write('.io/runtime/executions/rf-new/subagents.jsonl', '{"event":"SubagentStart","agent_id":"w","agent_type":"workflow_stage"}\n');
  const stale = await gate();
  assert.equal(stale.ok, false);
  assert.match(stale.errors[0].message, /older than the latest reopen/);
  await write('.io/runtime/executions/rf-new/subagents.jsonl', stop('2026-02-02T00:00:00.000Z'));
  assert.equal((await gate()).ok, true, 'a review after the reopen counts');
});

test('the reviewer profile, GUIDE and stage lists', async () => {
  const toml = await read('.codex/agents/requirements_gap_reviewer.toml');
  assert.match(toml, /^name = "requirements_gap_reviewer"$/m);
  assert.match(toml, /^sandbox_mode = "read-only"$/m);
  const claude = transformSourceContent(Buffer.from(toml), 'claude-agent-v1');
  assert.match(claude, /^permissionMode: plan$/m);
  assert.match(claude, /^tools: Read, Grep, Glob, WebSearch, WebFetch$/m, 'read-only: no Bash, Edit, Write or Agent');
  const guide = await read('.harness/internal-skills/requirements-gap-review/GUIDE.md');
  assert.match(guide, /^---\nmodel_tier: low_performance\n---/);
  for (const needle of ['at most 8', 'two reasonable builders', 'why_it_changes_the_result', 'quote', 'empty list is a good answer|An empty list is a good answer', 'technology choice']) assert.match(guide, new RegExp(needle, 'i'), needle);
  assert.ok(FRESH_AGENT_TYPES.includes('requirements_gap_reviewer'));
  assert.match(await read('.harness/src/workflow/execution-audit.mjs'), /'requirements_gap_reviewer'/);
  assert.match(await read('.claude/harness/scripts/harness-agent-admission.mjs'), /requirements_gap_reviewer: 'requirements-gap-review'/);
  assert.ok(!SOLO_STAGE_SKILLS.includes('requirements-fix'), 'requirements-fix spawns the reviewer, so it keeps the profile with the Agent tool');
  assert.ok(SOLO_STAGE_SKILLS.includes('bounded-context'));
  // A forked start is denied like the other fresh agents.
  assert.match(freshAgentDecision({ hook_event_name: 'PreToolUse', tool_name: 'spawn_agent', cwd: tmpdir(), tool_input: { agent_type: 'requirements_gap_reviewer', fork_turns: 'all' } }), /fresh context/);
});

test('requirements-fix GUIDE: steps are numbered once and in order, cross references point at the right step, the reviewer is run once and merged into one batch', async () => {
  const guide = await read('.harness/internal-skills/requirements-fix/GUIDE.md');
  const numbers = [...guide.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
  assert.deepEqual(numbers, numbers.map((_, index) => index + 1), 'no number is used twice');
  const step = (n) => guide.split('\n').find((line) => line.startsWith(`${n}. `));
  assert.match(step(7), /requirements_gap_reviewer/);
  assert.match(step(7), /once per execution attempt chain/);
  assert.match(step(7), /verbatim/);
  assert.match(step(7), /gap_reviewer_binding/);
  assert.match(step(8), /빈틈/, 'the gaps join the one question batch');
  assert.match(step(8), /가장 작은 선택지/);
  assert.match(step(4), /Continue at step 9/);
  assert.match(step(9), /^9\. 답변마다/);
  assert.match(step(8), /10단계로 간다/);
  assert.match(step(10), /^10\. Write what remains/);
  assert.match(step(10), /6\.1`–`6\.6/);
  assert.match(step(11), /go back to step 8 for the failing rows/);
  assert.doesNotMatch(guide, /step 6\b|8단계|9단계로|step 7 for/);
  const template = await read('.harness/internal-skills/requirements-fix/references/template.md');
  assert.match(template, /^### 6\.6 빈틈 검토$/m);
  assert.match(template, /\| GAP \| BIZ \| 추측해야 하는 것 \| 처리 \| 근거 \|/);
  assert.match(await read('.harness/internal-skills/requirements-fix/references/coverage.md'), /### 6\.6|`### 6\.6`/);
});

test('requirements-fix still inlines its references within the cap', () => {
  const blocks = referenceBlocks(sourceRoot, 'requirements-fix');
  assert.ok(blocks.length, 'the references are inlined, not degraded to paths');
  const text = blocks.join('\n');
  assert.ok(Buffer.byteLength(text) <= MAX_INLINED_REFERENCE_BYTES, `${Buffer.byteLength(text)} bytes`);
  assert.match(text, /### 6\.6 빈틈 검토/);
  assert.ok(STAGE_REFERENCES['requirements-fix'].length >= 2);
});

test('the finish instruction of bounded-context reopens requirements-fix instead of asking for approval when the recheck fails', () => {
  const base = { status: 'completed', code: 'OK', stageId: 'bounded-context', executionId: 'bc-1', provider: 'codex' };
  assert.match(finishNext({ ...base, requirementsPresent: true }), /Ask whether to approve/);
  const verdict = { applies: true, ok: false, errors: [{}], notice_ko: '요구사항 문서가 현재 검증 기준을 충족하지 못해 요구사항 작성 단계를 먼저 다시 엽니다.' };
  const next = finishNext({ ...base, requirementsPresent: true, requirementsRecheck: verdict });
  assert.match(next, /Do not ask for the requirements approval yet/);
  assert.match(next, /launch --stage-id requirements-fix --reopen-for bc-1/);
  assert.match(next, /not a user revision/);
  assert.ok(next.includes(verdict.notice_ko));
  assert.match(finishNext({ ...base, provider: 'claude-code', requirementsPresent: true, requirementsRecheck: verdict }), /Agent\(subagent_type: "workflow_stage", prompt: "harness-stage: requirements-fix --reopen-for bc-1"\)/);
  assert.match(finishNext({ ...base, requirementsPresent: true, requirementsRecheck: { applies: true, ok: true } }), /Ask whether to approve/);
});

test('Claude Code: the gap reviewer child of the running requirements-fix worker is recorded by the real hook script, and the gate fails closed without it', async (t) => {
  const flow = await consumerWorkflow(t, '게시글 삭제 기능을 추가해줘');
  const { workspace, specPath, runStage } = flow;
  const analysis = specPath('stakeholder-analysis.md');
  const requirements = specPath('requirements.md');
  await runStage('stakeholder-analysis', { files: { [analysis]: '# Stakeholder 분석\n\n- 판정: 생략\n- 근거: 기존 업무 안의 변경\n' }, artifacts: [{ path: analysis, kind: 'stakeholder_analysis' }], summary: '생략 판정' });
  for (const stage of ['subdomain-candidates', 'ubiquitous-language', 'event-storming', 'subdomain-classification']) await runStage(stage, { summary: `생략: ${analysis}`, expectCommit: false });
  const begun = await flow.beginStage('requirements-fix');
  const executionId = begun.prepared.input.execution_id;
  // Shapes of a real worktree: the dispatch directory exists, the stage is running and bound, the orchestrator session is the event's session.
  await mkdir(join(workspace, '.io/runtime/claude-dispatch'), { recursive: true, mode: 0o700 });
  // The stage helpers assert Codex model bindings, so the workflow runs as Codex and is switched to the Claude Code provider here.
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.orchestrator_provider = 'claude-code';
  await writeFile(statePath, JSON.stringify(state));
  assert.equal(state.stages['requirements-fix'].status, 'running');
  const hook = (event, agent_id, agent_type, extra = {}) => {
    const result = spawnSync(process.execPath, [join(workspace, '.harness/scripts/harness-agent-event.mjs')], { cwd: workspace, encoding: 'utf8', input: JSON.stringify({ hook_event_name: event, session_id: state.orchestrator_session_id, cwd: workspace, agent_id, agent_type, ...extra }) });
    assert.equal(result.status, 0, result.stderr);
  };
  const log = join(workspace, '.io/runtime/executions', executionId, 'subagents.jsonl');
  const gate = async () => {
    await mkdir(join(workspace, requirements, '..'), { recursive: true });
    await writeFile(join(workspace, analysis), '# Stakeholder 분석\n\n- 판정: 실행\n');
    await writeFile(join(workspace, requirements), doc(NONE));
    return evaluateRequirementsDocumentGate({ root: workspace, input: { ...begun.prepared.input, context: { ...begun.prepared.input.context, plan_set_id: flow.planSetId } }, envelope: { status: 'completed', code: 'OK' } });
  };
  // No log recorded the reviewer: Claude fails closed.
  const refused = await gate();
  assert.equal(refused.ok, false);
  assert.match(refused.errors[0].message, /No subagent hook log|recorded no finished/);
  // Another agent type is not resolved to the stage by the session; the gap reviewer is.
  hook('SubagentStart', 'child-x', 'code_researcher');
  await assert.rejects(readFile(log, 'utf8'), { code: 'ENOENT' }, 'only the gap reviewer is resolved from the session');
  hook('SubagentStart', 'child-1', 'requirements_gap_reviewer');
  hook('SubagentStop', 'child-1', 'requirements_gap_reviewer', { last_assistant_message: JSON.stringify(output({ gaps: [{ biz: 'BIZ-01', gap: '삭제 뒤 댓글', why_it_changes_the_result: '남거나 사라진다', quote: '게시글 삭제' }] })) });
  const lines = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map(({ event, agent_id, agent_type }) => [event, agent_id, agent_type]), [['SubagentStart', 'child-1', 'requirements_gap_reviewer'], ['SubagentStop', 'child-1', 'requirements_gap_reviewer']]);
  assert.match(lines[1].result, /삭제 뒤 댓글/);
  const missing = await gate();
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0].message, /returned 1 gap\(s\) for BIZ-01 but 6\.6 has 0 row/);
  hook('SubagentStart', 'child-2', 'requirements_gap_reviewer');
  hook('SubagentStop', 'child-2', 'requirements_gap_reviewer', { last_assistant_message: JSON.stringify(output()) });
  assert.equal((await gate()).ok, true, 'the later review found nothing and 6.6 says so');
});
