// Deterministic gate of the tactical design flow (domain-model, aggregate-design, domain-service, application-service,
// integration-design). It checks the plan set's whole tactical-design.md against the fixed requirements.md, once: the runner
// runs it when the last stage of the flow, context-boundary, reports completed/OK (`harness-native-stage.mjs finish` before
// anything is committed, and `recordExecutionState` for every other path that records the stage). No earlier stage is gated,
// so a stage never runs it. Every finding names the stage that owns the failing section (`owner_stage`), so a failure that
// comes from an earlier stage's section tells which stage to reopen.
//
// It holds only what must be true whatever the design: the documents and sections exist, every BIZ/INV/EX is owned by a model
// and every INV/EX has an enforcing behaviour, every rule that spans Aggregates cites a sourced consistency decision, one
// transaction changes at most one Aggregate, and Saga/Outbox belong to eventual consistency. Contextual DDD judgement (where
// an Entity lives, what to merge, what a Domain Service owns, how contexts integrate) belongs to the stage GUIDEs and reviews.
// Tables are found by their key columns and read tolerantly: an unknown or missing optional column is ignored.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { TACTICAL_DESIGN_DOCUMENT, TACTICAL_DESIGN_STAGES, WORKTREE_STAGE } from './worktree-stages.mjs';
import { specArtifactPath } from './worktrees.mjs';

// Section N of tactical-design.md is filled by the Nth stage of the flow; section 7 is decision history.
export const FINAL_TACTICAL_STAGE = TACTICAL_DESIGN_STAGES.at(-1);
const stageOfSection = (number) => TACTICAL_DESIGN_STAGES[number - 1];
const EXTERNAL = '외부 시스템';
const RULE_ID = /\b(?:INV|EX)-\d+\b/g;
const CON_ID = /\bCON-\d+\b/g;
// A consistency decision rests on a user decision or on evidence the requirements already carry; an agent proposal alone is not a source.
const DECISION_SOURCE = /answers\.json|\b(?:INV|EX|AC|BIZ)-\d+\b|요청 원문|CAND-\d+ 채택|사용자 수정 지시/;

const unique = (items) => [...new Set(items)];
const clean = (value) => String(value ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
const isBlank = (value) => !clean(value) || /^[-–—]$/.test(clean(value));
const names = (value) => clean(value).replace(/[(（][^)）]*[)）]/g, '').split(/[,，、]|\s및\s/).map((item) => item.trim()).filter((item) => item && !isBlank(item));
const ids = (value, pattern) => unique(clean(value).match(pattern) || []);
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
// A column found by a pattern on its header, for the optional columns whose exact wording may vary.
const field = (row, pattern) => { const key = Object.keys(row).find((name) => pattern.test(name)); return key === undefined ? '' : row[key]; };

// The text with fenced code blocks blanked, so an example inside one is never read as the document.
const outsideFences = (text) => {
  let fenced = false;
  return String(text).split(/\r?\n/).map((line) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return ''; }
    return fenced ? '' : line;
  });
};

// Tables outside fenced code blocks, keyed by their header cells.
export function parseTables(text) {
  const lines = outsideFences(text);
  const tables = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) continue;
    const header = cells(lines[i]).map(clean);
    const rows = [];
    i += 2;
    while (i < lines.length && /^\s*\|/.test(lines[i])) {
      const row = cells(lines[i]);
      if (row.some((cell) => !isBlank(cell))) rows.push(Object.fromEntries(header.map((name, index) => [name, row[index] ?? ''])));
      i += 1;
    }
    i -= 1;
    tables.push({ header, rows });
  }
  return tables;
}

// tactical-design.md by its numbered top-level sections; a section is "filled" once its heading is present.
function sections(text) {
  const body = outsideFences(text).join('\n');
  const parts = {};
  const matches = [...body.matchAll(/^##[ \t]+(\d+)(?!\d)/gm)];
  matches.forEach((match, index) => { parts[Number(match[1])] = body.slice(match.index, matches[index + 1]?.index ?? body.length); });
  return parts;
}

// The rows of every table of the section that has all the key columns.
const rowsOf = (section, ...required) => parseTables(section || '').filter((table) => required.every((name) => table.header.includes(name))).flatMap((table) => table.rows);

export function parseRequirements(text) {
  return {
    business: unique([...String(text).matchAll(/^#{3}\s+(BIZ-\d+)\b/gm)].map((match) => match[1])),
    rules: unique([...String(text).matchAll(/^\s*[-*]\s+(INV-\d+|EX-\d+)\b/gm)].map((match) => match[1])),
  };
}

// A behaviour cell that names nothing: blank, `-` or `없음 — <reason>`. Any other form (Aggregate or Entity method, Value Object
// rule, Domain Service, 외부 시스템) enforces the rule.
const noBehavior = (value) => isBlank(value) || /^(해당 )?없음(\s*[—–-].*)?$/.test(clean(value));

export function checkTacticalDesign({ requirements, tacticalDesign }) {
  const errors = [];
  let owner = stageOfSection(1);
  const fail = (code, message, id) => errors.push({ code, message, ...(id ? { id } : {}), owner_stage: owner });
  const { business, rules } = parseRequirements(requirements);
  const parts = sections(tacticalDesign);
  TACTICAL_DESIGN_STAGES.forEach((stage, index) => { if (!parts[index + 1]) errors.push({ code: 'SECTION_MISSING', message: `${TACTICAL_DESIGN_DOCUMENT} has no \`## ${index + 1}.\` section; ${stage} must have filled it`, owner_stage: stage }); });
  if (errors.length) return result(errors);

  // 1. Every BIZ maps to a model or an external-system marker, and every INV and EX to an owning model.
  const models = new Set(rowsOf(parts[1], '모델', '종류').map((row) => clean(row['모델'])).filter(Boolean));
  const owners = new Map();
  for (const row of rowsOf(parts[1], '요구', '소유 모델')) {
    for (const id of ids(row['요구'], /\b(?:BIZ|INV|EX)-\d+\b/g)) owners.set(id, [...(owners.get(id) || []), ...(clean(row['소유 모델']).includes(EXTERNAL) ? [EXTERNAL] : []), ...names(row['소유 모델'])]);
  }
  const owned = (id) => (owners.get(id) || []).some((name) => name === EXTERNAL || !models.size || models.has(name));
  for (const id of business) if (!owned(id)) fail('BIZ_UNMAPPED', `${id} maps to no model or ${EXTERNAL} marker in section 1`, id);
  for (const id of rules) if (!owned(id)) fail('RULE_NO_OWNER', `${id} has no owning model in section 1`, id);

  // 2. Every INV and EX has an enforcing behaviour in 2.2, and a rule that spans Aggregates cites a sourced consistency decision.
  owner = stageOfSection(2);
  const decisions = new Map();
  for (const row of rowsOf(parts[2], 'CON')) {
    const [id] = ids(row['CON'], CON_ID);
    if (id) decisions.set(id, { kind: clean(field(row, /^일관성$/)), rules: ids(row['규칙'], RULE_ID), spanned: names(field(row, /^걸친 Aggregate$/)), source: clean(field(row, /출처/)) });
  }
  const enforcement = new Map();
  for (const row of rowsOf(parts[2], '요구', '강제 행위')) {
    for (const id of ids(row['요구'], RULE_ID)) enforcement.set(id, [...(enforcement.get(id) || []), { enforced: !noBehavior(row['강제 행위']), spanned: unique(names(row['Aggregate'])), cited: ids(row['일관성 범위'], CON_ID) }]);
  }
  const judged = new Set();
  for (const id of rules) {
    const rows = enforcement.get(id) || [];
    if (!rows.some((row) => row.enforced)) fail('RULE_NO_ENFORCEMENT', `${id} has no enforcing behaviour in section 2.2`, id);
    // A rule's decisions are the ones its 2.2 rows cite and the ones that list it; it spans what those rows and decisions name.
    const cited = unique([...rows.flatMap((row) => row.cited), ...[...decisions].filter(([, decision]) => decision.rules.includes(id)).map(([con]) => con)]);
    const known = cited.filter((con) => decisions.has(con));
    const spanned = unique([...rows.flatMap((row) => row.spanned), ...known.flatMap((con) => decisions.get(con).spanned)]);
    if (spanned.length < 2) continue;
    if (!known.length) fail('CROSS_AGGREGATE_NO_DECISION', `${id} spans ${spanned.join(', ')} ${cited.length ? `and cites ${cited.join(', ')}, which section 2.3 does not declare` : 'without a consistency decision (일관성 범위 must name a CON row of 2.3)'}`, id);
    for (const con of known.filter((item) => !judged.has(item))) {
      judged.add(con);
      const { kind, source } = decisions.get(con);
      if (!/^(즉시|최종)/.test(kind)) fail('DECISION_KIND_INVALID', `${con} has consistency "${kind}"; use 즉시 or 최종`, con);
      if (!DECISION_SOURCE.test(source)) fail('DECISION_NO_SOURCE', `${con} has no source: cite the user's answer (answers.json <question_id>), an INV/EX/AC/BIZ ID, 요청 원문, CAND-xx 채택 or 사용자 수정 지시; an agent proposal alone is not a source`, con);
    }
  }

  // 3. A transaction boundary changes at most one Aggregate: the Aggregates a segment names, longest name first.
  owner = stageOfSection(4);
  const aggregates = unique([
    ...rowsOf(parts[2], 'Aggregate', 'Root').map((row) => clean(row['Aggregate'])),
    ...rowsOf(parts[2], '요구', '강제 행위').flatMap((row) => names(row['Aggregate'])),
    ...[...decisions.values()].flatMap((decision) => decision.spanned),
  ].filter((name) => name && !isBlank(name))).sort((a, b) => b.length - a.length);
  for (const row of rowsOf(parts[4], 'AS', '트랜잭션 경계')) {
    for (const segment of clean(row['트랜잭션 경계']).split(/[;；]|(?=\bT\d+\s*:)/)) {
      let text = segment.replace(/[(（][^)）]*[)）]/g, ' ').replace(/^[\s,，]*(?:T\d+\s*:)?/, '').split('—')[0];
      if (/^\s*없음/.test(text)) continue;
      const touched = aggregates.filter((name) => { const hit = text.includes(name); if (hit) text = text.split(name).join(' '); return hit; });
      if (touched.length > 1) fail('MULTI_AGGREGATE_TRANSACTION', `${clean(row['AS'])} transaction "${segment.trim()}" changes ${touched.join(', ')}; one transaction changes exactly one Aggregate`, clean(row['AS']));
    }
  }

  // 4. Saga and Outbox are chosen only on integration rows tied to an eventual-consistency decision.
  owner = stageOfSection(5);
  for (const row of rowsOf(parts[5], 'INT')) {
    const saga = clean(field(row, /Saga|Outbox/i));
    if (isBlank(saga) || /^(해당 )?없음(\s|$|[—–-])/.test(saga)) continue;
    if (!ids(field(row, /일관성/), CON_ID).some((con) => /^최종/.test(decisions.get(con)?.kind || ''))) fail('SAGA_WITHOUT_EVENTUAL', `${clean(row['INT'])} chooses ${saga} but cites no eventual-consistency (최종) decision of section 2.3; Saga and Outbox are considered only for such rules`, clean(row['INT']));
  }

  // 5. Context-boundary records one sourced boundary decision per relationship exercised by this plan set.
  owner = TACTICAL_DESIGN_STAGES.at(-1);
  const boundaryRows = rowsOf(parts[6], '상류 BC', '하류 BC', '관계 패턴', '코드 의존', '경계 강제', '근거·출처');
  for (const row of boundaryRows) {
    const fields = ['상류 BC', '하류 BC', '관계 패턴', '코드 의존', '경계 강제', '데이터 소유·타입 경계', '근거·출처'];
    for (const name of fields) if (isBlank(row[name])) fail('BOUNDARY_DECISION_INCOMPLETE', `Context-boundary row ${clean(row['상류 BC'])} → ${clean(row['하류 BC'])} has no ${name}`, `${clean(row['상류 BC'])} → ${clean(row['하류 BC'])}`);
  }
  const hasBoundaryTable = parseTables(parts[6]).some((table) => ['상류 BC', '하류 BC', '관계 패턴', '코드 의존', '경계 강제', '데이터 소유·타입 경계', '근거·출처'].every((name) => table.header.includes(name)));
  if (!hasBoundaryTable) fail('BOUNDARY_TABLE_MISSING', 'Section 6 must include the context-boundary decision table, including when it records 해당 없음 and why');
  else if (!boundaryRows.length) fail('BOUNDARY_DECISION_MISSING', 'Section 6 must contain at least one sourced relationship decision or an explicit 해당 없음 row with its rationale');
  const boundaryPairs = new Set(boundaryRows.map((row) => `${clean(row['상류 BC'])} → ${clean(row['하류 BC'])}`));
  for (const row of rowsOf(parts[5], 'INT', '상류 BC', '하류 BC')) {
    const pair = `${clean(row['상류 BC'])} → ${clean(row['하류 BC'])}`;
    if (!boundaryPairs.has(pair)) fail('INTEGRATION_BOUNDARY_MISSING', `${clean(row['INT'])} (${pair}) has no matching context-boundary decision`, clean(row['INT']));
  }
  return result(errors);
}

// The earliest stage comes first: the stage to reopen is the first one a finding names.
const stageOrder = (stage) => TACTICAL_DESIGN_STAGES.indexOf(stage);
const result = (errors) => ({ ok: errors.length === 0, errors: [...errors].sort((a, b) => stageOrder(a.owner_stage) - stageOrder(b.owner_stage)) });

// A stakeholder-analysis that decided to skip the requirements flow lets every later stage of the flow record the skip and
// write nothing, so there is no tactical-design.md to check. The template's own `판정: 실행 | 생략` line is not a skip.
const SKIPPED_ANALYSIS = /^\s*(?:[-*]\s*)?판정\s*:\s*생략\s*$/m;
export const stakeholderAnalysisSkipped = (text) => SKIPPED_ANALYSIS.test(String(text));

async function planSetDocument(root, planSetId, name) {
  const path = specArtifactPath(planSetId, name);
  await assertWorkspaceTarget(root, path);
  try { return { path, text: await readFile(join(root, path), 'utf8') }; }
  catch (error) { if (error.code === 'ENOENT') return { path, text: null }; throw error; }
}

// The gate on the plan set's documents of a workspace: what the command and the runner both run.
export async function checkWorkspaceTacticalDesign({ root, planSetId }) {
  const analysis = await planSetDocument(root, planSetId, 'stakeholder-analysis.md');
  if (analysis.text !== null && stakeholderAnalysisSkipped(analysis.text)) return { ok: true, skipped: true, errors: [] };
  const requirements = await planSetDocument(root, planSetId, 'requirements.md');
  const tacticalDesign = await planSetDocument(root, planSetId, TACTICAL_DESIGN_DOCUMENT);
  const missing = [[requirements, WORKTREE_STAGE.REQUIREMENTS_FIX], [tacticalDesign, TACTICAL_DESIGN_STAGES[0]]].filter(([document]) => document.text === null);
  if (missing.length) return result(missing.map(([document, stage]) => ({ code: 'DOCUMENT_MISSING', message: `${document.path} does not exist; write it at this exact path (resolve it with harness-spec-path.mjs) before the stage returns completed`, owner_stage: stage })));
  return checkTacticalDesign({ requirements: requirements.text, tacticalDesign: tacticalDesign.text });
}

// The runner's verdict on a result that claims completion; null when the gate does not apply: any stage but the last of the
// flow, or a status other than completed. The stage identity and the plan set come from the stored input, never from the model.
export async function evaluateTacticalDesignGate({ root, input, envelope }) {
  const stage = input?.skill;
  const planSetId = input?.context?.plan_set_id;
  if (stage !== FINAL_TACTICAL_STAGE || envelope?.status !== 'completed' || !planSetId) return null;
  return { stage, ...(await checkWorkspaceTacticalDesign({ root, planSetId })) };
}

// What the caller does with a rejection. A finding of the returning stage's own section is repaired by that stage; a finding
// that names an earlier stage is a settled section the stage may not edit, so the stage blocks and the earlier stage reopens.
export function gateFailureInstruction(verdict) {
  const earlier = unique(verdict.errors.map((error) => error.owner_stage)).filter((stage) => stage !== verdict.stage);
  const head = `The runner ran the tactical design gate (harness-domain-model-check.mjs) once on the whole ${TACTICAL_DESIGN_DOCUMENT} for ${verdict.stage} and it failed. Nothing was committed or recorded, and the stage is still running.`;
  if (!earlier.length) return `${head} Return these errors to the same subagent so it repairs its own section and decision rows of ${TACTICAL_DESIGN_DOCUMENT} (never requirements.md or an earlier section only to make the gate pass) and rewrites its output file if its summary or artifacts change, then run finish again.`;
  return `${head} Errors whose owner_stage is ${earlier.join(', ')} are in sections of earlier stages, which are settled input and are not repaired by ${verdict.stage}. Return the errors to the same subagent so it returns blocked / DEPENDENCY_INCOMPLETE naming ${earlier[0]} as the earliest stage to reopen, with these errors as the evidence and without editing any earlier section, restores ${TACTICAL_DESIGN_DOCUMENT} to the content it had when the stage started, which is its committed content (the restart needs a clean tree) and rewrites its output file, then run finish again. The orchestrator reports the block and the user reopens ${earlier[0]} with --restart-requirements true or --user-revision true --feedback <instruction>.`;
}

export class TacticalGateError extends Error {
  constructor(verdict) {
    super(`Tactical design gate failed for ${verdict.stage}: ${verdict.errors.map((error) => `${error.code}${error.id ? ` (${error.id})` : ''} [${error.owner_stage}] ${error.message}`).join('; ')}`);
    this.name = 'TacticalGateError';
    this.verdict = verdict;
  }
}

// The last tactical stage is accepted as completed only when the whole tactical-design.md passes the gate.
export async function assertTacticalDesignGate(options) {
  const verdict = await evaluateTacticalDesignGate(options);
  if (verdict && !verdict.ok) throw new TacticalGateError(verdict);
  return verdict;
}
