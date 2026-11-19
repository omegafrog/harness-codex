// Deterministic design-freeze gate. The tactical design flow and the implementation-design stages (tactical-technology, tactical-ui,
// tactical-api, tactical-data) add no scope: every use case, endpoint, screen and stored entity traces to an existing requirement.
// The runner runs this check once, when the last implementation-design stage (tactical-data) reports completed/OK
// (`harness-native-stage.mjs finish`, and `recordExecutionState` for every other path), and `to-ticket` does not start while it
// fails. Every finding names the stage that owns the failing document (`owner_stage`), so a failure tells which stage to reopen.
//
// It holds only what must be true whatever the design, and reads documents by their table key columns:
// - api.md: every endpoint row (a table with a `Method / path` column) cites, in its `근거` column, an `AS-xx` use case that
//   tactical-design.md declares; any BIZ/INV/EX/AC it cites exists in requirements.md;
// - data.md (rows with a `저장 상태` column) and ui-handoff.md (rows with a `화면` column): the `근거` column cites an existing
//   `AS-xx` or requirement ID;
// - data.md binds each outbound interface of a context component design to its concrete implementation and wiring.
// - every BIZ that an external system does not own alone has an `AS-xx` use case, and, when the BIZ has a user actor and the
//   plan set declares endpoints or screens, at least one endpoint or screen that cites it or one of its use cases.
// A missing UI/API/storage table means the surface is not applicable. Contextual judgement belongs to the stage GUIDEs.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { EXTERNAL, clean, ids, isBlank, names, outsideFences, parseTables, planSetDocument, readContextDesign, rowsOf, sections, stakeholderAnalysisSkipped, unique } from './domain-model-gate.mjs';
import { TACTICAL_DESIGN_DOCUMENT, WORKTREE_STAGE } from './worktree-stages.mjs';

export const FREEZE_STAGE = WORKTREE_STAGE.TACTICAL_DATA;
const AS_ID = /\bAS-\d+\b/g;
const REQUIREMENT_ID = /\b(?:BIZ|INV|EX|AC)-\d+\b/g;
const USER_ACTOR = /사용자|이용자|회원|고객|방문자|작성자|관리자/;
const TRACE = /^(?:근거|추적|trace)/i;
const BIZ_ID = /\bBIZ-\d+\b/g;
const PORT_CONTRACT = ['시그니처', '소유 위치', '사용 메서드', '실패 계약'];
const BINDING_FIELDS = ['인터페이스 경로', '구현체', '구현체 경로', '기술·구현 선언', '조립 위치', '데이터 매핑', '트랜잭션 공유'];
const NOT_APPLICABLE = /^해당 없음\s*[—–-]\s*\S/;

const DOCUMENTS = Object.freeze({
  api: { name: 'api.md', owner: WORKTREE_STAGE.TACTICAL_API, key: (header) => header.some((name) => /method/i.test(name) && /path/i.test(name)), item: (row, header) => clean(row[header.find((name) => /method/i.test(name) && /path/i.test(name))]), kind: 'API endpoint', needsUseCase: true },
  data: { name: 'data.md', owner: WORKTREE_STAGE.TACTICAL_DATA, key: (header) => header.includes('저장 상태'), item: (row) => `${clean(row['소유 컨텍스트'] || '')} ${clean(row['저장 상태'])}`.trim(), kind: 'stored entity', skip: (row) => /^(?:없음|해당 없음)(?:\s|$|[—–-])/.test(clean(row['저장 상태'])) || isBlank(row['저장 상태']) },
  ui: { name: 'ui-handoff.md', owner: WORKTREE_STAGE.TACTICAL_UI, key: (header) => header.includes('화면'), item: (row) => clean(row['화면']), kind: 'screen' },
});

// The traced rows of a document: every row of a table that has the document's key column, with what each row cites.
function tracedRows(kind, text) {
  const spec = DOCUMENTS[kind];
  const rows = [];
  for (const table of parseTables(text || '')) {
    if (!spec.key(table.header)) continue;
    const trace = table.header.find((name) => TRACE.test(name));
    for (const row of table.rows) {
      if (spec.skip?.(row)) continue;
      const cell = trace === undefined ? '' : row[trace];
      rows.push({ item: spec.item(row, table.header), hasColumn: trace !== undefined, useCases: ids(cell, AS_ID), requirements: ids(cell, REQUIREMENT_ID) });
    }
  }
  return rows;
}

const ACTOR_LINE = /^\s*[-*]\s*업무 주체\s*:\s*(.*)$/m;
const bizSections = (requirements) => {
  const text = String(requirements);
  const starts = [...text.matchAll(/^#{2,3}[ \t]+(?:(BIZ-\d+)\b)?/gm)];
  return starts.filter((match) => match[1]).map((match) => ({ id: match[1], text: text.slice(match.index, starts.find((next) => next.index > match.index)?.index ?? text.length) }));
};

function checkBindings(contexts, data, fail) {
  const report = (code, message, id) => fail(code, message, WORKTREE_STAGE.TACTICAL_DATA, id);
  const key = (context, port) => JSON.stringify([clean(context), clean(port)]);
  const label = (context, port) => `${clean(context)} / ${clean(port)}`;
  const ports = new Map(contexts.flatMap(({ id, interfaces }) => interfaces.map((row) => [key(id, row['인터페이스']), { row, label: label(id, row['인터페이스']) }])));
  const lines = outsideFences(data || '');
  const start = lines.findIndex((line) => line.trim() === '## 인프라 바인딩');
  const end = lines.findIndex((line, index) => index > start && /^#{1,2}[ \t]+/.test(line));
  const section = start < 0 ? '' : lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
  const rows = rowsOf(section, '컨텍스트', '인터페이스');
  if (!ports.size && !rows.length) {
    if (!/^-[ \t]+판정:[ \t]*해당 없음[ \t]*[—–-][ \t]*\S/m.test(section)) report('INFRASTRUCTURE_BINDING_MISSING', 'data.md must explain why no outbound interface applies under `## 인프라 바인딩`');
    return;
  }
  const seen = new Set();
  for (const row of rows) {
    const id = key(row['컨텍스트'], row['인터페이스']);
    const port = ports.get(id);
    if (!port) {
      report('INFRASTRUCTURE_BINDING_UNDECLARED', 'data.md binds an interface that the bounded context does not declare', label(row['컨텍스트'], row['인터페이스']));
      continue;
    }
    if (seen.has(id)) {
      report('INFRASTRUCTURE_BINDING_DUPLICATE', 'data.md specifies more than one binding for the interface', port.label);
      continue;
    }
    seen.add(id);
    const missing = [...PORT_CONTRACT, ...BINDING_FIELDS].filter((field) => {
      const value = clean(row[field]);
      if (isBlank(value) || /^(?:미정|TBD|TODO)(?:\s|$|[—–-])/i.test(value)) return true;
      if (/^(?:해당 )?없음(?:\s|$|[—–-])/.test(value)) return !['데이터 매핑', '트랜잭션 공유'].includes(field) || !NOT_APPLICABLE.test(value);
      if (['인터페이스 경로', '구현체 경로'].includes(field)) {
        const path = row[field].replaceAll('`', '').trim();
        return /^(?:\/|[a-z]:)|[\\*?]|\/$/i.test(path) || path.split('/').includes('..');
      }
      return false;
    });
    const mismatched = PORT_CONTRACT.filter((field) => !missing.includes(field) && row[field].replaceAll('`', '') !== port.row[field].replaceAll('`', ''));
    if (missing.length) report('INFRASTRUCTURE_BINDING_INCOMPLETE', `data.md must settle ${missing.join(', ')} for this interface`, port.label);
    if (mismatched.length) report('INFRASTRUCTURE_BINDING_MISMATCH', `data.md must preserve the tactical interface contract for ${mismatched.join(', ')}`, port.label);
  }
  for (const [id, port] of ports) {
    if (!seen.has(id)) report('INFRASTRUCTURE_BINDING_MISSING', 'data.md must bind this interface under `## 인프라 바인딩`', port.label);
  }
}

export function checkDesignFreeze({ requirements, tacticalDesign, documents = {} }) {
  const errors = [];
  const fail = (code, message, owner_stage, id) => errors.push({ code, message, ...(id ? { id } : {}), owner_stage });
  const known = new Set([...String(requirements).matchAll(/^\s*(?:[-*]\s+|#{3}\s+)((?:BIZ|INV|EX|AC)-\d+)\b/gm)].map((match) => match[1]));
  const contexts = readContextDesign(tacticalDesign);
  const parts = contexts ? {} : sections(tacticalDesign);
  const designLocation = contexts ? 'bounded context Application Service methods' : 'section 4';
  const useCases = new Map();
  for (const row of contexts ? contexts.flatMap(({ application }) => application) : rowsOf(parts[4], 'AS', '업무')) {
    for (const id of ids(row['AS'], AS_ID)) useCases.set(id, unique([...(useCases.get(id) || []), ...ids(row['업무'], BIZ_ID)]));
  }
  const owner = (kind) => DOCUMENTS[kind].owner;

  // 1. Every item of an implementation-design document traces to an existing use case and requirement.
  const traced = {};
  for (const kind of Object.keys(DOCUMENTS)) {
    const spec = DOCUMENTS[kind];
    traced[kind] = tracedRows(kind, documents[kind]);
    for (const row of traced[kind]) {
      const label = `${spec.kind} \`${row.item}\` of ${spec.name}`;
      const how = row.hasColumn ? 'its `근거` cites' : `the table has no \`근거\` column, so it cites`;
      const unknownUseCases = row.useCases.filter((id) => !useCases.has(id));
      const unknownRequirements = row.requirements.filter((id) => !known.has(id));
      if (unknownUseCases.length || unknownRequirements.length) fail('UNTRACED_ITEM', `${label} cites ${[...unknownUseCases, ...unknownRequirements].join(', ')}, which ${TACTICAL_DESIGN_DOCUMENT} ${designLocation} / requirements.md does not declare. No scope is added after the requirements: remove the item`, owner(kind), row.item);
      else if (spec.needsUseCase ? !row.useCases.length : !row.useCases.length && !row.requirements.length) fail('UNTRACED_ITEM', `${label}: ${how} no ${spec.needsUseCase ? `application-service use case (AS-xx of ${designLocation})` : 'use case (AS-xx) or requirement ID'}. Cite the use case that serves it, or remove the item: scope is never added after the requirements`, owner(kind), row.item);
    }
  }

  // 2. Every BIZ that an external system does not own alone has a use case, and a user-facing BIZ has an endpoint or screen.
  const externalOnly = (business) => {
    if (contexts) {
      const models = contexts.flatMap(({ models }) => models).filter((row) => ids(row['업무'], BIZ_ID).includes(business));
      return models.length > 0 && models.every((row) => clean(row['종류']) === EXTERNAL) && ![...useCases.values()].some((requirements) => requirements.includes(business));
    }
    const rows = rowsOf(parts[1], '요구', '소유 모델').filter((row) => ids(row['요구'], BIZ_ID).includes(business));
    return rows.length > 0 && rows.every((row) => clean(row['소유 모델']).includes(EXTERNAL) && !names(row['소유 모델']).some((name) => name !== EXTERNAL));
  };
  const surfaces = [...traced.api, ...traced.ui];
  for (const { id, text } of bizSections(requirements)) {
    if (externalOnly(id)) continue;
    const mine = [...useCases].filter(([, business]) => business.includes(id)).map(([as]) => as);
    if (!mine.length) { fail('REQUIREMENT_UNCOVERED', `${id} has no application-service use case in ${designLocation} of ${TACTICAL_DESIGN_DOCUMENT}`, WORKTREE_STAGE.APPLICATION_SERVICE, id); continue; }
    if (!surfaces.length || !USER_ACTOR.test(ACTOR_LINE.exec(text)?.[1] || '')) continue;
    if (!surfaces.some((row) => row.requirements.includes(id) || row.useCases.some((as) => mine.includes(as)))) fail('REQUIREMENT_UNCOVERED', `${id} has a user actor and use cases (${mine.join(', ')}) but no endpoint or screen cites it or one of them`, traced.api.length ? owner('api') : owner('ui'), id);
  }
  if (contexts) checkBindings(contexts, documents.data, fail);
  const order = [WORKTREE_STAGE.APPLICATION_SERVICE, WORKTREE_STAGE.TACTICAL_UI, WORKTREE_STAGE.TACTICAL_API, WORKTREE_STAGE.TACTICAL_DATA];
  return { ok: errors.length === 0, errors: errors.sort((a, b) => order.indexOf(a.owner_stage) - order.indexOf(b.owner_stage)) };
}

async function implementationDocument(root, planSetId, name) {
  const path = `docs/implementation/${planSetId}/${name}`;
  await assertWorkspaceTarget(root, path);
  try { return await readFile(join(root, path), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// The gate on the plan set's documents of a workspace: what the command, the runner and the to-ticket start guard all run. A plan
// set that skipped the requirements flow, or whose requirements/tactical design do not exist (the tactical design gate owns that),
// has nothing to trace.
export async function checkWorkspaceDesignFreeze({ root, planSetId }) {
  const analysis = await planSetDocument(root, planSetId, 'stakeholder-analysis.md');
  if (analysis.text !== null && stakeholderAnalysisSkipped(analysis.text)) return { ok: true, skipped: true, errors: [] };
  const requirements = await planSetDocument(root, planSetId, 'requirements.md');
  const tacticalDesign = await planSetDocument(root, planSetId, TACTICAL_DESIGN_DOCUMENT);
  if (requirements.text === null || tacticalDesign.text === null) return { ok: true, skipped: true, errors: [] };
  const documents = {};
  for (const [kind, spec] of Object.entries(DOCUMENTS)) documents[kind] = await implementationDocument(root, planSetId, spec.name);
  return checkDesignFreeze({ requirements: requirements.text, tacticalDesign: tacticalDesign.text, documents });
}

export async function evaluateDesignFreezeGate({ root, input, envelope }) {
  const stage = input?.skill;
  const planSetId = input?.context?.plan_set_id;
  if (stage !== FREEZE_STAGE || envelope?.status !== 'completed' || !planSetId) return null;
  return { stage, ...(await checkWorkspaceDesignFreeze({ root, planSetId })) };
}

export function freezeFailureInstruction(verdict) {
  const earlier = unique(verdict.errors.map((error) => error.owner_stage)).filter((stage) => stage !== verdict.stage);
  const head = `The runner ran the design-freeze gate (harness-design-freeze-check.mjs) once for ${verdict.stage} and it failed. Nothing was committed or recorded, and the stage is still running. The design must add no scope: every item traces to a use case and requirement that already exist.`;
  if (!earlier.length) return `${head} Repair your own document (data.md): cite the use case or requirement of each stored entity and settle the concrete binding of every declared outbound interface. Remove undeclared items. Never edit requirements.md or an earlier document to make the gate pass. Rewrite your output file if its summary or artifacts change, then run finish again.`;
  return `${head} Errors whose owner_stage is ${earlier.join(', ')} are in documents of earlier stages, which are settled input and are not repaired by ${verdict.stage}. Return blocked / DEPENDENCY_INCOMPLETE with result.owner_stage ${earlier[0]} (the earliest stage to reopen: an UNTRACED_ITEM is removed by its owner, a REQUIREMENT_UNCOVERED use case or endpoint is added by it) and result.dependency_gap holding these errors as the evidence, without editing any earlier document, and rewrite your output file, then run finish again. The orchestrator reopens ${earlier[0]} itself with --reopen-for and re-runs the stale stages in order, without asking the user. Never ask the user whether to include the item in scope.`;
}

export class DesignFreezeError extends Error {
  constructor(verdict) {
    super(`Design-freeze gate failed for ${verdict.stage}: ${verdict.errors.map((error) => `${error.code}${error.id ? ` (${error.id})` : ''} [${error.owner_stage}] ${error.message}`).join('; ')}`);
    this.name = 'DesignFreezeError';
    this.verdict = verdict;
  }
}

export async function assertDesignFreezeGate(options) {
  const verdict = await evaluateDesignFreezeGate(options);
  if (verdict && !verdict.ok) throw new DesignFreezeError(verdict);
  return verdict;
}

// to-ticket splits a frozen design: it starts only while the gate passes on the current documents.
export async function designNotFrozen({ root, planSetId }) {
  if (!planSetId) return null;
  const verdict = await checkWorkspaceDesignFreeze({ root, planSetId });
  if (verdict.ok) return null;
  return `DESIGN_NOT_FROZEN: to-ticket splits a frozen design and does not start while the design-freeze gate fails (${verdict.errors.map((error) => `${error.code}${error.id ? ` ${error.id}` : ''} [${error.owner_stage}]`).join(', ')}). Re-run tactical-data so the gate passes (node .codex/scripts/harness-design-freeze-check.mjs --workspace-root <root> shows the errors); a design change is made by the stage that owns it, never by to-ticket`;
}
