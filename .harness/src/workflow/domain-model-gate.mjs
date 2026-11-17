// Deterministic gate of the tactical design flow (domain-model, aggregate-design, domain-service, application-service,
// integration-design). It checks the plan set's whole tactical-design.md against the fixed requirements.md, once: the runner
// runs it when the last stage of the flow, integration-design, reports completed/OK (`harness-native-stage.mjs finish` before
// anything is committed, and `recordExecutionState` for every other path that records the stage). No earlier stage is gated,
// so a stage never runs it. Every finding names the stage that owns the failing section (`owner_stage`), so a failure that
// comes from an earlier stage's section tells which stage to reopen.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { TACTICAL_DESIGN_DOCUMENT, TACTICAL_DESIGN_STAGES, WORKTREE_STAGE } from './worktree-stages.mjs';
import { specArtifactPath } from './worktrees.mjs';

// Section N of tactical-design.md is filled by the Nth stage of the flow; section 6 is shared by all of them.
export const FINAL_TACTICAL_STAGE = TACTICAL_DESIGN_STAGES.at(-1);
const stageOfSection = (number) => TACTICAL_DESIGN_STAGES[number - 1];
const MODEL_KINDS = ['Entity', 'Value Object', '외부 시스템'];
const ENTITY = 'Entity';
const VALUE_OBJECT = 'Value Object';
const EXTERNAL = '외부 시스템';
const DOMAIN_SERVICE_MARKER = 'Domain Service';
// A consistency decision rests on a user decision or on evidence the requirements already carry; an agent proposal alone is not a source.
const DECISION_SOURCE = /answers\.json|\b(?:INV|EX|AC|BIZ)-\d+\b|요청 원문|CAND-\d+ 채택|사용자 수정 지시/;

const unique = (items) => [...new Set(items)];
const clean = (value) => String(value ?? '').replace(/`/g, '').trim();
const isBlank = (value) => !clean(value) || clean(value) === '-';
const names = (value) => clean(value).split(/[,，]/).map((item) => item.trim()).filter((item) => item && item !== '-');
const behaviors = (value) => clean(value).replace(/\([^)]*\)/g, '').split(/[,，]/).map((item) => item.trim()).filter(Boolean);
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());

// Tables outside fenced code blocks, keyed by their header cells.
export function parseTables(text) {
  const lines = [];
  let fenced = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fenced = !fenced; lines.push(''); continue; }
    lines.push(fenced ? '' : line);
  }
  const tables = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) continue;
    const header = cells(lines[i]);
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
  const parts = {};
  const matches = [...String(text).matchAll(/^## (\d+)\./gm)];
  matches.forEach((match, index) => { parts[Number(match[1])] = text.slice(match.index, matches[index + 1]?.index ?? text.length); });
  return parts;
}

function tableOf(section, ...required) {
  return parseTables(section || '').find((table) => required.every((name) => table.header.includes(name)));
}

const notApplicable = (section) => /^\s*해당 없음\s*—\s*\S/m.test(section || '');

export function parseRequirements(text) {
  return {
    business: unique([...String(text).matchAll(/^#{3}\s+(BIZ-\d+)\b/gm)].map((match) => match[1])),
    rules: unique([...String(text).matchAll(/^\s*[-*]\s+(INV-\d+|EX-\d+)\b/gm)].map((match) => match[1])),
  };
}

// The Value Object that a `강제 행위` of the form `Value Object: <모델>` or `Value Object: <모델>.<행위>()` names.
function valueObjectTarget(action, models) {
  const text = clean(action.slice(VALUE_OBJECT.length).replace(/^\s*:\s*/, '')).replace(/\([^)]*\)/g, '').trim();
  return models.has(text) || !text.includes('.') ? text : text.slice(0, text.lastIndexOf('.')).trim();
}

export function checkTacticalDesign({ requirements, tacticalDesign }) {
  const errors = [];
  let owner = stageOfSection(1);
  const fail = (code, message, id) => errors.push({ code, message, ...(id ? { id } : {}), owner_stage: owner });
  const { business, rules } = parseRequirements(requirements);
  const parts = sections(tacticalDesign);
  TACTICAL_DESIGN_STAGES.forEach((stage, index) => { if (!parts[index + 1]) errors.push({ code: 'SECTION_MISSING', message: `${TACTICAL_DESIGN_DOCUMENT} has no \`## ${index + 1}.\` section; ${stage} must have filled it`, owner_stage: stage }); });
  if (errors.length) return result(errors);

  // 1. Models and the requirement mapping.
  const modelTable = tableOf(parts[1], '모델', '종류');
  const models = new Map();
  const contextOf = new Map();
  for (const row of modelTable?.rows || []) {
    const name = clean(row['모델']);
    if (models.has(name)) fail('MODEL_DUPLICATE', `Model ${name} is declared twice`, name);
    if (!MODEL_KINDS.includes(clean(row['종류']))) fail('MODEL_KIND_INVALID', `Model ${name} has kind "${clean(row['종류'])}"; use ${MODEL_KINDS.join(', ')}`, name);
    models.set(name, clean(row['종류']));
    contextOf.set(name, clean(row['BC']));
  }
  if (!models.size) fail('MODELS_MISSING', 'Section 1 declares no model (Entity, Value Object or 외부 시스템)');
  const mapping = new Map();
  for (const row of tableOf(parts[1], '요구', '소유 모델')?.rows || []) {
    const id = clean(row['요구']);
    if (!/^(BIZ|INV|EX)-\d+$/.test(id)) continue;
    if (!business.includes(id) && !rules.includes(id)) fail('UNKNOWN_REQUIREMENT', `${id} is not in requirements.md`, id);
    const owners = names(row['소유 모델']);
    for (const owned of owners) if (!models.has(owned)) fail('UNKNOWN_MODEL', `${id} maps to ${owned}, which section 1 does not declare`, id);
    mapping.set(id, owners.filter((item) => models.has(item)));
  }
  for (const id of business) if (!mapping.get(id)?.length) fail('BIZ_UNMAPPED', `${id} maps to no model or ${EXTERNAL} marker`, id);
  for (const id of rules) if (!mapping.get(id)?.length) fail('RULE_NO_OWNER', `${id} has no owning model`, id);

  // 2. Aggregates, the behaviour that enforces each rule, and the consistency decisions.
  owner = stageOfSection(2);
  const aggregates = new Map();
  const aggregateTable = tableOf(parts[2], 'Aggregate', 'Root');
  for (const row of aggregateTable?.rows || []) {
    const name = clean(row['Aggregate']);
    const root = clean(row['Root']);
    const members = names(row['구성원']);
    if (aggregates.has(name)) fail('AGGREGATE_DUPLICATE', `Aggregate ${name} is declared twice`, name);
    if (models.get(root) !== ENTITY) fail('ROOT_NOT_ENTITY', `Root ${root} of ${name} is not an Entity declared in section 1`, name);
    for (const member of members) if (!models.has(member)) fail('UNKNOWN_MODEL', `${name} lists member ${member}, which section 1 does not declare`, name);
    aggregates.set(name, { root, members, bc: clean(row['BC']), behaviors: behaviors(row['주요 행위']) });
  }
  const aggregatesOf = (model) => [...aggregates].filter(([, value]) => value.root === model || value.members.includes(model)).map(([name]) => name);
  // A bounded context with no state lifecycle has no Aggregate, and the document says so: a row of the 2.1 table of
  // contexts without an Aggregate, or `해당 없음 — <reason>` for a section that declares none at all.
  const withoutAggregate = new Set((tableOf(parts[2], 'BC', 'Aggregate 없음 사유')?.rows || []).filter((row) => !isBlank(row['BC']) && !isBlank(row['Aggregate 없음 사유'])).map((row) => clean(row['BC'])));
  const sectionExplained = !aggregates.size && notApplicable(parts[2]);
  if (!aggregates.size && !sectionExplained && !withoutAggregate.size) fail('AGGREGATES_MISSING', 'Section 2 declares no Aggregate and gives no reason: add the Aggregates, a row (BC, Aggregate 없음 사유) for each context without one, or `해당 없음 — <reason>`');
  else {
    const contexts = unique([...models].filter(([, kind]) => kind !== EXTERNAL).map(([name]) => contextOf.get(name)).filter(Boolean));
    for (const context of contexts) {
      const placed = [...models].some(([name, kind]) => kind !== EXTERNAL && contextOf.get(name) === context && aggregatesOf(name).length);
      if (!placed && !withoutAggregate.has(context) && !sectionExplained) fail('AGGREGATE_ABSENCE_UNEXPLAINED', `${context} has no Aggregate and section 2.1 gives no reason; add a row (BC, Aggregate 없음 사유) saying why it has no state lifecycle, or declare its Aggregate`, context);
    }
  }
  for (const [model, kind] of models) {
    if (kind !== ENTITY) continue;
    const where = aggregatesOf(model);
    if (!where.length) fail('ENTITY_UNPLACED', `Entity ${model} belongs to no Aggregate`, model);
    if (where.length > 1) fail('ENTITY_IN_SEVERAL_AGGREGATES', `Entity ${model} belongs to ${where.join(', ')}; an Entity lives in exactly one Aggregate`, model);
  }
  const decisions = new Map();
  const decisionRows = new Map();
  for (const row of tableOf(parts[2], 'CON', '일관성', '근거·출처')?.rows || []) {
    const id = clean(row['CON']);
    const spanned = names(row['걸친 Aggregate']);
    const kind = clean(row['일관성']);
    if (decisions.has(id)) fail('DECISION_DUPLICATE', `${id} is declared twice`, id);
    decisions.set(id, kind);
    decisionRows.set(id, { rules: names(row['규칙']), spanned: unique(spanned) });
    for (const name of spanned) if (!aggregates.has(name)) fail('UNKNOWN_AGGREGATE', `${id} names ${name}, which section 2 does not declare`, id);
    if (!['즉시', '최종'].includes(kind)) fail('DECISION_KIND_INVALID', `${id} has consistency "${kind}"; use 즉시 or 최종`, id);
    if (!DECISION_SOURCE.test(clean(row['근거·출처']))) fail('DECISION_NO_SOURCE', `${id} has no source: cite the user's answer (answers.json <question_id>), an INV/EX/AC/BIZ ID, 요청 원문, CAND-xx 채택 or 사용자 수정 지시; an agent proposal alone is not a source`, id);
    if (kind === '최종' && unique(spanned).length < 2) fail('EVENTUAL_NOT_SEPARATE', `${id} is eventual consistency but spans fewer than two Aggregates`, id);
    if (kind === '즉시' && (unique(spanned).length !== 1 || !clean(row['결정']).includes('병합'))) fail('IMMEDIATE_NOT_MERGED', `${id} needs immediate consistency, so the Aggregates must be merged into one (결정 names 병합, 걸친 Aggregate lists the merged Aggregate only)`, id);
  }
  // The behaviour that enforces a rule is an Aggregate method, a Value Object's own rule, a Domain Service, or an external system.
  const enforcement = new Map();
  const needsDomainService = new Set();
  for (const row of tableOf(parts[2], '요구', 'Aggregate', '강제 행위')?.rows || []) {
    const id = clean(row['요구']);
    if (!/^(INV|EX)-\d+$/.test(id)) continue;
    if (!rules.includes(id)) { fail('UNKNOWN_REQUIREMENT', `${id} is not in requirements.md`, id); continue; }
    const spanned = unique(names(row['Aggregate']));
    const action = clean(row['강제 행위']);
    const scope = clean(row['일관성 범위']);
    for (const name of spanned) if (!aggregates.has(name)) fail('UNKNOWN_AGGREGATE', `${id} names ${name}, which section 2 does not declare`, id);
    const owners = mapping.get(id) || [];
    if (action === DOMAIN_SERVICE_MARKER) needsDomainService.add(id);
    else if (action.startsWith(EXTERNAL)) {
      const target = clean(action.slice(EXTERNAL.length).replace(/^\s*:\s*/, ''));
      if (!owners.includes(target) || models.get(target) !== EXTERNAL) fail('EXTERNAL_ENFORCEMENT_INVALID', `${id} is delegated to "${target}", which is not an ${EXTERNAL} that owns it in section 1`, id);
    } else if (action.startsWith(VALUE_OBJECT)) {
      const target = valueObjectTarget(action, models);
      if (!owners.includes(target) || models.get(target) !== VALUE_OBJECT) fail('VALUE_OBJECT_ENFORCEMENT_INVALID', `${id} is enforced by "${action}", which is not a ${VALUE_OBJECT} that owns it in section 1`, id);
    } else if (!behaviors(action).length || !behaviors(action).every((behavior) => spanned.some((name) => aggregates.get(name)?.behaviors.includes(behavior)))) fail('RULE_NO_ENFORCEMENT', `${id} is enforced by "${action}", which is no listed behaviour of ${spanned.join(', ') || 'any Aggregate'}`, id);
    // The row must name every Aggregate that holds an owning Entity, so a rule that really spans Aggregates cannot hide behind one.
    const entityPlaced = unique(owners.filter((item) => models.get(item) === ENTITY).flatMap(aggregatesOf));
    const placed = unique(owners.flatMap(aggregatesOf));
    if (entityPlaced.some((name) => !spanned.includes(name)) || (placed.length && !placed.some((name) => spanned.includes(name)))) fail('RULE_AGGREGATE_MISMATCH', `${id} is owned by ${owners.join(', ')} (in ${placed.join(', ')}) but section 2.2 assigns it to ${spanned.join(', ') || 'no Aggregate'}; list every Aggregate that holds an owning Entity`, id);
    if (spanned.length > 1 && !(/^CON-\d+$/.test(scope) && decisions.has(scope))) fail('CROSS_AGGREGATE_NO_DECISION', `${id} spans ${spanned.join(', ')} without a consistency decision (일관성 범위 must name a CON row of 2.3)`, id);
    if (/^CON-\d+$/.test(scope) && !decisions.has(scope)) fail('UNKNOWN_DECISION', `${id} cites ${scope}, which 2.3 does not declare`, id);
    const decided = decisionRows.get(scope);
    if (decided && !decided.rules.includes(id)) fail('DECISION_RULE_MISMATCH', `${id} cites ${scope}, which decides ${decided.rules.join(', ') || 'no rule'}`, id);
    if (decided && decided.spanned.length && [...spanned].sort().join() !== [...decided.spanned].sort().join()) fail('DECISION_AGGREGATE_MISMATCH', `${id} spans ${spanned.join(', ')} but ${scope} decides ${decided.spanned.join(', ')}`, id);
    enforcement.set(id, action);
  }
  for (const id of rules) if (!enforcement.has(id)) fail('RULE_NO_ENFORCEMENT', `${id} has no enforcing behaviour in section 2.2`, id);

  // 3. Domain services own only what 2.2 handed over, and every handed-over rule gets one.
  owner = stageOfSection(3);
  const covered = new Set();
  const serviceIds = new Set();
  for (const row of tableOf(parts[3], 'DS', '강제 규칙', '행위')?.rows || []) {
    const id = clean(row['DS']);
    if (serviceIds.has(id)) fail('SERVICE_DUPLICATE', `${id} is declared twice`, id);
    serviceIds.add(id);
    if (isBlank(row['행위'])) fail('SERVICE_NO_BEHAVIOR', `${id} names no behaviour`, id);
    const owned = names(row['강제 규칙']);
    if (!owned.length) fail('SERVICE_NO_RULE', `${id} enforces no rule; a Domain Service exists only for a rule no Entity or Value Object owns`, id);
    for (const rule of owned) {
      if (!rules.includes(rule)) fail('UNKNOWN_REQUIREMENT', `${id} enforces ${rule}, which is not in requirements.md`, id);
      else if (!needsDomainService.has(rule)) fail('DOMAIN_SERVICE_REDUNDANT', `${id} enforces ${rule}, which section 2.2 already assigns to an Aggregate behaviour, a ${VALUE_OBJECT} or an ${EXTERNAL}`, id);
      covered.add(rule);
    }
  }
  if (!serviceIds.size && !notApplicable(parts[3])) fail('SERVICES_MISSING', 'Section 3 declares no Domain Service and does not say `해당 없음 — <reason>`');
  for (const id of needsDomainService) if (!covered.has(id)) fail('DOMAIN_SERVICE_MISSING', `${id} is handed to a Domain Service in 2.2 but section 3 has none for it`, id);

  // 4. Application services call, they do not decide: each transaction changes one Aggregate.
  owner = stageOfSection(4);
  const covers = new Set();
  const services = tableOf(parts[4], 'AS', '업무', '트랜잭션 경계');
  for (const row of services?.rows || []) {
    const id = clean(row['AS']);
    for (const biz of clean(row['업무']).match(/BIZ-\d+/g) || []) covers.add(biz);
    const boundary = clean(row['트랜잭션 경계']);
    if (/^없음\s*—\s*\S/.test(boundary)) continue;
    if (!boundary) { fail('TRANSACTION_MISSING', `${id} has no transaction boundary; write \`없음 — <reason>\` for a use case that changes no Aggregate`, id); continue; }
    for (const segment of boundary.split(';').map((item) => item.trim()).filter(Boolean)) {
      const consistency = segment.match(/CON-\d+/g) || [];
      const touched = names(segment.replace(/^T\d+\s*:\s*/, '').replace(/\([^)]*\)/g, ''));
      if (touched.length !== 1 || !aggregates.has(touched[0])) fail('MULTI_AGGREGATE_TRANSACTION', `${id} transaction "${segment}" must change exactly one declared Aggregate`, id);
      for (const con of consistency) if (decisions.get(con) !== '최종') fail('TRANSACTION_CONSISTENCY_INVALID', `${id} cites ${con}, which is not an eventual-consistency decision of 2.3`, id);
    }
  }
  for (const id of business) {
    const owners = mapping.get(id) || [];
    if (owners.length && owners.every((item) => models.get(item) === EXTERNAL)) continue;
    if (!covers.has(id)) fail('BIZ_NO_APPLICATION_SERVICE', `${id} is coordinated by no Application Service in section 4`, id);
  }

  // 5. Integration: the Saga/Outbox choice exists only for rules recorded as eventual consistency.
  owner = stageOfSection(5);
  const integrations = tableOf(parts[5], 'INT', '통신 방식', '일관성 결정', 'Saga·Outbox');
  const integrated = new Set();
  if (!integrations?.rows.length && !notApplicable(parts[5])) fail('INTEGRATION_MISSING', 'Section 5 declares no integration and does not say `해당 없음 — <reason>`');
  for (const row of integrations?.rows || []) {
    const id = clean(row['INT']);
    const cited = clean(row['일관성 결정']).match(/CON-\d+/g) || [];
    for (const field of ['상류 BC', '하류 BC', '통신 방식']) if (isBlank(row[field])) fail('INTEGRATION_INCOMPLETE', `${id} has no ${field}`, id);
    for (const con of cited) {
      integrated.add(con);
      if (!decisions.has(con)) fail('UNKNOWN_DECISION', `${id} cites ${con}, which 2.3 does not declare`, id);
    }
    const saga = clean(row['Saga·Outbox']);
    const eventual = cited.some((con) => decisions.get(con) === '최종');
    if (/^없음(\s*—\s*\S.*)?$/.test(saga) || isBlank(saga)) {
      if (eventual && isBlank(saga)) fail('SAGA_OUTBOX_UNCONSIDERED', `${id} carries an eventual-consistency decision, so state the Saga/Outbox choice (or \`없음 — <reason>\`)`, id);
    } else if (!eventual) fail('SAGA_WITHOUT_EVENTUAL', `${id} chooses ${saga} but cites no eventual-consistency decision; Saga and Outbox are considered only for such rules`, id);
  }
  for (const [con, kind] of decisions) {
    if (kind !== '최종') continue;
    const row = tableOf(parts[2], 'CON', '일관성')?.rows.find((item) => clean(item['CON']) === con);
    const contexts = unique(names(row?.['걸친 Aggregate']).map((name) => aggregates.get(name)?.bc).filter(Boolean));
    if (contexts.length > 1 && !integrated.has(con)) fail('CROSS_CONTEXT_NOT_INTEGRATED', `${con} crosses ${contexts.join(', ')} but no integration row of section 5 cites it`, con);
  }

  decisionHistory(parts[6], errors);
  return result(errors);
}

// Every stage appends its decisions with their sources; a stage that decided nothing says why in one row. A row belongs to
// the stage it names, so a missing or unsourced decision points at the stage that must record it.
function decisionHistory(section, errors) {
  const rows = tableOf(section, 'DEC', 'stage', '출처')?.rows || [];
  for (const stage of TACTICAL_DESIGN_STAGES) {
    if (!rows.some((row) => clean(row['stage']) === stage)) errors.push({ code: 'NO_DECISION_RECORD', message: `Section 6 has no decision row for ${stage}; record at least one decision with its source`, owner_stage: stage });
  }
  for (const row of rows) {
    if (!isBlank(row['출처'])) continue;
    const stage = clean(row['stage']);
    errors.push({ code: 'DECISION_RECORD_NO_SOURCE', message: `${clean(row['DEC'])} has no source`, id: clean(row['DEC']), owner_stage: TACTICAL_DESIGN_STAGES.includes(stage) ? stage : FINAL_TACTICAL_STAGE });
  }
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
