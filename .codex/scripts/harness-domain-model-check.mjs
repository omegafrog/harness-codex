#!/usr/bin/env node
// Deterministic gate of the tactical design stages (domain-model, aggregate-design, domain-service, application-service,
// integration-design). Each stage runs it before it returns completed. It checks the plan set's domain-model.md
// cumulatively, for the sections filled up to the stage that is returning, against the fixed requirements.md.
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TACTICAL_STAGE_LEVEL = Object.freeze({ 'domain-model': 1, 'aggregate-design': 2, 'domain-service': 3, 'application-service': 4, 'integration-design': 5 });
const MODEL_KINDS = ['Entity', 'Value Object', '외부 시스템'];
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

// domain-model.md by its numbered top-level sections; a section is "filled" once its heading is present.
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

export function checkDomainModel({ requirements, domainModel, stage }) {
  const level = TACTICAL_STAGE_LEVEL[stage];
  if (!level) throw new Error(`Unknown tactical design stage: ${stage}`);
  const errors = [];
  const fail = (code, message, id) => errors.push({ code, message, ...(id ? { id } : {}) });
  const { business, rules } = parseRequirements(requirements);
  const parts = sections(domainModel);
  for (let number = 1; number <= level; number += 1) if (!parts[number]) fail('SECTION_MISSING', `domain-model.md has no \`## ${number}.\` section; ${Object.keys(TACTICAL_STAGE_LEVEL)[number - 1]} must have filled it before this check`);
  if (errors.length) return result(stage, level, errors);

  // 1. Models and the requirement mapping.
  const modelTable = tableOf(parts[1], '모델', '종류');
  const models = new Map();
  for (const row of modelTable?.rows || []) {
    const name = clean(row['모델']);
    if (models.has(name)) fail('MODEL_DUPLICATE', `Model ${name} is declared twice`, name);
    if (!MODEL_KINDS.includes(clean(row['종류']))) fail('MODEL_KIND_INVALID', `Model ${name} has kind "${clean(row['종류'])}"; use ${MODEL_KINDS.join(', ')}`, name);
    models.set(name, clean(row['종류']));
  }
  if (!models.size) fail('MODELS_MISSING', 'Section 1 declares no model (Entity, Value Object or 외부 시스템)');
  const mapping = new Map();
  for (const row of tableOf(parts[1], '요구', '소유 모델')?.rows || []) {
    const id = clean(row['요구']);
    if (!/^(BIZ|INV|EX)-\d+$/.test(id)) continue;
    if (!business.includes(id) && !rules.includes(id)) fail('UNKNOWN_REQUIREMENT', `${id} is not in requirements.md`, id);
    const owners = names(row['소유 모델']);
    for (const owner of owners) if (!models.has(owner)) fail('UNKNOWN_MODEL', `${id} maps to ${owner}, which section 1 does not declare`, id);
    mapping.set(id, owners.filter((owner) => models.has(owner)));
  }
  for (const id of business) if (!mapping.get(id)?.length) fail('BIZ_UNMAPPED', `${id} maps to no model or ${EXTERNAL} marker`, id);
  for (const id of rules) if (!mapping.get(id)?.length) fail('RULE_NO_OWNER', `${id} has no owning model`, id);
  decisionHistory(parts[6], stage, fail);
  if (level === 1) return result(stage, level, errors);

  // 2. Aggregates, the behaviour that enforces each rule, and the consistency decisions.
  const aggregates = new Map();
  const aggregateTable = tableOf(parts[2], 'Aggregate', 'Root');
  for (const row of aggregateTable?.rows || []) {
    const name = clean(row['Aggregate']);
    const root = clean(row['Root']);
    const members = names(row['구성원']);
    if (aggregates.has(name)) fail('AGGREGATE_DUPLICATE', `Aggregate ${name} is declared twice`, name);
    if (models.get(root) !== 'Entity') fail('ROOT_NOT_ENTITY', `Root ${root} of ${name} is not an Entity declared in section 1`, name);
    for (const member of members) if (!models.has(member)) fail('UNKNOWN_MODEL', `${name} lists member ${member}, which section 1 does not declare`, name);
    aggregates.set(name, { root, members, bc: clean(row['BC']), behaviors: behaviors(row['주요 행위']) });
  }
  if (!aggregates.size && !notApplicable(parts[2])) fail('AGGREGATES_MISSING', 'Section 2 declares no Aggregate and does not say `해당 없음 — <reason>`');
  const aggregatesOf = (model) => [...aggregates].filter(([, value]) => value.root === model || value.members.includes(model)).map(([name]) => name);
  for (const [model, kind] of models) {
    if (kind !== 'Entity') continue;
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
    }
    else if (!behaviors(action).length || !behaviors(action).every((behavior) => spanned.some((name) => aggregates.get(name)?.behaviors.includes(behavior)))) fail('RULE_NO_ENFORCEMENT', `${id} is enforced by "${action}", which is no listed behaviour of ${spanned.join(', ') || 'any Aggregate'}`, id);
    // The row must name every Aggregate that holds an owning Entity, so a rule that really spans Aggregates cannot hide behind one.
    const entityPlaced = unique(owners.filter((owner) => models.get(owner) === 'Entity').flatMap(aggregatesOf));
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
  if (level === 2) return result(stage, level, errors);

  // 3. Domain services own only what 2.2 handed over, and every handed-over rule gets one.
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
      else if (!needsDomainService.has(rule)) fail('DOMAIN_SERVICE_REDUNDANT', `${id} enforces ${rule}, which section 2.2 already assigns to an Aggregate behaviour`, id);
      covered.add(rule);
    }
  }
  if (!serviceIds.size && !notApplicable(parts[3])) fail('SERVICES_MISSING', 'Section 3 declares no Domain Service and does not say `해당 없음 — <reason>`');
  for (const id of needsDomainService) if (!covered.has(id)) fail('DOMAIN_SERVICE_MISSING', `${id} is handed to a Domain Service in 2.2 but section 3 has none for it`, id);
  if (level === 3) return result(stage, level, errors);

  // 4. Application services call, they do not decide: each transaction changes one Aggregate.
  const covers = new Set();
  const services = tableOf(parts[4], 'AS', '업무', '트랜잭션 경계');
  for (const row of services?.rows || []) {
    const id = clean(row['AS']);
    for (const biz of clean(row['업무']).match(/BIZ-\d+/g) || []) covers.add(biz);
    const boundary = clean(row['트랜잭션 경계']);
    if (/^없음\s*—\s*\S/.test(boundary)) continue;
    if (!boundary) { fail('TRANSACTION_MISSING', `${id} has no transaction boundary; write \`없음 — <reason>\` for a read-only use case`, id); continue; }
    for (const segment of boundary.split(';').map((item) => item.trim()).filter(Boolean)) {
      const consistency = segment.match(/CON-\d+/g) || [];
      const touched = names(segment.replace(/^T\d+\s*:\s*/, '').replace(/\([^)]*\)/g, ''));
      if (touched.length !== 1 || !aggregates.has(touched[0])) fail('MULTI_AGGREGATE_TRANSACTION', `${id} transaction "${segment}" must change exactly one declared Aggregate`, id);
      for (const con of consistency) if (decisions.get(con) !== '최종') fail('TRANSACTION_CONSISTENCY_INVALID', `${id} cites ${con}, which is not an eventual-consistency decision of 2.3`, id);
    }
  }
  for (const id of business) {
    const owners = mapping.get(id) || [];
    if (owners.length && owners.every((owner) => models.get(owner) === EXTERNAL)) continue;
    if (!covers.has(id)) fail('BIZ_NO_APPLICATION_SERVICE', `${id} is coordinated by no Application Service in section 4`, id);
  }
  if (level === 4) return result(stage, level, errors);

  // 5. Integration: the Saga/Outbox choice exists only for rules recorded as eventual consistency.
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
  return result(stage, level, errors);
}

// Every stage appends its decisions with their sources; a stage that decided nothing says why in one row.
function decisionHistory(section, stage, fail) {
  const rows = tableOf(section, 'DEC', 'stage', '출처')?.rows || [];
  if (!rows.some((row) => clean(row['stage']) === stage)) fail('NO_DECISION_RECORD', `Section 6 has no decision row for ${stage}; record at least one decision with its source`);
  for (const row of rows) if (isBlank(row['출처'])) fail('DECISION_RECORD_NO_SOURCE', `${clean(row['DEC'])} has no source`, clean(row['DEC']));
}

const result = (stage, level, errors) => ({ ok: errors.length === 0, stage, level, errors });

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined) throw new Error('Usage: harness-domain-model-check.mjs --workspace-root <absolute-workspace-root> --stage <stage> [--requirements <path> --domain-model <path>]');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!TACTICAL_STAGE_LEVEL[options.stage]) throw new Error(`--stage must be one of ${Object.keys(TACTICAL_STAGE_LEVEL).join(', ')}`);
  let { requirements, 'domain-model': domainModel } = options;
  if (!requirements || !domainModel) {
    const root = options['workspace-root'];
    if (!isAbsolute(root || '')) throw new Error('--workspace-root must be an absolute path');
    const { parseWorktreeRecord, specArtifactPath } = await import('../../.harness/src/workflow/worktrees.mjs');
    const record = parseWorktreeRecord(await readFile(join(root, '.io/worktree.json'), 'utf8'));
    if (await realpath(root) !== await realpath(record.workspace)) throw new Error('Workspace does not match worktree.json');
    requirements = join(root, specArtifactPath(record.plan_set_id, 'requirements.md'));
    domainModel = join(root, specArtifactPath(record.plan_set_id, 'domain-model.md'));
  }
  const verdict = checkDomainModel({ requirements: await readFile(requirements, 'utf8'), domainModel: await readFile(domainModel, 'utf8'), stage: options.stage });
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  if (!verdict.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
