// Check BIZ field uniqueness before result acceptance and require defined INV, EX and AC entries at coverage completion.
import { clean, outsideFences, parseTables, planSetDocument } from './domain-model-gate.mjs';
import { REQUIREMENTS_STAGES, WORKTREE_STAGE } from './worktree-stages.mjs';

const BIZ_HEADING = /^###[ \t]+(BIZ-\d+)\b/;
const FIELD = /^- ([^:：\n]+?)\s*[:：]/;
const SECTION_END = /^#{1,3}[ \t]/;

const headingLine = (line) => /^(#{1,3})[ \t]+/.exec(line);

function extractBizSections(lines) {
  const sections = new Map();
  for (let start = 0; start < lines.length; start += 1) {
    const heading = BIZ_HEADING.exec(lines[start]);
    if (!heading) continue;
    let end = lines.length;
    for (let cursor = start + 1; cursor < lines.length; cursor += 1) {
      const next = headingLine(lines[cursor]);
      if (next && next[1].length <= 3) { end = cursor; break; }
    }
    if (sections.has(heading[1])) sections.set(heading[1], null);
    else sections.set(heading[1], lines.slice(start, end));
  }
  return sections;
}

function fieldContent(section, label) {
  const start = section.findIndex((line) => new RegExp('^-\\s*' + label + '[:：]').test(line));
  if (start < 0) return '';
  let end = section.length;
  for (let index = start + 1; index < section.length; index += 1) {
    if (FIELD.test(section[index]) || SECTION_END.test(section[index])) { end = index; break; }
  }
  return [section[start].replace(FIELD, ''), ...section.slice(start + 1, end)].join('\n').trim();
}

export function checkRequirementsDocument({ requirements, stage, complete = false, scopeActions = null, requestedFeatures = null, strict = false }) {
  const errors = [];
  const lines = outsideFences(requirements);
  const coverage = complete && [WORKTREE_STAGE.REQUIREMENTS_FIX, WORKTREE_STAGE.BOUNDED_CONTEXT].includes(stage)
    && (strict || lines.some((line) => /^## 2\. 업무\s*$/.test(line)));
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
    const acField = fields.get('완료 조건')?.[0];
    const acEnd = acField === undefined ? -1 : positions.find((position) => position > acField) ?? lines.findIndex((line, position) => position > acField && SECTION_END.test(line));
    const acContent = acField === undefined ? '' : [lines[acField].replace(FIELD, ''), ...lines.slice(acField + 1, acEnd < 0 ? lines.length : acEnd)].join('\n').trim();
    if (coverage && (!acContent || /(?:^|\s)(?:TODO|TBD|미정)(?:\s|$)/i.test(acContent))) report('BIZ_REQUIREMENT_INCOMPLETE', `${biz} needs a concrete 완료 조건 entry.`);
    for (const [label, prefix] of [['업무 규칙', 'INV'], ['예외 시나리오', 'EX']]) {
      if (fields.get(label)?.length > 1) continue;
      const index = fields.get(label)?.[0];
      const end = positions.find((position) => position > index) ?? lines.findIndex((line, position) => position > index && SECTION_END.test(line));
      const content = index === undefined ? '' : [lines[index].replace(FIELD, ''), ...lines.slice(index + 1, end < 0 ? lines.length : end)].join('\n').trim();
      if (prefix !== 'AC' && /^(?:[-*]\s+)?(?:해당 )?없음\s+[—–-]\s+(?!후속(?:\s|$))\S[^\n]*$/.test(content)) continue;
      const items = content.split('\n').filter((line) => line.trim());
      const itemPattern = new RegExp(`^\\s*(?:[-*]\\s+)?(${prefix}-\\d+)\\s+(.+)$`);
      const unrelatedScenario = (line) => prefix === 'EX' && /^\s*[-*]\s+SC-\d+\s+\S/.test(line);
      if (!items.some((line) => itemPattern.test(line)) || items.some((line) => !itemPattern.test(line) && !unrelatedScenario(line))) {
        report('BIZ_REQUIREMENT_INCOMPLETE', `${biz} needs defined ${prefix} entries in ${label}${prefix === 'AC' ? '' : ' or an explicit reason it does not apply'}. Give each entry its stable ID and the actual rule, outcome or observable condition.`);
      }
      for (const line of items) {
        const match = itemPattern.exec(line);
        if (!match) continue;
        const [, id, description] = match;
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
  if (coverage) {
    const tables = parseTables(requirements);
    if (strict && !lines.some((line) => /^## 2\. 업무\s*$/.test(line))) errors.push({ code: 'REQUIREMENTS_BUSINESS_HEADING_MISSING', id: null, message: 'Strict requirements contract needs ## 2. 업무.', owner_stage: WORKTREE_STAGE.SUBDOMAIN_CANDIDATES });
    const actions = tables.filter((table) => table.header.includes('ACT') && table.header.includes('결정') && table.header.includes('BIZ 연결'));
    const sixOne = lines.findIndex((line) => /^### 6\.1\b/.test(line));
    if (strict && !actions.length) errors.push({ code: 'ACTION_TABLE_MISSING', id: null, message: 'Strict requirements contract needs the 6.1 ACT projection table.', owner_stage: WORKTREE_STAGE.STAKEHOLDER_ANALYSIS });
    if (strict && sixOne < 0) errors.push({ code: 'ACTION_HEADING_MISSING', id: null, message: 'Strict requirements contract needs ### 6.1 범위·비목표.', owner_stage: WORKTREE_STAGE.STAKEHOLDER_ANALYSIS });
    if (actions.length) {
      const rows = actions.flatMap((table) => table.rows);
      const actionIds = new Set();
      const bizSections = extractBizSections(lines);
      const bizIds = new Set(bizSections.keys());
      for (const [id, section] of bizSections) if (section === null) errors.push({ code: 'BIZ_ID_DUPLICATE', id, message: id + ' appears in more than one BIZ heading.', owner_stage: WORKTREE_STAGE.SUBDOMAIN_CANDIDATES });
      for (const row of rows) {
        const id = clean(row.ACT), decision = clean(row['결정']), link = clean(row['BIZ 연결']);
        if (!/^ACT-\d+$/.test(id) || actionIds.has(id)) errors.push({ code: 'ACTION_ID_INVALID', id, message: '6.1 has a missing, invalid or duplicate ACT ID: ' + (id || '(blank)'), owner_stage: WORKTREE_STAGE.STAKEHOLDER_ANALYSIS });
        actionIds.add(id);
        if (decision.startsWith('포함')) {
          const linked = [...link.matchAll(/BIZ-\d+/g)].map((match) => match[0]);
          if (!linked.length || linked.some((bizId) => !bizIds.has(bizId))) errors.push({ code: 'ACTION_BIZ_LINK_INVALID', id, message: id + ' included action must link to an existing BIZ; found: ' + (link || '(none)'), owner_stage: WORKTREE_STAGE.SUBDOMAIN_CANDIDATES });
          for (const bizId of linked) {
            const section = bizSections.get(bizId) || [];
            const references = [...fieldContent(section, '행동 ID').matchAll(/\bACT-\d+\b/g)].map((match) => match[0]);
            if (!references.includes(id)) errors.push({ code: 'BIZ_ACTION_REVERSE_LINK_MISSING', id: bizId, message: bizId + ' must refer back to ' + id + ' in its action reference field.', owner_stage: WORKTREE_STAGE.SUBDOMAIN_CANDIDATES });
          }
        } else if ((decision.startsWith('제외') || decision.startsWith('후속')) && /BIZ-\d+/.test(link)) errors.push({ code: 'EXCLUDED_ACTION_BIZ_LEAK', id, message: id + ' is excluded or deferred but leaks into BIZ link ' + link, owner_stage: WORKTREE_STAGE.STAKEHOLDER_ANALYSIS });
      }
      if (Array.isArray(scopeActions)) {
        const documentActions = new Map(rows.map((row) => [clean(row.ACT), row]));
        const sourceActions = new Map(scopeActions.map((row) => [clean(row.ACT), row]));
        const requestedFeatureNames = new Set((requestedFeatures || []).map((row) => clean(row['요청 기능'])).filter(Boolean));
        for (const [id, source] of sourceActions) {
          const row = documentActions.get(id), sourceDecision = clean(source['결정']), decision = clean(row?.['결정']);
          if (!row) errors.push({ code: 'ACTION_SCOPE_ROW_MISSING', id, message: '6.1 is missing stakeholder-analysis scope decision ' + id, owner_stage: WORKTREE_STAGE.STAKEHOLDER_ANALYSIS });
          else {
            for (const field of ['결정', '요청 기능', '행위자', '행동', '근거/answer ID']) {
              if (clean(source[field]) !== clean(row[field])) errors.push({ code: 'ACTION_SCOPE_ROW_DRIFT', id, message: id + ' differs from stakeholder-analysis in ' + field + '; stakeholder-analysis owns this value.', owner_stage: WORKTREE_STAGE.STAKEHOLDER_ANALYSIS });
            }
            if (requestedFeatureNames.size && !requestedFeatureNames.has(clean(source['요청 기능']))) errors.push({ code: 'ACTION_FEATURE_UNKNOWN', id, message: id + ' links to a feature absent from stakeholder-analysis requested-feature rows.', owner_stage: WORKTREE_STAGE.STAKEHOLDER_ANALYSIS });
            if (sourceDecision.startsWith('대기')) errors.push({ code: 'ACTION_SCOPE_OPEN', id, message: id + ' still has a pending required scope decision.', owner_stage: WORKTREE_STAGE.STAKEHOLDER_ANALYSIS });
            if (decision && sourceDecision && !decision.startsWith(sourceDecision.startsWith('포함') ? '포함' : sourceDecision.startsWith('제외') ? '제외' : sourceDecision.startsWith('후속') ? '후속' : sourceDecision)) errors.push({ code: 'ACTION_SCOPE_DECISION_DRIFT', id, message: id + ' decision in 6.1 differs from stakeholder-analysis; preserve the authoritative scope decision.', owner_stage: WORKTREE_STAGE.STAKEHOLDER_ANALYSIS });
          }
        }
        for (const source of scopeActions) {
          const decision = clean(source['결정']);
          if (!decision.startsWith('제외') && !decision.startsWith('후속')) continue;
          const id = clean(source.ACT);
          for (const [bizId, sectionLines] of bizSections) {
            const actionReference = fieldContent(sectionLines, '행동 ID');
            if (new RegExp('\\b' + id + '\\b').test(actionReference)) errors.push({ code: 'EXCLUDED_ACTION_BIZ_REVERSE_LEAK', id: bizId, message: bizId + ' action reference includes excluded/follow-up ' + id + '.', owner_stage: WORKTREE_STAGE.SUBDOMAIN_CANDIDATES });
          }
        }
        for (const feature of requestedFeatureNames) if (![...sourceActions.values()].some((row) => clean(row['요청 기능']) === feature && clean(row['결정']).startsWith('포함'))) errors.push({ code: 'REQUESTED_FEATURE_ACTION_MISSING', id: feature, message: 'Requested feature ' + feature + ' has no concrete included ACT action.', owner_stage: WORKTREE_STAGE.STAKEHOLDER_ANALYSIS });
        for (const id of documentActions.keys()) if (!sourceActions.has(id)) errors.push({ code: 'ACTION_SCOPE_ROW_EXTRA', id, message: id + ' has no authoritative stakeholder-analysis decision.', owner_stage: WORKTREE_STAGE.STAKEHOLDER_ANALYSIS });
        const e2eStart = String(requirements).indexOf('### 6.4 E2E 시나리오');
        const e2e = e2eStart < 0 ? '' : String(requirements).slice(e2eStart);
        for (const source of scopeActions.filter((row) => /^(?:제외|후속)/.test(clean(row['결정'])))) {
          const id = clean(source.ACT);
          if (id && new RegExp('\\b' + id + '\\b').test(e2e)) errors.push({ code: 'EXCLUDED_ACTION_E2E_LEAK', id, message: id + ' is excluded or deferred but appears in the E2E scenario contract.', owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
        }
      }
      const scenarioIds = new Set([...String(requirements).matchAll(/\b(SC-\d+)\b/g)].map((match) => match[1]));
      if (!scenarioIds.size) errors.push({ code: 'SCENARIO_COVERAGE_MISSING', id: null, message: 'The ACT contract is present but no stable SC-xx scenarios are recorded.', owner_stage: WORKTREE_STAGE.EVENT_STORMING });
      for (const bizId of bizIds) {
        const sectionLines = bizSections.get(bizId) || [];
        const section = sectionLines.join('\n');
        const normal = fieldContent(sectionLines, '정상 시나리오');
        const rules = fieldContent(sectionLines, '업무 규칙');
        const exceptions = fieldContent(sectionLines, '예외 시나리오');
        const normalIds = [...normal.matchAll(/\bSC-\d+\b/g)].map((match) => match[0]);
        const altLines = normal.split('\n').filter((line) => /유효 대안/.test(line));
        const altSettled = altLines.some((line) => /\bSC-\d+\b/.test(line) || /NOT_APPLICABLE\s*[—-]\s*\S/.test(line));
        const failSettled = /\bSC-\d+\b/.test(exceptions) || /NOT_APPLICABLE\s*[—-]\s*\S/.test(exceptions);
        if (complete && (!normalIds.length || !normal.trim())) errors.push({ code: 'SCENARIO_CLASS_UNSETTLED', id: bizId, message: bizId + ' needs a defined normal SC scenario.', owner_stage: WORKTREE_STAGE.EVENT_STORMING });
        if (complete && !altSettled) errors.push({ code: 'SCENARIO_CLASS_UNSETTLED', id: bizId, message: bizId + ' needs a valid alternative SC or a reasoned NOT_APPLICABLE.', owner_stage: WORKTREE_STAGE.EVENT_STORMING });
        if (complete && !failSettled) errors.push({ code: 'SCENARIO_CLASS_UNSETTLED', id: bizId, message: bizId + ' needs a failure/rejection SC or a reasoned NOT_APPLICABLE.', owner_stage: WORKTREE_STAGE.EVENT_STORMING });
        const scenarioIds = [...section.matchAll(/^\s*[-*]\s*(SC-\d+)\b[^\n]*$/gm)].map((match) => match[1]);
        const localScenarios = new Set();
        for (const scenarioId of scenarioIds) {
          if (localScenarios.has(scenarioId)) errors.push({ code: 'SCENARIO_ID_DUPLICATE', id: bizId, message: bizId + ' repeats ' + scenarioId + '.', owner_stage: WORKTREE_STAGE.EVENT_STORMING });
          localScenarios.add(scenarioId);
        }
        const invIds = new Set([...rules.matchAll(/^\s*[-*]\s*(INV-\d+)\b/gm)].map((match) => match[1]));
        const exIds = new Set([...exceptions.matchAll(/^\s*[-*]\s*(EX-\d+)\b/gm)].map((match) => match[1]));
        const scenarioDefinitions = new Set([normal, exceptions].flatMap((content) => [...content.matchAll(/^\s*[-*]\s*(SC-\d+)\s+\S/gm)].map((match) => match[1])));
        const acLines = sectionLines.filter((line) => /^\s*[-*]\s*(?:AC-\d+)\b/.test(line));
        if (!acLines.length) errors.push({ code: 'BIZ_REQUIREMENT_INCOMPLETE', id: bizId, message: bizId + ' needs a defined AC entry in 완료 조건.', owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
        const coveredScenarios = new Set(), coveredRules = new Set(), coveredExceptions = new Set();
        for (const line of acLines) {
          const observable = /(?:관찰 결과|결과)\s*[:：]\s*([^;；]+)/.exec(line)?.[1]?.trim();
          const condition = /조건\s*[:：]\s*([^;；]+)/.exec(line)?.[1]?.trim();
          const action = /행위\s*[:：]\s*([^;；]+)/.exec(line)?.[1]?.trim();
          const state = /상태\s*[:：]\s*(.+?)(?:\s+[—–-]\s+출처:|$)/.exec(line)?.[1]?.trim();
          const linkedScenarios = [...line.matchAll(/\bSC-\d+\b/g)].map((match) => match[0]);
          const linkedRules = [...line.matchAll(/\bINV-\d+\b/g)].map((match) => match[0]);
          const linkedExceptions = [...line.matchAll(/\bEX-\d+\b/g)].map((match) => match[0]);
          linkedScenarios.forEach((id) => coveredScenarios.add(id)); linkedRules.forEach((id) => coveredRules.add(id)); linkedExceptions.forEach((id) => coveredExceptions.add(id));
          if (!linkedScenarios.length || linkedScenarios.some((id) => !scenarioDefinitions.has(id)) || linkedRules.some((id) => !invIds.has(id)) || linkedExceptions.some((id) => !exIds.has(id)) || !condition || !action || !observable || !state || /^(?:오류 발생|오류가 발생)$/u.test(observable || '')) errors.push({ code: 'AC_OUTCOME_STRUCTURE_INVALID', id: bizId, message: bizId + ' has an AC without defined links, nonblank condition/action/observable outcome and state: ' + line.trim(), owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
        }
        for (const id of scenarioDefinitions) if (!coveredScenarios.has(id)) errors.push({ code: 'COVERAGE_AC_LINK_MISSING', id: bizId, message: bizId + ' scenario ' + id + ' has no AC link.', owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
        for (const id of invIds) if (!coveredRules.has(id)) errors.push({ code: 'COVERAGE_AC_LINK_MISSING', id: bizId, message: bizId + ' rule ' + id + ' has no AC link.', owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
        for (const id of exIds) if (!coveredExceptions.has(id)) errors.push({ code: 'COVERAGE_AC_LINK_MISSING', id: bizId, message: bizId + ' exception ' + id + ' has no AC link.', owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
      }
      const stateMatch = /^- 상태:\s*(\S+)/m.exec(String(requirements));
      if (strict && complete && !stateMatch) errors.push({ code: 'REQUIREMENTS_STATE_MISSING', id: null, message: 'Strict requirements contract needs the document status marker.', owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
      if (strict && complete && stage === WORKTREE_STAGE.REQUIREMENTS_FIX && stateMatch?.[1] !== 'draft') errors.push({ code: 'REQUIREMENTS_FIXED_TOO_EARLY', id: null, message: 'requirements-fix must leave requirements.md in draft; bounded-context owns fixed promotion.', owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
      if (strict && complete && stage === WORKTREE_STAGE.BOUNDED_CONTEXT && stateMatch?.[1] !== 'fixed') errors.push({ code: 'REQUIREMENTS_NOT_FIXED', id: null, message: 'bounded-context completion must promote the fully covered requirements.md to fixed.', owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
      if (strict && complete && stage === WORKTREE_STAGE.REQUIREMENTS_FIX) {
        const subdomains = tables.filter((table) => table.header.includes('SD') && table.header.includes('상태')).flatMap((table) => table.rows);
        for (const row of subdomains) if (clean(row['상태']) !== 'confirmed') errors.push({ code: 'SUBDOMAIN_NOT_CONFIRMED', id: clean(row.SD), message: clean(row.SD) + ' must be confirmed by subdomain-classification before requirements-fix completes.', owner_stage: WORKTREE_STAGE.SUBDOMAIN_CLASSIFICATION });
      }
      if (strict && complete && stage === WORKTREE_STAGE.BOUNDED_CONTEXT) {
        const contextTables = tables.filter((table) => table.header.includes('BC') && table.header.some((column) => /포함.*BIZ/.test(column)));
        if (!contextTables.length) errors.push({ code: 'BOUNDED_CONTEXT_ASSIGNMENT_MISSING', id: null, message: 'bounded-context must assign each covered BIZ to a Context.', owner_stage: WORKTREE_STAGE.BOUNDED_CONTEXT });
        const assignments = contextTables.flatMap((table) => table.rows);
        const contextIds = new Set();
        const assignedBiz = new Map();
        for (const row of assignments) {
          const contextId = clean(row.BC);
          if (!contextId || contextIds.has(contextId)) errors.push({ code: 'BOUNDED_CONTEXT_ID_INVALID', id: contextId || null, message: 'Context IDs must be present and unique.', owner_stage: WORKTREE_STAGE.BOUNDED_CONTEXT });
          contextIds.add(contextId);
          for (const id of clean(row['포함 SD·BIZ'] || row['포함 SD·BIZ']).match(/\bBIZ-\d+\b/g) || []) {
            if (assignedBiz.has(id)) errors.push({ code: 'BIZ_CONTEXT_DUPLICATE', id, message: id + ' is assigned to more than one Context.', owner_stage: WORKTREE_STAGE.BOUNDED_CONTEXT });
            assignedBiz.set(id, contextId);
          }
        }
        for (const id of bizIds) if (!assignedBiz.has(id)) errors.push({ code: 'BIZ_CONTEXT_MISSING', id, message: id + ' has no owning Context.', owner_stage: WORKTREE_STAGE.BOUNDED_CONTEXT });
      }
      const open = tables.filter((table) => table.header.includes('상태') && table.header.some((header) => /HS|INV|EX/.test(header))).flatMap((table) => table.rows).filter((row) => ['대기', '미정', 'TODO', 'UNRESOLVED', 'PARTIAL'].includes(clean(row['상태'])));
      if (open.length) errors.push({ code: 'REQUIREMENTS_DECISION_OPEN', id: null, message: 'Unresolved mandatory decision/hotspot rows remain: ' + open.map((row) => clean(row.HS || row.INV || row.EX || row.BIZ || row['관련 BIZ'])).filter(Boolean).join(', '), owner_stage: WORKTREE_STAGE.REQUIREMENTS_FIX });
    }
  }
  return { ok: errors.length === 0, errors };
}

// The runner's verdict when a requirements stage returns its questions or completes; null when the check does not apply.
export async function evaluateRequirementsDocumentGate({ root, input, envelope }) {
  const stage = input?.skill;
  const planSetId = input?.context?.plan_set_id;
  if (!REQUIREMENTS_STAGES.includes(stage) || !planSetId || !['completed', 'action_required'].includes(envelope?.status)) return null;
  const requirements = await planSetDocument(root, planSetId, 'requirements.md');
  const analysis = stage === WORKTREE_STAGE.STAKEHOLDER_ANALYSIS ? null : await planSetDocument(root, planSetId, 'stakeholder-analysis.md');
  let strict = input?.context?.requirements_contract_version === 1;
  const controlSession = input?.context?.control_session_directory;
  if (!strict && controlSession) {
    try {
      const { readSkillSessionJson } = await import('./skill-execution.mjs');
      for (const path of ['runtime/orchestrator/workflow.json', 'runtime/orchestrator/state.json']) {
        let record;
        try { record = await readSkillSessionJson({ root, session_directory: controlSession, path }); }
        catch (error) { if (['ENOENT', 'NOT_FOUND'].includes(error.code)) continue; throw error; }
        if (record?.state?.stages?.[WORKTREE_STAGE.STAKEHOLDER_ANALYSIS]?.requirements_contract_version === 1 || record?.stages?.[WORKTREE_STAGE.STAKEHOLDER_ANALYSIS]?.requirements_contract_version === 1) { strict = true; break; }
      }
    } catch (error) { if (!['ENOENT', 'NOT_FOUND'].includes(error.code)) throw error; }
  }
  const complete = envelope.status === 'completed' && envelope.code === 'OK';
  if (requirements.text === null) {
    const skipped = /(?:^|\n)- 판정:\s*생략(?:\s|$)/.test(analysis?.text || '');
    if (strict && complete && stage !== WORKTREE_STAGE.STAKEHOLDER_ANALYSIS && !skipped) return { stage, ok: false, errors: [{ code: 'REQUIREMENTS_DOCUMENT_MISSING', id: null, message: 'Fresh stakeholder-analysis execution requires requirements.md before a requirements stage can complete.', owner_stage: WORKTREE_STAGE.STAKEHOLDER_ANALYSIS }] };
    return null;
  }
  const analysisTables = analysis?.text ? parseTables(analysis.text) : [];
  const scopeActions = analysis?.text ? analysisTables.filter((table) => table.header.includes('ACT') && table.header.includes('결정')).flatMap((table) => table.rows) : null;
  const requestedFeatures = analysisTables.filter((table) => table.header.includes('요청 기능') && table.header.includes('요청 문구')).flatMap((table) => table.rows);
  return { stage, ...checkRequirementsDocument({ requirements: requirements.text, stage, complete, scopeActions, requestedFeatures, strict }) };
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
