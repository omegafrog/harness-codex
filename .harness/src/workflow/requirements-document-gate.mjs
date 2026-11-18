// Deterministic shape check of requirements.md when a requirements stage returns its questions or completes.
// Every BIZ section holds each field once: a stage fills a field by replacing its line in place (for example the
// `없음 — 후속 stage가 채운다` placeholder), never by appending a second field of the same name. An E2E event-storming run
// appended a second `- 업무 규칙:`, `- 예외 시나리오:` and `- 이벤트 흐름:` to one BIZ and then failed to merge them with
// patches built from a stale view of the file; this check rejects such a document before it is committed.
import { planSetDocument } from './domain-model-gate.mjs';
import { REQUIREMENTS_STAGES } from './worktree-stages.mjs';

const BIZ_HEADING = /^###[ \t]+(BIZ-\d+)\b/;
const FIELD = /^- ([^:：\n]+?)\s*[:：]/;
const SECTION_END = /^#{1,3}[ \t]/;

export function checkRequirementsDocument({ requirements, stage }) {
  const errors = [];
  let biz = null;
  let fields = new Map();
  const close = () => {
    for (const [label, lines] of fields) {
      if (lines.length > 1) errors.push({ code: 'DUPLICATE_FIELD', id: biz, message: `${biz} has the field "${label}" ${lines.length} times (lines ${lines.join(', ')}). Fill a field by replacing its existing line in place; merge the duplicates into the first one and remove the rest. Re-read the ${biz} section before patching and anchor each patch hunk on its heading (@@ ### ${biz} ...).`, owner_stage: stage });
    }
  };
  String(requirements ?? '').split(/\r?\n/).forEach((line, index) => {
    const heading = BIZ_HEADING.exec(line);
    if (heading || (biz && SECTION_END.test(line))) {
      if (biz) close();
      biz = heading ? heading[1] : null;
      fields = new Map();
      return;
    }
    if (!biz) return;
    const field = FIELD.exec(line);
    if (field) fields.set(field[1].trim(), [...(fields.get(field[1].trim()) || []), index + 1]);
  });
  if (biz) close();
  return { ok: errors.length === 0, errors };
}

// The runner's verdict when a requirements stage returns its questions or completes; null when the check does not apply.
export async function evaluateRequirementsDocumentGate({ root, input, envelope }) {
  const stage = input?.skill;
  const planSetId = input?.context?.plan_set_id;
  if (!REQUIREMENTS_STAGES.includes(stage) || !planSetId || !['completed', 'action_required'].includes(envelope?.status)) return null;
  const requirements = await planSetDocument(root, planSetId, 'requirements.md');
  if (requirements.text === null) return null;
  return { stage, ...checkRequirementsDocument({ requirements: requirements.text, stage }) };
}

export const requirementsDocumentFailureInstruction = (verdict) => `The runner checked requirements.md for ${verdict.stage} and found a BIZ field written twice. Nothing was committed or recorded, and the stage is still running. Return these errors to the same subagent so it re-reads each named BIZ section, merges the duplicate field into the first occurrence in place, rewrites its output file if needed, then run finish again.`;

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
