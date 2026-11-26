// Check BIZ field uniqueness before result acceptance and require defined INV, EX and AC entries at coverage completion.
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { sessionOutputPath } from './session-output.mjs';
import { findExecutionInput } from './execution-input.mjs';
import { join } from 'node:path';
import { clean, outsideFences, parseTables, planSetDocument, stakeholderAnalysisSkipped } from './domain-model-gate.mjs';
import { ACCESS_KIND, openFactRows } from './stakeholder-analysis-gate.mjs';
import { REQUIREMENTS_STAGES, WORKTREE_STAGE, isCurrentStage } from './worktree-stages.mjs';
import { specArtifactPath } from './worktrees.mjs';

const BIZ_HEADING = /^###[ \t]+(BIZ-\d+)\b/;
const FIELD = /^- ([^:：\n]+?)\s*[:：]/;
const SECTION_END = /^#{1,3}[ \t]/;

// An exception that only says the action is not offered, or that is marked NOT_APPLICABLE, is no failure path (EXCEPTION_NOT_FAILURE).
// Its observable outcome words (the user is told, the request is refused, the item is not shown ...) make it a real exception.
export const NOT_OFFERED = /제공(?:되지|하지) 않|동작이 없|기능이 없/;
export const FAILURE_OUTCOME = /안내|알린|알려|알림|오류|에러|거절|거부|실패|차단|보이지 않|표시하지 않|표시되지 않|나타나지 않|막는다|막힌다|취소|중단/;
export const notFailureException = (description) => /NOT_APPLICABLE/.test(description) || (NOT_OFFERED.test(description) && !FAILURE_OUTCOME.test(description));

// The older `### 6.5 조회·표시 점검` (BIZ | 자료 | 항목 | 판정 | 근거) is kept only so a document that already holds a complete one is not reopened (see allowLegacy).
// The current table is `### 6.5 업무 결정 점검` (BIZ | 축 | 대상 | 판정 | 근거), work-type neutral; see decisionCoverageErrors.
export const DISPLAY_ITEMS = ['데이터 출처', '표시 항목', '누락·부분 데이터', '빈 상태', '불러오기 실패'];
const DISPLAY_NEEDS_EX = new Set(['누락·부분 데이터', '불러오기 실패']);
const VAGUE_REASON = /요청(?:에|문에|서)?\s*(?:도\s*)?(?:없|언급|명시|포함되)|요청되지|미정|후속|추후|나중|향후|TBD|TODO|논의 필요|정해지지 않|결정되지 않/i;
const DEFINED_ID = /^[ \t]*(?:[-*][ \t]+|\d+[.)][ \t]+)?(?:(?:업무 규칙|예외 시나리오|완료 조건|정상 시나리오)[ \t]*[:：][ \t]*)?((?:SC|INV|EX|AC)-\d+)\b/;
const isDisplayTable = (table) => ['BIZ', '항목', '판정', '근거'].every((column) => table.header.includes(column));

function bizBlocks(lines) {
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const heading = BIZ_HEADING.exec(line);
    if (heading || (current && SECTION_END.test(line))) {
      current = heading ? { id: heading[1], fields: new Map(), defined: new Set(), definitions: new Map(), field: null } : null;
      if (current) blocks.push(current);
      continue;
    }
    if (!current) continue;
    const defined = DEFINED_ID.exec(line);
    if (defined) { current.defined.add(defined[1]); current.definitions.set(defined[1], line); }
    const field = FIELD.exec(line);
    if (field) current.field = field[1].trim();
    if (current.field) current.fields.set(current.field, `${current.fields.get(current.field) ?? ''}\n${field ? line.replace(FIELD, '') : line}`);
  }
  return blocks;
}

// The judgement shared by the 6.5 and 6.6 rows: 확정 cites ids defined in that BIZ; 해당 없음 gives a business reason. Returns the problem or null.
const AGENT_SOURCE = '요청 해석(에이전트 제안)';
// 확정 cites ids defined in that BIZ; 기본값 (when allowed) cites ids whose definition is sourced as the agent's own interpretation;
// 해당 없음 gives a business reason. Returns the problem or null.
function judgmentProblem(block, judgment, basis, prefix, { allowDefault = false } = {}) {
  if (judgment === '확정' || (allowDefault && judgment === '기본값')) {
    const cited = basis.match(/\b(?:SC|INV|EX|AC)-\d+\b/g) ?? [];
    const missing = cited.filter((id) => !block.defined.has(id));
    if (!cited.length) return `${prefix}판정 ${judgment} needs the ids (INV, EX, AC, SC) of this BIZ that settle it in 근거.`;
    if (missing.length) return `${prefix}근거 cites ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not defined in ${block.id}.`;
    if (judgment === '기본값' && !cited.some((id) => (block.definitions.get(id) ?? '').includes(AGENT_SOURCE))) return `${prefix}판정 기본값 needs a cited id whose definition is sourced \`${AGENT_SOURCE}\`; a decision the user made is 확정.`;
    return null;
  }
  if (judgment === '해당 없음') {
    const reason = basis.replace(/^해당 없음\s*[—–-]?\s*/, '');
    if (reason.split(/\s+/).filter(Boolean).length < 4 || VAGUE_REASON.test(reason)) return `${prefix}판정 해당 없음 needs a business reason of more than a few words. A missing or open decision ("요청에 없음", 미정, 후속) is asked as a question, not skipped.`;
    return null;
  }
  return `${prefix}판정 "${judgment}" must be 확정${allowDefault ? ', 기본값' : ''} or 해당 없음${judgment === '미정' ? '; 미정 is provisional and is not accepted at completion' : ''}.`;
}

// Resources: 데이터 출처 and 불러오기 실패 have one row per resource the BIZ's screens need (자료) and both items cover the same set; the other three
// items have one row per BIZ with 자료 `전체`. The gate cannot know the true resource list; the independent reviewer checks it (missing_resources).
const PER_RESOURCE = new Set(['데이터 출처', '불러오기 실패']);
export const WHOLE = '전체';
export const normalizeResource = (value) => clean(value).toLowerCase().replace(/[\s·,，、()（）]+/g, '');
const OLD_SHAPE = 'The `### 6.5 조회·표시 점검` table has no 자료 column (the old shape BIZ | 항목 | 판정 | 근거). Use BIZ | 자료 | 항목 | 판정 | 근거: 데이터 출처 and 불러오기 실패 get one row per resource the BIZ\'s screens need (for example the source a notification is built from and the list it is sent to), both items covering the same resources; 표시 항목, 누락·부분 데이터 and 빈 상태 stay one row per BIZ with 자료 `전체`.';

// Legacy shape only (kept for allowLegacy and for bounded-context, which checks a table that exists).
export function displayCoverageErrors({ requirements, lines = outsideFences(requirements), required = true }) {
  const tables = parseTables(requirements).filter(isDisplayTable);
  if (!tables.length) return required ? [{ code: 'DECISION_COVERAGE_INCOMPLETE', message: 'requirements.md has no `### 6.5 조회·표시 점검` table (BIZ | 자료 | 항목 | 판정 | 근거). Add one row per BIZ for each of: ' + DISPLAY_ITEMS.join(', ') + ' (데이터 출처 and 불러오기 실패 once per resource the BIZ needs). Ask every unresolved row as a concrete question in one USER_DECISION_REQUIRED batch; ask only the high-impact ones (grilling GUIDE, Decide whether to ask).', owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX }] : [];
  const errors = [];
  const report = (id, message) => errors.push({ code: 'DECISION_COVERAGE_INCOMPLETE', id, message, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
  // A table of the old shape is refused at requirements-fix completion and exempt at bounded-context completion like the other 6.5 rules.
  if (tables.some((table) => !table.header.includes('자료'))) return required ? [{ code: 'DECISION_COVERAGE_INCOMPLETE', message: OLD_SHAPE, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX }] : [];
  const rows = tables.flatMap((table) => table.rows);
  const blocks = bizBlocks(lines);
  for (const row of rows) {
    if (!blocks.some((block) => block.id === clean(row.BIZ))) report(clean(row.BIZ), `6.5 has a row for ${clean(row.BIZ) || '(no BIZ)'}, which is not a BIZ of this document.`);
    else if (!DISPLAY_ITEMS.includes(clean(row['항목']))) report(clean(row.BIZ), `6.5 row of ${clean(row.BIZ)} names the item "${clean(row['항목'])}"; the items are exactly ${DISPLAY_ITEMS.join(', ')}.`);
  }
  for (const block of blocks) {
    const resources = new Map();
    for (const item of DISPLAY_ITEMS) {
      const found = rows.filter((row) => clean(row.BIZ) === block.id && clean(row['항목']) === item);
      const whole = (message) => report(block.id, `${block.id} 6.5 "${item}": ${message}`);
      if (!found.length) { whole('there is no row. Add it (판정 확정 or 해당 없음) or, when the decision is open, ask it as a question.'); continue; }
      if (!PER_RESOURCE.has(item) && (found.length > 1 || normalizeResource(found[0]['자료']) !== normalizeResource(WHOLE))) { whole(`keep exactly one row for the BIZ with 자료 \`${WHOLE}\`; only 데이터 출처 and 불러오기 실패 have one row per resource.`); continue; }
      const seen = new Set();
      for (const row of found) {
        const resource = clean(row['자료']);
        const label = PER_RESOURCE.has(item) ? ` (자료 ${resource || '(none)'})` : '';
        const fail = (message) => report(block.id, `${block.id} 6.5 "${item}"${label}: ${message}`);
        if (!resource) { fail('the 자료 cell is empty; name the resource this row judges.'); continue; }
        if (seen.has(normalizeResource(resource))) { fail('the resource appears more than once for this item; keep one row.'); continue; }
        seen.add(normalizeResource(resource));
        const judgment = clean(row['판정']);
        if (judgment === '미정') { fail('판정 미정 is provisional and is not accepted at completion; settle it (확정 or 해당 없음) or ask it as a question.'); continue; }
        const basis = clean(row['근거']);
        const problem = judgmentProblem(block, judgment, basis, `${block.id} 6.5 "${item}"${label}: `);
        if (problem) { report(block.id, problem); continue; }
        if (judgment === '확정' && DISPLAY_NEEDS_EX.has(item) && !(basis.match(/\b(?:SC|INV|EX|AC)-\d+\b/g) ?? []).some((id) => id.startsWith('EX-'))) fail('판정 확정 needs at least one EX of this BIZ in 근거 (the exception that says what happens).');
      }
      if (PER_RESOURCE.has(item)) resources.set(item, new Set(found.map((row) => normalizeResource(row['자료'])).filter(Boolean)));
    }
    const [source, failure] = [resources.get('데이터 출처'), resources.get('불러오기 실패')];
    if (source && failure && ([...source].some((name) => !failure.has(name)) || [...failure].some((name) => !source.has(name)))) report(block.id, `${block.id} 6.5: 데이터 출처 and 불러오기 실패 must cover the same 자료 (resources); one of them lacks a resource the other judges.`);
  }
  return errors;
}

// ---- 6.5 업무 결정 점검 (current shape) -----------------------------------------------------------------------------------
// BIZ | 축 | 대상 | 판정 | 근거. Eight axes every business use case is walked through, whatever kind of work it is. 입력·출처 and 실패 have one row per
// 대상 (each input the BIZ depends on) and cover the same set; the other axes have one row with 대상 `전체`. 판정: 확정 (ids of that BIZ),
// 기본값 (ids whose definition is sourced as the agent's interpretation, listed for the approval), 해당 없음 (business reason),
// 미정 (provisional, refused at completion). The gate cannot know the true 대상 list; the independent reviewer checks it.
export const DECISION_AXES = ['입력·출처', '결과', '대상 판정', '대상 없음', '실패', '중복·재실행', '권한·공개', '보존·되돌림'];
const AXIS_PER_TARGET = new Set(['입력·출처', '실패']);
const AXIS_NEVER_NA = new Set(['입력·출처', '결과']);
const AXIS_NEVER_DEFAULT = new Set(['입력·출처', '권한·공개']);
const isDecisionTable = (table) => ['BIZ', '축', '대상', '판정', '근거'].every((column) => table.header.includes(column));
const isLegacyDisplay = (table) => isDisplayTable(table) && table.header.includes('자료');
const LEGACY_AXIS = { '데이터 출처': '입력·출처', '표시 항목': '결과', '누락·부분 데이터': '대상 판정', '빈 상태': '대상 없음', '불러오기 실패': '실패' };
export const axisOf = (name) => LEGACY_AXIS[clean(name)] ?? clean(name);
// The 6.5 rows of either shape as { biz, axis, target, judgment, basis }.
export const decisionRows = (requirements) => parseTables(requirements).flatMap((table) => isDecisionTable(table)
  ? table.rows.map((row) => ({ biz: clean(row.BIZ), axis: clean(row['축']), target: clean(row['대상']), judgment: clean(row['판정']), basis: clean(row['근거']) }))
  : isLegacyDisplay(table) ? table.rows.map((row) => ({ biz: clean(row.BIZ), axis: axisOf(row['항목']), target: clean(row['자료']), judgment: clean(row['판정']), basis: clean(row['근거']) })) : []);
const has65Shape = (requirements) => {
  const tables = parseTables(requirements);
  return tables.some(isDecisionTable) ? 'new' : tables.some(isLegacyDisplay) ? 'legacy' : tables.some(isDisplayTable) ? 'oldest' : 'none';
};
const NEW_65 = 'requirements.md has no `### 6.5 업무 결정 점검` table (BIZ | 축 | 대상 | 판정 | 근거). Add it: per BIZ one row for each axis of ' + DECISION_AXES.join(', ') + ' (입력·출처 and 실패 once per 대상, i.e. per input the BIZ depends on, covering the same set; the other axes 대상 `전체`). 판정 확정 (ids of that BIZ), 기본값 (an id sourced `요청 해석(에이전트 제안)`), 해당 없음 (business reason). Ask each high-impact open row in one USER_DECISION_REQUIRED batch (grilling GUIDE, Decide whether to ask).';

export function decisionCoverageErrors({ requirements, lines = outsideFences(requirements), required = true }) {
  const tables = parseTables(requirements).filter(isDecisionTable);
  const errors = [];
  const report = (id, message) => errors.push({ code: 'DECISION_COVERAGE_INCOMPLETE', id, message, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
  if (!tables.length) return required ? [{ code: 'DECISION_COVERAGE_INCOMPLETE', message: NEW_65, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX }] : [];
  const rows = tables.flatMap((table) => table.rows);
  const blocks = bizBlocks(lines);
  for (const row of rows) {
    if (!blocks.some((block) => block.id === clean(row.BIZ))) report(clean(row.BIZ), `6.5 has a row for ${clean(row.BIZ) || '(no BIZ)'}, which is not a BIZ of this document.`);
    else if (!DECISION_AXES.includes(clean(row['축']))) report(clean(row.BIZ), `6.5 row of ${clean(row.BIZ)} names the axis "${clean(row['축'])}"; the axes are exactly ${DECISION_AXES.join(', ')}.`);
  }
  for (const block of blocks) {
    const targets = new Map();
    for (const axis of DECISION_AXES) {
      const found = rows.filter((row) => clean(row.BIZ) === block.id && clean(row['축']) === axis);
      const whole = (message) => report(block.id, `${block.id} 6.5 "${axis}": ${message}`);
      if (!found.length) { whole('there is no row. Add it (판정 확정, 기본값 or 해당 없음) or, when the decision is open, ask it as a question.'); continue; }
      if (!AXIS_PER_TARGET.has(axis) && (found.length > 1 || normalizeResource(found[0]['대상']) !== normalizeResource(WHOLE))) { whole(`keep exactly one row for the BIZ with 대상 \`${WHOLE}\`; only 입력·출처 and 실패 have one row per 대상.`); continue; }
      const seen = new Set();
      for (const row of found) {
        const target = clean(row['대상']);
        const label = AXIS_PER_TARGET.has(axis) ? ` (대상 ${target || '(none)'})` : '';
        const fail = (message) => report(block.id, `${block.id} 6.5 "${axis}"${label}: ${message}`);
        if (!target) { fail('the 대상 cell is empty; name the input this row judges.'); continue; }
        if (seen.has(normalizeResource(target))) { fail('the 대상 appears more than once for this axis; keep one row.'); continue; }
        seen.add(normalizeResource(target));
        const judgment = clean(row['판정']);
        const basis = clean(row['근거']);
        const problem = judgmentProblem(block, judgment, basis, `${block.id} 6.5 "${axis}"${label}: `, { allowDefault: true });
        if (problem) { report(block.id, problem); continue; }
        if (judgment === '해당 없음' && AXIS_NEVER_NA.has(axis)) fail(`the axis ${axis} cannot be 해당 없음; settle it with INV/EX/AC ids, asking the user when it is open.`);
        else if (judgment === '기본값' && AXIS_NEVER_DEFAULT.has(axis)) fail(`the axis ${axis} cannot be a 기본값: it decides ${axis === '입력·출처' ? 'where the data comes from' : 'who may see or use it'}; settle it with a user decision.`);
        else if (axis === '실패' && judgment !== '해당 없음' && !(basis.match(/\b(?:SC|INV|EX|AC)-\d+\b/g) ?? []).some((id) => id.startsWith('EX-'))) fail(`판정 ${judgment} needs at least one EX of this BIZ in 근거 (the exception that says what happens when the input cannot be obtained or the action cannot complete).`);
      }
      if (AXIS_PER_TARGET.has(axis)) targets.set(axis, new Set(found.map((row) => normalizeResource(row['대상'])).filter(Boolean)));
    }
    const [source, failure] = [targets.get('입력·출처'), targets.get('실패')];
    if (source && failure && ([...source].some((name) => !failure.has(name)) || [...failure].some((name) => !source.has(name)))) report(block.id, `${block.id} 6.5: 입력·출처 and 실패 must cover the same 대상 (inputs); one of them lacks an input the other judges.`);
  }
  return errors;
}

// The 6.5 check by shape. A new table is checked as is. At requirements-fix completion a document without it is refused; allowLegacy (the
// approval recheck) accepts a complete older table (자료 column) so a changed format never reopens a document by itself; bounded-context
// checks a table that exists and exempts one that is missing or of the oldest shape.
export function coverage65Errors({ requirements, lines, stage, allowLegacy = false }) {
  const shape = has65Shape(requirements);
  const fixing = stage === WORKTREE_STAGE.REQUIREMENTS_FIX;
  if (shape === 'new') return decisionCoverageErrors({ requirements, lines, required: true });
  if (shape === 'legacy' && (allowLegacy || !fixing)) return displayCoverageErrors({ requirements, lines, required: true });
  if (!fixing) return [];
  return [{ code: 'DECISION_COVERAGE_INCOMPLETE', message: shape === 'none' ? NEW_65 : `The \`### 6.5\` table is of an older shape (${shape === 'legacy' ? 'BIZ | 자료 | 항목' : 'BIZ | 항목'}). ${NEW_65}`, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX }];
}

// `### 6.6 빈틈 검토`: one row per gap the independent requirements_gap_reviewer returned (GAP | BIZ | 영향 | 추측해야 하는 것 | 처리 | 근거),
// judged like 6.5: 확정 cites ids defined in that BIZ, 기본값 (only for 영향 low) an agent-sourced id, 해당 없음 a business reason. When it returned none the
// section is one line `없음 — <reason>`. A table without the 영향 column is the older shape (accepted by allowLegacy and at bounded-context).
const GAP_COLUMNS = ['GAP', 'BIZ', '추측해야 하는 것', '처리', '근거'];
const isGapTable = (table) => [...GAP_COLUMNS, '영향'].every((column) => table.header.includes(column));
const isLegacyGapTable = (table) => GAP_COLUMNS.every((column) => table.header.includes(column)) && !table.header.includes('영향');
const GAP_HEADING = /^###[ \t]+6\.6\b/;
export function gapReviewErrors({ requirements, lines = outsideFences(requirements), required = true, allowLegacy = false }) {
  const start = lines.findIndex((line) => GAP_HEADING.test(line));
  const report = (id, message) => ({ code: 'GAP_REVIEW_INCOMPLETE', ...(id ? { id } : {}), message, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
  if (start < 0) return required ? [report(null, 'requirements.md has no `### 6.6 빈틈 검토` section. Run the independent requirements_gap_reviewer, then add one row per gap it returned (GAP | BIZ | 영향 | 추측해야 하는 것 | 처리 | 근거; 영향 is the reviewer\'s high or low; 처리 확정 citing ids defined in that BIZ, 기본값 for a low gap only, or 해당 없음 with a business reason), or the single line `없음 — <the reviewer ran and no guess is left>`. Ask each high gap in the one USER_DECISION_REQUIRED batch (grilling GUIDE, Decide whether to ask).')] : [];
  const end = lines.findIndex((line, index) => index > start && SECTION_END.test(line));
  const body = lines.slice(start + 1, end < 0 ? lines.length : end).join('\n');
  const tables = parseTables(body);
  const rows = tables.filter(isGapTable).flatMap((table) => table.rows);
  const older = tables.filter(isLegacyGapTable).flatMap((table) => table.rows);
  if (!rows.length && older.length && !(required && !allowLegacy)) return legacyGapErrors({ older, lines });
  if (!rows.length && older.length) return [report(null, '6.6 is a table of the older shape without the 영향 column. Add the column (GAP | BIZ | 영향 | 추측해야 하는 것 | 처리 | 근거) with the reviewer\'s high or low.')];
  if (!rows.length) {
    const none = /^[ \t]*(?:[-*][ \t]+)?없음[ \t]*[—–-][ \t]*(\S[^\n]*)$/m.exec(body)?.[1] ?? '';
    return none.split(/\s+/).filter(Boolean).length >= 3 && !VAGUE_REASON.test(none) ? [] : [report(null, '6.6 has neither a gap table (GAP | BIZ | 영향 | 추측해야 하는 것 | 처리 | 근거) nor the line `없음 — <the reviewer ran and no guess is left>` with a reason of at least three words.')];
  }
  const errors = [];
  const blocks = bizBlocks(lines);
  const seen = new Set();
  for (const row of rows) {
    const id = clean(row.GAP), biz = clean(row.BIZ), block = blocks.find((item) => item.id === biz);
    const fail = (message) => errors.push(report(id || biz, `6.6 ${id || '(no GAP id)'} (${biz || 'no BIZ'}): ${message}`));
    if (!/^GAP-\d+$/.test(id) || seen.has(id)) { fail(seen.has(id) ? 'the GAP id is used twice.' : 'the GAP id must look like GAP-01.'); continue; }
    seen.add(id);
    if (!block) { fail('the BIZ is not a BIZ of this document.'); continue; }
    if (!['high', 'low'].includes(clean(row['영향']))) { fail('영향 must be high or low (the reviewer\'s judgement).'); continue; }
    if (!clean(row['추측해야 하는 것'])) { fail('says nothing about what an implementer would have to guess.'); continue; }
    const problem = judgmentProblem(block, clean(row['처리']), clean(row['근거']), `6.6 ${id} (${biz}): `, { allowDefault: true });
    if (problem) errors.push(report(id, problem.replace('판정', '처리')));
    else if (clean(row['처리']) === '기본값' && clean(row['영향']) !== 'low') fail('a high-impact gap cannot be a 기본값; settle it with the user\'s decision.');
  }
  return errors;
}
function legacyGapErrors({ older, lines }) {
  const errors = [];
  const blocks = bizBlocks(lines);
  const seen = new Set();
  for (const row of older) {
    const id = clean(row.GAP), biz = clean(row.BIZ), block = blocks.find((item) => item.id === biz);
    const fail = (message) => errors.push({ code: 'GAP_REVIEW_INCOMPLETE', id: id || biz, message: `6.6 ${id || '(no GAP id)'} (${biz || 'no BIZ'}): ${message}`, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
    if (!/^GAP-\d+$/.test(id) || seen.has(id)) { fail(seen.has(id) ? 'the GAP id is used twice.' : 'the GAP id must look like GAP-01.'); continue; }
    seen.add(id);
    if (!block) { fail('the BIZ is not a BIZ of this document.'); continue; }
    if (!clean(row['추측해야 하는 것'])) { fail('says nothing about what an implementer would have to guess.'); continue; }
    const problem = judgmentProblem(block, clean(row['처리']), clean(row['근거']), `6.6 ${id} (${biz}): `);
    if (problem) errors.push({ code: 'GAP_REVIEW_INCOMPLETE', id, message: problem.replace('판정', '처리'), owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
  }
  return errors;
}

export function checkRequirementsDocument({ requirements, stage, complete = false, analysis = null, allowLegacy = false }) {
  const errors = [];
  const lines = outsideFences(requirements);
  const coverage = complete && [WORKTREE_STAGE.REQUIREMENTS_FIX, WORKTREE_STAGE.BOUNDED_CONTEXT].includes(stage)
    && lines.some((line) => /^## 2\. 업무\s*$/.test(line));
  const identifiers = new Set();
  const report = (code, message) => errors.push({ code, id: biz, message, owner_stage: code === 'DUPLICATE_FIELD' ? stage : WORKTREE_STAGE.REQUIREMENTS_FIX });
  let biz = null;
  let hasBusiness = false;
  let fields = new Map();
  const close = () => {
    for (const [label, positions] of fields) {
      if (positions.length > 1) report('DUPLICATE_FIELD', `${biz} has the field "${label}" ${positions.length} times (lines ${positions.map((index) => index + 1).join(', ')}). Merge the duplicate into the existing field and anchor the patch on its heading (@@ ### ${biz} ...).`);
    }
    if (!coverage) return;
    const positions = [...fields.values()].map(([index]) => index).filter(Number.isInteger).sort((a, b) => a - b);
    for (const [label, prefix] of [['업무 규칙', 'INV'], ['예외 시나리오', 'EX'], ['완료 조건', 'AC']]) {
      if (fields.get(label)?.length > 1) continue;
      const index = fields.get(label)?.[0];
      const end = positions.find((position) => position > index) ?? lines.findIndex((line, position) => position > index && SECTION_END.test(line));
      const content = index === undefined ? '' : [lines[index].replace(FIELD, ''), ...lines.slice(index + 1, end < 0 ? lines.length : end)].join('\n').trim();
      if (prefix !== 'AC' && /^(?:[-*]\s+)?(?:해당 )?없음\s+[—–-]\s+(?!후속(?:\s|$))\S[^\n]*$/.test(content)) continue;
      const items = content.split('\n').filter((line) => line.trim());
      const itemPattern = new RegExp(`^\\s*(?:[-*]\\s+)?(${prefix}-\\d+)\\s+(.+)$`);
      if (!items.length || items.some((line) => !itemPattern.test(line))) {
        report('BIZ_REQUIREMENT_INCOMPLETE', `${biz} needs defined ${prefix} entries in ${label}${prefix === 'AC' ? '' : ' or an explicit reason it does not apply'}. Give each entry its stable ID and the actual rule, outcome or observable condition.`);
      }
      for (const line of items) {
        const match = itemPattern.exec(line);
        if (!match) continue;
        const [, id, description] = match;
        if (prefix === 'EX' && stage === WORKTREE_STAGE.REQUIREMENTS_FIX && notFailureException(description)) report('EXCEPTION_NOT_FAILURE', `${biz} ${id} is not an exception: it is NOT_APPLICABLE or only says the action is not offered. Write a real exception (the condition and the observable result such as a notice, a refusal or an item that is not shown), or write the field as \`없음 — <business reason>\`.`);
        if (identifiers.has(id)) report('BIZ_REQUIREMENT_DUPLICATE_ID', `${biz} reuses ${id}; use one distinct ID per entry across requirements.md.`);
        identifiers.add(id);
        if (/^(?:[-–—_]+|TBD|TODO|미정|없음(?:\s*—\s*후속.*)?)(?:\s*—\s*출처:.*)?$/i.test(description.trim())) report('BIZ_REQUIREMENT_INCOMPLETE', `${biz} ${id} still has a placeholder in ${label}.`);
      }
    }
  };
  lines.forEach((line, index) => {
    const heading = BIZ_HEADING.exec(line);
    if (heading || (biz && SECTION_END.test(line))) {
      if (biz) close();
      biz = heading ? heading[1] : null;
      if (heading) hasBusiness = true;
      fields = new Map();
      return;
    }
    if (!biz) return;
    const field = FIELD.exec(line);
    if (field) fields.set(field[1].trim(), [...(fields.get(field[1].trim()) || []), index]);
  });
  if (biz) close();
  if (coverage && !hasBusiness) report('BIZ_REQUIREMENT_INCOMPLETE', 'requirements.md needs a BIZ section for each confirmed business use case.');
  // Display and lookup coverage (6.5) and gap review (6.6): required at requirements-fix completion, and checked at bounded-context completion once the table exists.
  // A skipped analysis (판정: 생략) and a document without the numbered `## 2. 업무` format are exempt.
  if (coverage && hasBusiness && !(analysis !== null && stakeholderAnalysisSkipped(analysis)) && !stakeholderAnalysisSkipped(requirements)) {
    errors.push(...coverage65Errors({ requirements, lines, stage, allowLegacy }));
    errors.push(...gapReviewErrors({ requirements, lines, required: stage === WORKTREE_STAGE.REQUIREMENTS_FIX, allowLegacy }));
  }
  // An open fact of stakeholder-analysis must be settled and reflected before the requirements are fixed (no table: no check).
  const facts = complete && analysis !== null && !stakeholderAnalysisSkipped(analysis) ? openFactRows(analysis) : null;
  for (const row of facts ?? []) {
    const id = clean(row.ID);
    if (clean(row['처리']) === '미정') {
      errors.push({ code: 'OPEN_FACT_UNRESOLVED', id, message: `stakeholder-analysis.md ${id} (${clean(row['사실'])}) is still 미정. In requirements-fix return action_required / USER_DECISION_REQUIRED asking it (recommended option and reason), then record the answer in the 미확정 사실 table and as a rule of the affected BIZ in requirements.md. Any other stage returns blocked / DEPENDENCY_INCOMPLETE with owner_stage requirements-fix.`, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
    } else if (clean(row['처리']) === '확정' && clean(row['구분']) === ACCESS_KIND && !lines.join('\n').includes(id)) {
      errors.push({ code: 'OPEN_FACT_NOT_REFLECTED', id, message: `${id} (${clean(row['사실'])}) is 확정 but requirements.md never cites ${id}. Reflect it as an INV, EX, AC or 업무 주체 entry of the affected BIZ that cites ${id}.`, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---- recheck before the requirements approval ------------------------------------------------------------------------
// A workflow whose requirements were fixed under older rules waits for approval with a requirements.md that today's
// requirements-fix completion would refuse. This is the one verdict every caller asks (approval reply, approval launch,
// resume instruction, finish instruction): { applies: false } when the question does not arise (domain-model already started
// or approved, bounded-context not current, no numbered document), { applies: true, ok: true } when the canonical document
// passes the current requirements-fix rules, and otherwise ok: false with the gate errors and the one reopen route.
// It reads the canonical document only (never a draft) and runs the same checkRequirementsDocument call as requirements-fix.
const read = (path) => { try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const MAX_LISTED_ERRORS = 20;
export function recheckRequirementsBeforeApproval({ root, state, planSetId: given = null }) {
  const stages = state?.stages || {};
  const fixed = stages[WORKTREE_STAGE.BOUNDED_CONTEXT];
  const design = stages[WORKTREE_STAGE.DOMAIN_MODEL];
  const planSetId = given || stages['workflow-compose']?.plan_set_id || (() => { try { return JSON.parse(readFileSync(join(root, '.io/worktree.json'), 'utf8')).plan_set_id; } catch { return null; } })();
  if (!root || !planSetId || state.current_stage !== WORKTREE_STAGE.BOUNDED_CONTEXT || !isCurrentStage(fixed) || !fixed.execution_id) return { applies: false };
  if ((!design?.stale && (design?.execution_id || design?.attempts?.length || design?.requirements_approval)) || !isCurrentStage(stages[WORKTREE_STAGE.REQUIREMENTS_FIX])) return { applies: false };
  const requirements = read(join(root, specArtifactPath(planSetId, 'requirements.md')));
  if (requirements === null) return { applies: false };
  const analysis = read(join(root, specArtifactPath(planSetId, 'stakeholder-analysis.md')));
  const { errors } = checkRequirementsDocument({ requirements, stage: WORKTREE_STAGE.REQUIREMENTS_FIX, complete: true, analysis, allowLegacy: true });
  if (!errors.length) return { applies: true, ok: true };
  const listed = errors.slice(0, MAX_LISTED_ERRORS).map((error) => `- [${error.code}${error.id ? ` ${error.id}` : ''}] ${error.message}`);
  return {
    applies: true, ok: false, errors, plan_set_id: planSetId, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX, blocked_execution_id: fixed.execution_id,
    // English: the reason handed to the requirements-fix worker, verbatim gate output.
    reason: `The fixed requirements.md no longer passes the current requirements-fix completion rules. Runner errors, verbatim:\n${listed.join('\n')}${errors.length > listed.length ? `\n- (+${errors.length - listed.length} more)` : ''}`,
    // Korean: the one sentence the user hears.
    notice_ko: '요구사항 문서가 현재 검증 기준(업무 결정 점검, 빈틈 검토, 예외 시나리오)을 충족하지 못해, 승인을 묻기 전에 요구사항 작성 단계를 먼저 다시 엽니다.',
    reopen_args: ['--stage-id', WORKTREE_STAGE.REQUIREMENTS_FIX, '--reopen-for', fixed.execution_id],
  };
}
// The same exemptions as 6.5: a skipped analysis and a document without the numbered business format.
const gapReviewExempt = (requirements, analysis) => !outsideFences(requirements).some((line) => /^## 2\. 업무\s*$/.test(line)) || !outsideFences(requirements).some((line) => BIZ_HEADING.test(line))
  || (analysis !== null && stakeholderAnalysisSkipped(analysis)) || stakeholderAnalysisSkipped(requirements);

// ---- runner evidence of the gap review -------------------------------------------------------------------------------
// The subagent hook appends every agent a stage worker starts to runtime/executions/<id>/subagents.jsonl, with the agent's final
// message on SubagentStop. That is the only runner-visible trace of the independent reviewer: it shows that the reviewer ran and
// what it returned, so each returned gap must have a 6.6 row. It does not show what the prompt held (verbatim request and draft
// only) and it is absent when no hook recorded the execution (see the fail-closed rule below). Only the last review counts: a
// reopen or revalidation of requirements-fix long after an earlier review is satisfied by that older review even when BIZ content
// changed in between (known limit; the GUIDE says to rerun the review only when BIZ content was added).
const GAP_REVIEWER = 'requirements_gap_reviewer';
const readJsonLines = async (path) => { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
async function stageExecutionIds(root, executionId) {
  const started = new Map([[executionId, null]]);
  let provider = null;
  for (const name of ['workflow.json', 'state.json']) {
    try {
      const parsed = JSON.parse(await readFile(sessionOutputPath(root, `runtime/orchestrator/${name}`, { create: false }), 'utf8'));
      provider = (parsed.state || parsed).orchestrator_provider ?? null;
      const entry = (parsed.state || parsed).stages?.[WORKTREE_STAGE.REQUIREMENTS_FIX];
      for (const item of [...(entry?.attempts || []), entry]) if (typeof item?.execution_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(item.execution_id)) started.set(item.execution_id, item.started_at ?? started.get(item.execution_id) ?? null);
      break;
    } catch { /* try the next file; the current execution alone still counts */ }
  }
  // The latest reopen or user revision of requirements-fix starts a new review chain; a resume with answers belongs to the chain it resumes.
  let since = null, revision = false;
  for (const [id, at] of started) {
    try {
      const { input } = await findExecutionInput(root, id);
      if ((input.context?.reopen || input.context?.user_revision || input.context?.revalidation_mark) && Number.isFinite(Date.parse(at ?? '')) && (since === null || Date.parse(at) > since)) { since = Date.parse(at); revision = Boolean(input.context?.user_revision); }
    } catch { /* no readable input: it cannot move the chain start */ }
  }
  return { ids: [...started.keys()], provider, since, revision };
}
const NO_ID = /\b(?:SC|INV|EX|AC)-\d+\b/g;
// An id counts as the user's own decision of THIS review chain only when its definition cites a question id `<execution-id>:<n>` of a
// requirements-fix execution of the chain whose recorded answer exists (decision-answers.json of the asking execution or the
// answers.json of the resumed one) and was written no earlier than the review, or `사용자 수정 지시` while the latest reopen is a user revision.
// An earlier stage's citation (answers.json of event-storming, a made-up id) never settles an unanswered row.
const QUESTION_ID = /[A-Za-z0-9][A-Za-z0-9_-]*:\d+/g;
async function chainAnswers(root, ids) {
  const found = new Map();
  for (const id of ids) {
    for (const name of ['decision-answers.json', 'answers.json']) {
      let path, text, info;
      try { path = sessionOutputPath(root, `runtime/executions/${id}/${name}`, { create: false }); info = await stat(path); text = await readFile(path, 'utf8'); } catch { continue; }
      let list; try { list = JSON.parse(text); } catch { continue; }
      for (const item of Array.isArray(list) ? list : []) {
        if (typeof item?.question_id === 'string' && typeof item.answer === 'string' && item.answer.trim() && ids.includes(item.question_id.slice(0, item.question_id.lastIndexOf(':')))) found.set(item.question_id, Math.max(found.get(item.question_id) ?? 0, info.mtimeMs));
      }
    }
  }
  return found;
}
const userSourced = (block, id, { answers, reviewedAt, revision }) => {
  const line = block?.definitions.get(id) ?? '';
  if (revision && /사용자 수정 지시/.test(line)) return true;
  return (line.match(QUESTION_ID) ?? []).some((question) => answers.has(question) && !(answers.get(question) < reviewedAt));
};
const parseReview = (text) => { try { return JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; } };
// The two modes of the reviewer are told apart by their output shape: verify returns unsupported + conflicts and nothing else.
const isVerifyOutput = (review) => Array.isArray(review?.unsupported) && Array.isArray(review?.conflicts) && !('gaps' in review) && !('rows' in review);
const plain = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
// Old reviewer records carry no impact: they count as high.
const impactOf = (entry) => entry?.impact === 'low' ? 'low' : 'high';
const timeOf = (stop) => Number.isFinite(Date.parse(stop?.recorded_at ?? '')) ? Date.parse(stop.recorded_at) : 0;

export async function gapReviewEvidenceErrors({ root, executionId, requirements }) {
  const error = (message) => [{ code: 'GAP_REVIEW_INCOMPLETE', message, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX }];
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId || '')) return [];
  let records = null;
  const { ids, provider, since, revision } = await stageExecutionIds(root, executionId);
  for (const id of ids) {
    const found = await readJsonLines(sessionOutputPath(root, `runtime/executions/${id}/subagents.jsonl`, { create: false }));
    if (found) records = [...(records ?? []), ...found];
  }
  // No hook log at all. On Claude Code the worker itself is always recorded when the hook runs, so a missing log means the reviewer
  // cannot have been seen: refuse. Codex stays lenient only when no log exists (its hook may be untrusted or absent, which the
  // runner reports elsewhere), and so does a run whose provider is unknown.
  if (!records) return provider === 'claude-code' ? error(`No subagent hook log exists for this requirements-fix (provider ${provider}), so the independent ${GAP_REVIEWER} run cannot be confirmed. Run the gap review (GUIDE step 7) with Agent subagent_type ${GAP_REVIEWER}; the hook records it.`) : [];
  const allStops = records.filter((item) => item.event === 'SubagentStop' && item.agent_type === GAP_REVIEWER && typeof item.result === 'string');
  // A review older than the latest reopen or user revision of requirements-fix does not count (when the state gives its start).
  const stops = (since === null ? allStops : allStops.filter((item) => !(Date.parse(item.recorded_at ?? '') < since))).map((stop) => ({ stop, review: parseReview(stop.result) }));
  const mains = stops.filter(({ review }) => !isVerifyOutput(review));
  if (!mains.length) return error(allStops.length ? `The only recorded ${GAP_REVIEWER} run is older than the latest reopen or revision of requirements-fix (or is a verify run). Run the independent gap review again (GUIDE step 7).` : `The subagent hook recorded no finished ${GAP_REVIEWER} for this stage. Run the independent gap review (GUIDE step 7) once, with the user request and the BIZ and common sections as its only input, before completing.`);
  const { stop: lastMain, review } = mains.at(-1);
  const answers = await chainAnswers(root, ids);
  const reviewedAt = timeOf(lastMain);
  const gaps = review?.gaps;
  if (!Array.isArray(gaps)) return error(`The last ${GAP_REVIEWER} answer is not the JSON object {"rows":[...],"gaps":[...],"missing_inputs":[...]} its GUIDE defines, so its findings cannot be matched to the document. Run the review again.`);
  const missingInputs = review.missing_inputs ?? review.missing_resources;
  if (!Array.isArray(review.rows) || !Array.isArray(missingInputs)) return error(`The last ${GAP_REVIEWER} answer has no "rows" and "missing_inputs" (output of an older GUIDE), so the 6.5 rows were never judged. Run the review again.`);
  const lines = outsideFences(requirements);
  const blocks = bizBlocks(lines);
  const start = lines.findIndex((line) => GAP_HEADING.test(line));
  const end = lines.findIndex((line, index) => index > start && SECTION_END.test(line));
  const gapRows = start < 0 ? [] : parseTables(lines.slice(start + 1, end < 0 ? lines.length : end).join('\n')).filter((table) => isGapTable(table) || isLegacyGapTable(table)).flatMap((table) => table.rows);
  const shown = decisionRows(requirements);
  const errors = [];
  for (const biz of new Set(gaps.map((gap) => clean(gap?.biz)))) {
    const returned = gaps.filter((gap) => clean(gap?.biz) === biz);
    const written = gapRows.filter((row) => clean(row.BIZ) === biz);
    if (written.length < returned.length) errors.push(...error(`${GAP_REVIEWER} returned ${returned.length} gap(s) for ${biz || '(no BIZ)'} but 6.6 has ${written.length} row(s) for it. Give every returned gap a GAP row: 확정 citing the INV, EX or AC that settles it (ask the user when it is open), 기본값 for a low gap, or 해당 없음 with a business reason.`));
    // The author cannot downgrade a reviewer's high.
    const high = returned.filter((gap) => impactOf(gap) === 'high').length;
    if (written.filter((row) => clean(row['영향'] ?? 'high') !== 'low').length < high) errors.push(...error(`${GAP_REVIEWER} judged ${high} gap(s) of ${biz || '(no BIZ)'} high impact but 6.6 lists fewer rows with 영향 high. The reviewer's impact stands; ask the user (a recorded answer of this chain settles it).`));
  }
  const reviewed = review.rows.map((row) => ({ biz: clean(row?.biz), axis: axisOf(row?.axis ?? row?.item), target: normalizeResource(row?.target ?? row?.resource), answered: row?.answered, impact: impactOf(row) }));
  // A row the reviewer judged unanswered must now be settled by this chain's own answer, by 해당 없음, or (low only) by 기본값; a row it never saw is treated as high.
  const settled = (row, impact) => {
    if (row.judgment === '해당 없음') return true;
    if (row.judgment === '기본값') return impact === 'low';
    const block = blocks.find((item) => item.id === row.biz);
    return row.judgment === '확정' && (row.basis.match(NO_ID) ?? []).some((id) => userSourced(block, id, { answers, reviewedAt, revision }));
  };
  for (const row of shown) {
    const target = normalizeResource(row.target);
    const sameAxis = reviewed.filter((entry) => entry.biz === row.biz && entry.axis === row.axis);
    if (!sameAxis.length) { if (!settled(row, 'high')) errors.push(...error(`6.5 ${row.biz} "${row.axis}" (대상 ${row.target}) was not among the rows the ${GAP_REVIEWER} judged and is not settled by this chain's recorded answer (an id whose definition cites it) or 해당 없음. Run the review again after the provisional 6.5 is complete.`)); continue; }
    const unanswered = sameAxis.filter((entry) => entry.answered === false && (entry.target === target || !sameAxis.some((other) => other.target === target)));
    const impact = unanswered.some((entry) => entry.impact === 'high') ? 'high' : 'low';
    if (unanswered.length && !settled(row, impact)) errors.push(...error(`6.5 ${row.biz} "${row.axis}" (대상 ${row.target}): the ${GAP_REVIEWER} judged (impact ${impact}) that the cited sentence does not itself answer the axis and the row is unchanged${impact === 'high' ? '' : ' (a low one may become a 기본값 sourced 요청 해석(에이전트 제안))'}. ${impact === 'high' ? 'Ask the user (one question batch), then settle the row with an id whose definition cites the recorded question id (<execution-id>:<n> of this requirements-fix chain) of that answer or a 사용자 수정 지시 of this reopen, or 해당 없음 with a business reason.' : ''}`));
  }
  for (const missing of missingInputs) {
    const biz = clean(missing?.biz), name = normalizeResource(missing?.target ?? missing?.resource);
    if (!name) continue;
    const covers = (axis) => shown.filter((row) => row.biz === biz && row.axis === axis).map((row) => normalizeResource(row.target));
    const has = (axis) => covers(axis).some((own) => own === name || own.includes(name) || name.includes(own));
    // Wording that is too free to match still counts when the BIZ now has more inputs than the reviewed rows plus the missing ones named.
    const counted = (axis) => new Set(covers(axis)).size >= new Set(reviewed.filter((entry) => entry.biz === biz && entry.axis === axis).map((entry) => entry.target)).size + missingInputs.filter((entry) => clean(entry?.biz) === biz).length;
    for (const axis of AXIS_PER_TARGET) if (!has(axis) && !counted(axis)) errors.push(...error(`${GAP_REVIEWER} named the input "${clean(missing?.target ?? missing?.resource)}" of ${biz} as missing, but 6.5 has no "${axis}" row for it. Add the row (ask the user when it is open) for the input.`));
  }
  // After the user's answers were applied the same reviewer must have verified them once (mode verify): text attributed to an answer the
  // answer does not say, and statements that cannot both hold. The run must be recorded after the latest answer, and each finding must be fixed.
  if (answers.size) {
    const latestAnswer = Math.max(...answers.values());
    const verify = stops.filter(({ stop, review: other }) => isVerifyOutput(other) && !(timeOf(stop) < latestAnswer)).at(-1);
    if (!verify) return [...errors, ...error(`The user answered questions of this requirements-fix, so the ${GAP_REVIEWER} must verify the result once in mode verify (the request, the BIZ and common text with sources kept, each question with the chosen answer) after the latest answer, and none is recorded. Run it (GUIDE step 9).`)];
    const text = plain(requirements);
    const present = (quote) => Boolean(plain(quote)) && text.includes(plain(quote));
    for (const item of verify.review.unsupported) if (!plain(item?.quote) || present(item.quote)) errors.push(...error(`The verify run found text attributed to a user answer that the answer does not say (${clean(item?.id)}: "${plain(item?.quote)}") and it is still in the document. Make that part a separate ${AGENT_SOURCE} item (기본값) or remove it, then verify again only if the gate refused.`));
    for (const item of verify.review.conflicts) {
      const quotes = Array.isArray(item?.quotes) ? item.quotes : [];
      if (!quotes.length || quotes.every(present)) errors.push(...error(`The verify run found statements that cannot both hold (${(Array.isArray(item?.ids) ? item.ids : []).join(', ')}) and each is still in the document. Rewrite the agent-proposed side; when both sides are the user's, ask the user in a new batch and verify again after that answer.`));
    }
  }
  return errors;
}

// ---- the defaults the user was never asked about -----------------------------------------------------------------------------
// Every 기본값 of 6.5 and 6.6, as the lines the approval request shows verbatim under "묻지 않고 정한 것", plus the subdomain boundaries and
// classes recorded as the agent's interpretation. Read from the canonical document; [] when there is none.
export function requirementsDefaults({ root, planSetId }) {
  const requirements = planSetId ? read(join(root, specArtifactPath(planSetId, 'requirements.md'))) : null;
  if (requirements === null) return [];
  const lines = outsideFences(requirements);
  const blocks = bizBlocks(lines);
  const text = (block, basis) => (basis.match(NO_ID) ?? []).map((id) => (block?.definitions.get(id) ?? '').replace(/^[ \t]*(?:[-*][ \t]+)?/, '').replace(/\s*[—–-]+\s*출처:.*$/, '').trim()).filter(Boolean).join(' / ');
  // A decision whose target rule was later rewritten from a real user answer is stale text, not a default.
  const userAnswered = (id) => blocks.some((block) => /answers\.json/.test(block.definitions.get(id) ?? ''));
  const out = [];
  for (const row of decisionRows(requirements).filter((item) => item.judgment === '기본값')) out.push(`${row.biz} · ${row.axis}${row.target && row.target !== WHOLE ? ` (${row.target})` : ''}: ${text(blocks.find((b) => b.id === row.biz), row.basis)}`);
  const start = lines.findIndex((line) => GAP_HEADING.test(line));
  const end = lines.findIndex((line, index) => index > start && SECTION_END.test(line));
  for (const row of start < 0 ? [] : parseTables(lines.slice(start + 1, end < 0 ? lines.length : end).join('\n')).flatMap((table) => table.rows)) {
    if (clean(row['처리']) === '기본값') out.push(`${clean(row.BIZ)} · ${clean(row['추측해야 하는 것'])}: ${text(blocks.find((b) => b.id === clean(row.BIZ)), clean(row['근거']))}`);
  }
  // Hotspots of low impact decided without asking (## 5 rows sourced as the agent's interpretation).
  for (const table of parseTables(requirements).filter((item) => item.header.includes('HS') && item.header.includes('결정'))) {
    for (const row of table.rows) if (clean(row['출처']).includes(AGENT_SOURCE) && !(clean(row['결정']).match(NO_ID) ?? []).some(userAnswered)) out.push(`${clean(row['관련 BIZ'])} · ${clean(row['질문'])}: ${clean(row['결정'])}`);
  }
  // Subdomain table rows whose boundary or class was not asked (source 요청 해석(에이전트 제안)).
  for (const table of parseTables(requirements).filter((item) => item.header.includes('SD') && item.header.includes('상태'))) {
    for (const row of table.rows) {
      const cells = Object.entries(row).filter(([name]) => /근거|출처/.test(name)).map(([, value]) => clean(value)).join(' ');
      if (cells.includes(AGENT_SOURCE)) out.push(`${clean(row.SD)} ${clean(row['이름'] ?? '')}: 분류 ${clean(row['분류'] ?? '')} (경계·분류를 묻지 않고 정함)`.replace(/\s+/g, ' '));
    }
  }
  return out;
}

// The runner's verdict when a requirements stage returns its questions or completes; null when the check does not apply.
export async function evaluateRequirementsDocumentGate({ root, input, envelope, draftExecutionId }) {
  const stage = input?.skill;
  const planSetId = input?.context?.plan_set_id;
  if (!REQUIREMENTS_STAGES.includes(stage) || !planSetId || !['completed', 'action_required'].includes(envelope?.status)) return null;
  const requirements = await planSetDocument(root, planSetId, 'requirements.md', draftExecutionId);
  if (requirements.text === null) return null;
  const complete = envelope.status === 'completed' && envelope.code === 'OK';
  const analysis = complete && [WORKTREE_STAGE.REQUIREMENTS_FIX, WORKTREE_STAGE.BOUNDED_CONTEXT].includes(stage) ? await planSetDocument(root, planSetId, 'stakeholder-analysis.md', draftExecutionId) : { text: null };
  const verdict = checkRequirementsDocument({ requirements: requirements.text, stage, complete, analysis: analysis.text });
  // Evidence of the independent gap review, for the documents whose 6.6 the gate requires.
  const reviewed = complete && stage === WORKTREE_STAGE.REQUIREMENTS_FIX && verdict.ok && !gapReviewExempt(requirements.text, analysis.text);
  const evidence = reviewed ? await gapReviewEvidenceErrors({ root, executionId: input.execution_id, requirements: requirements.text }) : [];
  return { stage, ok: verdict.ok && !evidence.length, errors: [...verdict.errors, ...evidence] };
}

export const requirementsDocumentFailureInstruction = (verdict) => `The runner checked requirements.md for ${verdict.stage}. Nothing was committed or recorded, and the stage is still running. Return the errors to the same subagent. Merge duplicate fields into the first occurrence in place and anchor each patch on the named BIZ heading. Correct owned fields, ask the user for any open business decision in scope, or return blocked / DEPENDENCY_INCOMPLETE for an earlier owner named in the errors. Resubmit using the same execution and run finish again.`;

export class RequirementsDocumentError extends Error {
  constructor(verdict) {
    super(`Requirements document check failed for ${verdict.stage}: ${verdict.errors.map((item) => item.message).join('; ')}`);
    this.name = 'RequirementsDocumentError';
    this.verdict = verdict;
  }
}

export async function assertRequirementsDocumentGate(options) {
  const verdict = await evaluateRequirementsDocumentGate(options);
  if (verdict && !verdict.ok) throw new RequirementsDocumentError(verdict);
  return verdict;
}
