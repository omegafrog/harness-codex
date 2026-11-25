// Check BIZ field uniqueness before result acceptance and require defined INV, EX and AC entries at coverage completion.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { sessionOutputPath } from './session-output.mjs';
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

// `### 6.5 조회·표시 점검`: per BIZ, five rows (BIZ | 항목 | 판정 | 근거). 확정 cites ids defined in that BIZ; 해당 없음 gives a business reason.
export const DISPLAY_ITEMS = ['데이터 출처', '표시 항목', '누락·부분 데이터', '빈 상태', '불러오기 실패'];
const DISPLAY_NEEDS_EX = new Set(['누락·부분 데이터', '불러오기 실패']);
const DISPLAY_NEVER_SKIPPED = new Set(['데이터 출처', '표시 항목', '불러오기 실패']);
const SHOWS_DATA = /보이|보여|표시|조회|목록|핀|검색/;
const VAGUE_REASON = /요청(?:에|문에|서)?\s*(?:도\s*)?(?:없|언급|명시|포함되)|요청되지|미정|후속|추후|나중|향후|TBD|TODO|논의 필요|정해지지 않|결정되지 않/i;
const DEFINED_ID = /^[ \t]*(?:[-*][ \t]+|\d+[.)][ \t]+)?(?:(?:업무 규칙|예외 시나리오|완료 조건|정상 시나리오)[ \t]*[:：][ \t]*)?((?:SC|INV|EX|AC)-\d+)\b/;
const isDisplayTable = (table) => ['BIZ', '항목', '판정', '근거'].every((column) => table.header.includes(column));

function bizBlocks(lines) {
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const heading = BIZ_HEADING.exec(line);
    if (heading || (current && SECTION_END.test(line))) {
      current = heading ? { id: heading[1], fields: new Map(), defined: new Set(), field: null } : null;
      if (current) blocks.push(current);
      continue;
    }
    if (!current) continue;
    const defined = DEFINED_ID.exec(line);
    if (defined) current.defined.add(defined[1]);
    const field = FIELD.exec(line);
    if (field) current.field = field[1].trim();
    if (current.field) current.fields.set(current.field, `${current.fields.get(current.field) ?? ''}\n${field ? line.replace(FIELD, '') : line}`);
  }
  return blocks;
}

// The judgement shared by the 6.5 and 6.6 rows: 확정 cites ids defined in that BIZ; 해당 없음 gives a business reason. Returns the problem or null.
function judgmentProblem(block, judgment, basis, prefix) {
  if (judgment === '확정') {
    const cited = basis.match(/\b(?:SC|INV|EX|AC)-\d+\b/g) ?? [];
    const missing = cited.filter((id) => !block.defined.has(id));
    if (!cited.length) return `${prefix}판정 확정 needs the ids (INV, EX, AC, SC) of this BIZ that settle it in 근거.`;
    if (missing.length) return `${prefix}근거 cites ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not defined in ${block.id}.`;
    return null;
  }
  if (judgment === '해당 없음') {
    const reason = basis.replace(/^해당 없음\s*[—–-]?\s*/, '');
    if (reason.split(/\s+/).filter(Boolean).length < 4 || VAGUE_REASON.test(reason)) return `${prefix}판정 해당 없음 needs a business reason of more than a few words. A missing or open decision ("요청에 없음", 미정, 후속) is asked as a question, not skipped.`;
    return null;
  }
  return `${prefix}판정 "${judgment}" must be 확정 or 해당 없음.`;
}

export function displayCoverageErrors({ requirements, lines = outsideFences(requirements), required = true }) {
  const tables = parseTables(requirements).filter(isDisplayTable);
  if (!tables.length) return required ? [{ code: 'DISPLAY_COVERAGE_INCOMPLETE', message: 'requirements.md has no `### 6.5 조회·표시 점검` table (BIZ | 항목 | 판정 | 근거). Add one row per BIZ for each of: ' + DISPLAY_ITEMS.join(', ') + '. Ask every unresolved row as a concrete question in one USER_DECISION_REQUIRED batch, with a smallest option (fixed data, a notice text) among the choices.', owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX }] : [];
  const rows = tables.flatMap((table) => table.rows);
  const errors = [];
  const report = (id, message) => errors.push({ code: 'DISPLAY_COVERAGE_INCOMPLETE', id, message, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
  const blocks = bizBlocks(lines);
  for (const row of rows) {
    if (!blocks.some((block) => block.id === clean(row.BIZ))) report(clean(row.BIZ), `6.5 has a row for ${clean(row.BIZ) || '(no BIZ)'}, which is not a BIZ of this document.`);
    else if (!DISPLAY_ITEMS.includes(clean(row['항목']))) report(clean(row.BIZ), `6.5 row of ${clean(row.BIZ)} names the item "${clean(row['항목'])}"; the items are exactly ${DISPLAY_ITEMS.join(', ')}.`);
  }
  for (const block of blocks) {
    const shows = SHOWS_DATA.test(['정상 시나리오', '업무 규칙', '완료 조건'].map((label) => block.fields.get(label) ?? '').join('\n'));
    for (const item of DISPLAY_ITEMS) {
      const found = rows.filter((row) => clean(row.BIZ) === block.id && clean(row['항목']) === item);
      const fail = (message) => report(block.id, `${block.id} 6.5 "${item}": ${message}`);
      if (found.length !== 1) { fail(found.length ? 'the item appears more than once; keep one row.' : 'there is no row. Add it (판정 확정 or 해당 없음) or, when the decision is open, ask it as a question.'); continue; }
      const problem = judgmentProblem(block, clean(found[0]['판정']), clean(found[0]['근거']), `${block.id} 6.5 "${item}": `);
      if (problem) { report(block.id, problem); continue; }
      const judgment = clean(found[0]['판정']);
      const basis = clean(found[0]['근거']);
      if (judgment === '확정' && DISPLAY_NEEDS_EX.has(item) && !(basis.match(/\b(?:SC|INV|EX|AC)-\d+\b/g) ?? []).some((id) => id.startsWith('EX-'))) fail('판정 확정 needs at least one EX of this BIZ in 근거 (the exception that says what happens).');
      else if (judgment === '해당 없음' && shows && DISPLAY_NEVER_SKIPPED.has(item)) fail('this BIZ shows or looks up data, so the item cannot be 해당 없음; settle it with INV/EX/AC ids, asking the user when it is open.');
    }
  }
  return errors;
}

// `### 6.6 빈틈 검토`: one row per gap the independent requirements_gap_reviewer returned (GAP | BIZ | 추측해야 하는 것 | 처리 | 근거),
// judged like 6.5 (확정 cites ids defined in that BIZ; 해당 없음 gives a business reason). When it returned none the section is one line `없음 — <reason>`.
const isGapTable = (table) => ['GAP', 'BIZ', '추측해야 하는 것', '처리', '근거'].every((column) => table.header.includes(column));
const GAP_HEADING = /^###[ \t]+6\.6\b/;
export function gapReviewErrors({ requirements, lines = outsideFences(requirements), required = true }) {
  const start = lines.findIndex((line) => GAP_HEADING.test(line));
  const report = (id, message) => ({ code: 'GAP_REVIEW_INCOMPLETE', ...(id ? { id } : {}), message, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
  if (start < 0) return required ? [report(null, 'requirements.md has no `### 6.6 빈틈 검토` section. Run the independent requirements_gap_reviewer, then add one row per gap it returned (GAP | BIZ | 추측해야 하는 것 | 처리 | 근거; 처리 확정 citing ids defined in that BIZ, or 해당 없음 with a business reason), or the single line `없음 — <the reviewer ran and no guess is left>`. Ask each open gap as a concrete question in the one USER_DECISION_REQUIRED batch, with a smallest-scope option among the choices.')] : [];
  const end = lines.findIndex((line, index) => index > start && SECTION_END.test(line));
  const body = lines.slice(start + 1, end < 0 ? lines.length : end).join('\n');
  const rows = parseTables(body).filter(isGapTable).flatMap((table) => table.rows);
  if (!rows.length) {
    const none = /^[ \t]*(?:[-*][ \t]+)?없음[ \t]*[—–-][ \t]*(\S[^\n]*)$/m.exec(body)?.[1] ?? '';
    return none.split(/\s+/).filter(Boolean).length >= 3 && !VAGUE_REASON.test(none) ? [] : [report(null, '6.6 has neither a gap table (GAP | BIZ | 추측해야 하는 것 | 처리 | 근거) nor the line `없음 — <the reviewer ran and no guess is left>` with a reason of at least three words.')];
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
    if (!clean(row['추측해야 하는 것'])) { fail('says nothing about what an implementer would have to guess.'); continue; }
    const problem = judgmentProblem(block, clean(row['처리']), clean(row['근거']), `6.6 ${id} (${biz}): `);
    if (problem) errors.push(report(id, problem.replace('판정', '처리')));
  }
  return errors;
}

export function checkRequirementsDocument({ requirements, stage, complete = false, analysis = null }) {
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
    errors.push(...displayCoverageErrors({ requirements, lines, required: stage === WORKTREE_STAGE.REQUIREMENTS_FIX }));
    errors.push(...gapReviewErrors({ requirements, lines, required: stage === WORKTREE_STAGE.REQUIREMENTS_FIX }));
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
  if (design?.execution_id || design?.attempts?.length || design?.requirements_approval || !isCurrentStage(stages[WORKTREE_STAGE.REQUIREMENTS_FIX])) return { applies: false };
  const requirements = read(join(root, specArtifactPath(planSetId, 'requirements.md')));
  if (requirements === null) return { applies: false };
  const analysis = read(join(root, specArtifactPath(planSetId, 'stakeholder-analysis.md')));
  const { errors } = checkRequirementsDocument({ requirements, stage: WORKTREE_STAGE.REQUIREMENTS_FIX, complete: true, analysis });
  if (!errors.length) return { applies: true, ok: true };
  const listed = errors.slice(0, MAX_LISTED_ERRORS).map((error) => `- [${error.code}${error.id ? ` ${error.id}` : ''}] ${error.message}`);
  return {
    applies: true, ok: false, errors, plan_set_id: planSetId, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX, blocked_execution_id: fixed.execution_id,
    // English: the reason handed to the requirements-fix worker, verbatim gate output.
    reason: `The fixed requirements.md no longer passes the current requirements-fix completion rules. Runner errors, verbatim:\n${listed.join('\n')}${errors.length > listed.length ? `\n- (+${errors.length - listed.length} more)` : ''}`,
    // Korean: the one sentence the user hears.
    notice_ko: '요구사항 문서가 현재 검증 기준(조회·표시 점검, 빈틈 검토, 예외 시나리오)을 충족하지 못해, 승인을 묻기 전에 요구사항 작성 단계를 먼저 다시 엽니다.',
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
  const ids = new Set([executionId]);
  let provider = null;
  for (const name of ['workflow.json', 'state.json']) {
    try {
      const parsed = JSON.parse(await readFile(sessionOutputPath(root, `runtime/orchestrator/${name}`, { create: false }), 'utf8'));
      provider = (parsed.state || parsed).orchestrator_provider ?? null;
      const entry = (parsed.state || parsed).stages?.[WORKTREE_STAGE.REQUIREMENTS_FIX];
      for (const id of [entry?.execution_id, ...(entry?.attempts || []).map((attempt) => attempt.execution_id)]) if (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) ids.add(id);
      break;
    } catch { /* try the next file; the current execution alone still counts */ }
  }
  return { ids: [...ids], provider };
}
export async function gapReviewEvidenceErrors({ root, executionId, requirements }) {
  const error = (message) => [{ code: 'GAP_REVIEW_INCOMPLETE', message, owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX }];
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(executionId || '')) return [];
  let records = null;
  const { ids, provider } = await stageExecutionIds(root, executionId);
  for (const id of ids) {
    const found = await readJsonLines(sessionOutputPath(root, `runtime/executions/${id}/subagents.jsonl`, { create: false }));
    if (found) records = [...(records ?? []), ...found];
  }
  // No hook log at all. On Claude Code the worker itself is always recorded when the hook runs, so a missing log means the reviewer
  // cannot have been seen: refuse. Codex stays lenient only when no log exists (its hook may be untrusted or absent, which the
  // runner reports elsewhere), and so does a run whose provider is unknown.
  if (!records) return provider === 'claude-code' ? error(`No subagent hook log exists for this requirements-fix (provider ${provider}), so the independent ${GAP_REVIEWER} run cannot be confirmed. Run the gap review (GUIDE step 7) with Agent subagent_type ${GAP_REVIEWER}; the hook records it.`) : [];
  const stops = records.filter((item) => item.event === 'SubagentStop' && item.agent_type === GAP_REVIEWER && typeof item.result === 'string');
  if (!stops.length) return error(`The subagent hook recorded no finished ${GAP_REVIEWER} for this stage. Run the independent gap review (GUIDE step 7) once, with the user request and the BIZ and common sections as its only input, before completing.`);
  let gaps;
  try { gaps = JSON.parse(stops.at(-1).result.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')).gaps; } catch { gaps = null; }
  if (!Array.isArray(gaps)) return error(`The last ${GAP_REVIEWER} answer is not the JSON object {"gaps":[...]} its GUIDE defines, so its gaps cannot be matched to 6.6 rows. Run the review again.`);
  const lines = outsideFences(requirements);
  const start = lines.findIndex((line) => GAP_HEADING.test(line));
  const end = lines.findIndex((line, index) => index > start && SECTION_END.test(line));
  const rows = start < 0 ? [] : parseTables(lines.slice(start + 1, end < 0 ? lines.length : end).join('\n')).filter(isGapTable).flatMap((table) => table.rows);
  const errors = [];
  for (const biz of new Set(gaps.map((gap) => clean(gap?.biz)))) {
    const returned = gaps.filter((gap) => clean(gap?.biz) === biz).length;
    const written = rows.filter((row) => clean(row.BIZ) === biz).length;
    if (written < returned) errors.push(...error(`${GAP_REVIEWER} returned ${returned} gap(s) for ${biz || '(no BIZ)'} but 6.6 has ${written} row(s) for it. Give every returned gap a GAP row: 확정 citing the INV, EX or AC that settles it (ask the user when it is open) or 해당 없음 with a business reason.`));
  }
  return errors;
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
