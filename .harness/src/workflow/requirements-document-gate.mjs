// Check BIZ field uniqueness before result acceptance and require defined INV, EX and AC entries at coverage completion.
import { clean, outsideFences, planSetDocument, stakeholderAnalysisSkipped } from './domain-model-gate.mjs';
import { ACCESS_KIND, openFactRows } from './stakeholder-analysis-gate.mjs';
import { REQUIREMENTS_STAGES, WORKTREE_STAGE } from './worktree-stages.mjs';

const BIZ_HEADING = /^###[ \t]+(BIZ-\d+)\b/;
const FIELD = /^- ([^:：\n]+?)\s*[:：]/;
const SECTION_END = /^#{1,3}[ \t]/;

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

// The runner's verdict when a requirements stage returns its questions or completes; null when the check does not apply.
export async function evaluateRequirementsDocumentGate({ root, input, envelope, draftExecutionId }) {
  const stage = input?.skill;
  const planSetId = input?.context?.plan_set_id;
  if (!REQUIREMENTS_STAGES.includes(stage) || !planSetId || !['completed', 'action_required'].includes(envelope?.status)) return null;
  const requirements = await planSetDocument(root, planSetId, 'requirements.md', draftExecutionId);
  if (requirements.text === null) return null;
  const complete = envelope.status === 'completed' && envelope.code === 'OK';
  const analysis = complete && [WORKTREE_STAGE.REQUIREMENTS_FIX, WORKTREE_STAGE.BOUNDED_CONTEXT].includes(stage) ? await planSetDocument(root, planSetId, 'stakeholder-analysis.md', draftExecutionId) : { text: null };
  return { stage, ...checkRequirementsDocument({ requirements: requirements.text, stage, complete, analysis: analysis.text }) };
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
