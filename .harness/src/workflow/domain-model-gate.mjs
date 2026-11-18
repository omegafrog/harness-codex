// Deterministic gate of the tactical design flow (domain-model, aggregate-design, domain-service, application-service,
// integration-design). It checks the plan set's whole tactical-design.md against the fixed requirements.md, once: the runner
// runs it when the last stage of the flow, context-boundary, reports completed/OK (`harness-native-stage.mjs finish` before
// anything is committed, and `recordExecutionState` for every other path that records the stage). No earlier stage is gated,
// so a stage never runs it. Every finding names the stage that owns the failing section (`owner_stage`), so a failure that
// comes from an earlier stage's section tells which stage to reopen.
//
// Current documents group components by approved Context. The numbered format remains readable for existing plan sets.
// The gate checks structural ownership and references. Business and DDD judgement belongs to the stage GUIDEs and reviews.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDomainSlug } from '../domain/schema.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { TACTICAL_DESIGN_DOCUMENT, TACTICAL_DESIGN_STAGES, WORKTREE_STAGE } from './worktree-stages.mjs';
import { specArtifactPath } from './worktrees.mjs';

// Section N of tactical-design.md is filled by the Nth stage of the flow; section 7 is decision history.
export const FINAL_TACTICAL_STAGE = TACTICAL_DESIGN_STAGES.at(-1);
const stageOfSection = (number) => TACTICAL_DESIGN_STAGES[number - 1];
export const EXTERNAL = '외부 시스템';
const RULE_ID = /\b(?:INV|EX)-\d+\b/g;
const CON_ID = /\bCON-\d+\b/g;
// A consistency decision rests on a user decision or on evidence the requirements already carry; an agent proposal alone is not a source.
const DECISION_SOURCE = /answers\.json|\b(?:INV|EX|AC|BIZ)-\d+\b|요청 원문|CAND-\d+ 채택|사용자 수정 지시/;

export const unique = (items) => [...new Set(items)];
export const clean = (value) => String(value ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
export const isBlank = (value) => !clean(value) || /^[-–—]$/.test(clean(value));
export const names = (value) => clean(value).replace(/[(（][^)）]*[)）]/g, '').split(/[,，、]|\s및\s/).map((item) => item.trim()).filter((item) => item && !isBlank(item));
export const ids = (value, pattern) => unique(clean(value).match(pattern) || []);
const cells = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|\s*$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'));
// A column found by a pattern on its header, for the optional columns whose exact wording may vary.
const field = (row, pattern) => { const key = Object.keys(row).find((name) => pattern.test(name)); return key === undefined ? '' : row[key]; };

// The text with fenced code blocks blanked, so an example inside one is never read as the document.
export const outsideFences = (text) => {
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
export function sections(text) {
  const body = outsideFences(text).join('\n');
  const parts = {};
  const matches = [...body.matchAll(/^##[ \t]+(\d+)(?!\d)/gm)];
  matches.forEach((match, index) => { parts[Number(match[1])] = body.slice(match.index, matches[index + 1]?.index ?? body.length); });
  return parts;
}

// The rows of every table of the section that has all the key columns.
export const rowsOf = (section, ...required) => parseTables(section || '').filter((table) => required.every((name) => table.header.includes(name))).flatMap((table) => table.rows);

export const CONTEXT_DESIGN_MARKER = '<!-- tactical-design: context-components-v1 -->';
const BIZ_ID = /\bBIZ-\d+\b/g;
const AS_ID = /\bAS-\d+\b/g;

export function readContextDesign(text) {
  const body = outsideFences(text).join('\n');
  if (!body.split('\n').some((line) => line.trim() === CONTEXT_DESIGN_MARKER)) return null;
  const headings = [...body.matchAll(/^##[ \t]+([^\n]+)$/gm)];
  return headings.flatMap((heading, index) => {
    const id = /^BC[ \t]+(\S+)$/.exec(heading[1].trim())?.[1];
    if (!isDomainSlug(id)) return [];
    const section = body.slice(heading.index, headings[index + 1]?.index ?? body.length);
    return [{
      id,
      section,
      models: rowsOf(section, '모델', '종류', '식별자', '필드·구성 값', '메서드', '업무'),
      aggregates: rowsOf(section, 'Aggregate', 'Root', '구성원', '다른 Aggregate 참조'),
      rules: rowsOf(section, '소유 모델', '규칙', '근거', '담당 메서드'),
      application: rowsOf(section, 'AS', '메서드', '업무', '호출 순서', '트랜잭션 경계', '사용 인터페이스'),
      interfaces: rowsOf(section, '인터페이스', '시그니처', '소유 위치', '사용 메서드', '실패 계약'),
    }];
  });
}

export function parseRequirements(text) {
  return {
    business: unique([...String(text).matchAll(/^#{3}\s+(BIZ-\d+)\b/gm)].map((match) => match[1])),
    rules: unique([...String(text).matchAll(/^\s*[-*]\s+(INV-\d+|EX-\d+)\b/gm)].map((match) => match[1])),
  };
}

// A behaviour cell that names nothing: blank, `-` or `없음 — <reason>`. Any other form (Aggregate or Entity method, Value Object
// rule, Domain Service, 외부 시스템) enforces the rule.
const noBehavior = (value) => isBlank(value) || /^(해당 )?없음(\s*[—–-].*)?$/.test(clean(value));

const linesOf = (value) => String(value ?? '').split(/<br\s*\/?>/i).map(clean);
const methodName = (value) => clean(value).split('(')[0].split('.').at(-1).trim();
const methodSignature = /\S+\([^)]*\)\s*(?:→|->)\s*\S/;
const kindOf = (row) => clean(row['종류']);
const externalModel = (row) => kindOf(row) === EXTERNAL;
const domainModel = (row) => /^(?:Entity|VO|Value Object|Domain Service)$/.test(kindOf(row));
const needsClassDiagram = (context) => context.models.some((row) => /^(?:Entity|VO|Value Object)$/.test(kindOf(row)));
const classDiagramPath = (id, extension) => `diagrams/${id}.class.${extension}`;

function checkContextDesign(requirements, contexts) {
  const errors = [];
  const fail = (owner, code, message, id) => errors.push({ code, message, ...(id ? { id } : {}), owner_stage: owner });
  const modelFailure = (...args) => fail(WORKTREE_STAGE.DOMAIN_MODEL, ...args);
  const aggregateFailure = (...args) => fail(WORKTREE_STAGE.AGGREGATE_DESIGN, ...args);
  const serviceFailure = (...args) => fail(WORKTREE_STAGE.APPLICATION_SERVICE, ...args);
  const { business, rules } = parseRequirements(requirements);
  const approvedContexts = new Map(rowsOf(requirements, 'BC', '포함 SD·BIZ', '소유 규칙·데이터').flatMap((row) => {
    const slug = clean(row.BC).split(/[\s(]/)[0];
    return isDomainSlug(slug) ? [[slug, ids(row['포함 SD·BIZ'], BIZ_ID)]] : [];
  }));
  const covered = new Set();
  const appIds = new Set();
  const ruleOwners = new Set();
  const contextIds = new Set();
  if (!contexts.length) modelFailure('CONTEXT_MISSING', 'Write at least one ## BC <context-id> section');

  for (const context of contexts) {
    const { id, section, models, aggregates, rules: mappings, application, interfaces } = context;
    if (contextIds.has(id)) modelFailure('CONTEXT_DUPLICATE', `${id} is declared more than once`, id);
    if (approvedContexts.size && !approvedContexts.has(id)) modelFailure('CONTEXT_UNAPPROVED', `${id} is absent from the approved requirements`, id);
    contextIds.add(id);
    const localModels = new Map();
    const localAggregates = new Set(aggregates.map((row) => clean(row.Aggregate)));
    if (localAggregates.size !== aggregates.length) aggregateFailure('AGGREGATE_DUPLICATE', `${id} declares the same Aggregate more than once`, id);
    const entityMembership = new Map();
    const ports = new Map();
    const usedPorts = new Map();

    if (!models.length) modelFailure('MODEL_MISSING', `${id} has no domain model or external-system owner`, id);
    for (const row of models) {
      const name = clean(row['모델']);
      if (!name || localModels.has(name) || !(domainModel(row) || externalModel(row))) modelFailure('MODEL_INVALID', `${id} must name each model once with a valid model type`, name || id);
      localModels.set(name, row);
      const entity = kindOf(row) === 'Entity';
      const fields = linesOf(row['필드·구성 값']);
      const identity = clean(row['식별자']);
      if ((entity && (!identity || !fields.some((field) => field.split(':')[0].trim() === identity)))
        || ((entity || /^(VO|Value Object)$/.test(kindOf(row))) && !fields.every((field) => /^[^:]+:\s*\S.*\s[—–-]\s\S/.test(field)))) {
        modelFailure('MODEL_FIELDS_INCOMPLETE', `${name} needs named, typed fields or values with descriptions, including identity for an Entity`, name);
      }
      if ((entity || kindOf(row) === 'Domain Service' || externalModel(row)) && !linesOf(row['메서드']).every((method) => methodSignature.test(method))) {
        fail(kindOf(row) === 'Domain Service' ? WORKTREE_STAGE.DOMAIN_SERVICE : WORKTREE_STAGE.DOMAIN_MODEL, 'MODEL_METHOD_MISSING', `${name} must declare method signatures with inputs and results`, name);
      }
    }

    for (const row of aggregates) {
      const name = clean(row.Aggregate);
      const root = clean(row.Root);
      if (!name || kindOf(localModels.get(root) || {}) !== 'Entity') aggregateFailure('AGGREGATE_ROOT_INVALID', `${name || id} must name a local Entity as root`, name || id);
      for (const member of unique([root, ...names(row['구성원'])]).filter((item) => !noBehavior(item))) {
        const kind = kindOf(localModels.get(member) || {});
        if (!/^(Entity|VO|Value Object)$/.test(kind)) aggregateFailure('AGGREGATE_MEMBER_INVALID', `${name} lists undeclared member ${member}`, name);
        if (kind === 'Entity') entityMembership.set(member, (entityMembership.get(member) || 0) + 1);
      }
    }
    for (const [name, row] of localModels) {
      if (kindOf(row) === 'Entity' && entityMembership.get(name) !== 1) aggregateFailure('ENTITY_AGGREGATE_INVALID', `${name} must belong to exactly one Aggregate in ${id}`, name);
    }
    if (needsClassDiagram(context) && ['puml', 'svg'].some((extension) => !section.includes(`](${classDiagramPath(id, extension)})`))) {
      aggregateFailure('CLASS_DIAGRAM_MISSING', `${id} must link its class diagram source and rendered SVG`, id);
    }

    for (const row of mappings) {
      const name = clean(row['소유 모델']);
      const model = localModels.get(name);
      const ruleIds = ids(row['규칙'], RULE_ID);
      const [rule] = ruleIds;
      const ruleFailure = model && kindOf(model) === 'Domain Service'
        ? (...args) => fail(WORKTREE_STAGE.DOMAIN_SERVICE, ...args)
        : aggregateFailure;
      if (ruleIds.length !== 1 || !rules.includes(rule)) ruleFailure('RULE_UNKNOWN', `${id} needs one approved rule ID per responsibility row`, rule || id);
      if (ruleOwners.has(rule)) ruleFailure('RULE_OWNER_DUPLICATE', `${rule} has more than one responsibility row`, rule);
      if (rule) ruleOwners.add(rule);
      if (!model || !clean(row['규칙']).replace(RULE_ID, '').trim().replace(/^[-–—:]+$/, '') || !/requirements\.md|answers\.json/.test(row['근거'])) {
        ruleFailure('RULE_RESPONSIBILITY_INCOMPLETE', `${rule || id} needs a declared local owner, the rule text and its approved source`, rule || id);
      }
      if (!model || noBehavior(row['담당 메서드']) || !linesOf(model['메서드']).some((method) => methodName(method) === methodName(row['담당 메서드']))) {
        ruleFailure('RULE_METHOD_UNKNOWN', `${rule || id} must name a method declared by ${name || 'its model'}`, rule || id);
      }
    }

    for (const row of interfaces) {
      const name = clean(row['인터페이스']);
      if (ports.has(name) || ['인터페이스', '시그니처', '소유 위치', '사용 메서드', '실패 계약'].some((column) => noBehavior(row[column]))) serviceFailure('INTERFACE_INCOMPLETE', `${id} needs a distinct interface with signature, ownership, consumers and a failure contract`, name || id);
      ports.set(name, row);
    }
    const localBusiness = new Set(models.flatMap((row) => ids(row['업무'], BIZ_ID)));
    for (const item of localBusiness) {
      if (!business.includes(item) || (approvedContexts.has(id) && !approvedContexts.get(id).includes(item))) modelFailure('BIZ_WRONG_CONTEXT', `${item} is not assigned to ${id} in the approved requirements`, item);
    }
    for (const row of models.filter(externalModel)) {
      for (const item of ids(row['업무'], BIZ_ID)) {
        if (!models.some((model) => !externalModel(model) && ids(model['업무'], BIZ_ID).includes(item))) covered.add(item);
      }
    }
    for (const row of application) {
      const [as] = ids(row.AS, AS_ID);
      const items = ids(row['업무'], BIZ_ID);
      if (clean(row.AS) !== as || appIds.has(as) || !methodSignature.test(clean(row['메서드'])) || noBehavior(row['호출 순서']) || !items.length) {
        serviceFailure('APPLICATION_METHOD_INCOMPLETE', `${id} needs a unique AS ID, method, BIZ and composed calls`, as || id);
      }
      appIds.add(as);
      for (const item of items) {
        if (!business.includes(item) || !localBusiness.has(item)) serviceFailure('APPLICATION_BUSINESS_UNKNOWN', `${as} does not trace ${item} to a local model`, as);
        else covered.add(item);
      }
      const transaction = clean(row['트랜잭션 경계']);
      if (!/^없음\s*[—–-]\s*\S/.test(transaction) && !linesOf(row['트랜잭션 경계']).every((line) => {
        const [, written, steps] = /^T\d+:\s*(.+?)\s+[—–-]\s+(.+)$/.exec(line) || [];
        return localAggregates.has(written) && /시작.+커밋.+롤백/.test(steps);
      })) serviceFailure('TRANSACTION_INCOMPLETE', `${as} needs one local write Aggregate, begin, commit and rollback for each transaction, or a reason for no transaction`, as);
      if (isBlank(row['사용 인터페이스'])) serviceFailure('INTERFACE_USAGE_MISSING', `${as} must list its interfaces or state why none is needed`, as);
      for (const name of names(row['사용 인터페이스']).filter((item) => !noBehavior(item))) {
        if (!ports.has(name) || !ids(ports.get(name)['사용 메서드'], AS_ID).includes(as)) serviceFailure('INTERFACE_UNDECLARED', `${as} uses ${name} without a matching local interface contract`, as);
        if (!usedPorts.has(name)) usedPorts.set(name, new Set());
        usedPorts.get(name).add(as);
      }
    }
    for (const [name, port] of ports) {
      const users = ids(port['사용 메서드'], AS_ID);
      if (!users.length || users.some((as) => !usedPorts.get(name)?.has(as))) serviceFailure('INTERFACE_UNUSED', `${name} must name the local Application Service methods that use it`, name);
    }
  }
  for (const id of approvedContexts.keys()) if (!contextIds.has(id)) modelFailure('CONTEXT_MISSING', `${id} needs a BC section`, id);
  for (const id of business) if (!covered.has(id)) serviceFailure('BIZ_WITHOUT_APPLICATION_METHOD', `${id} needs an Application Service method or an exclusively external owner`, id);
  for (const id of rules) if (!ruleOwners.has(id)) aggregateFailure('RULE_NO_OWNER', `${id} has no owning model and method`, id);
  return errors;
}

export function checkTacticalDesign({ requirements, tacticalDesign }) {
  const contexts = readContextDesign(tacticalDesign);
  if (contexts) return result(checkContextDesign(requirements, contexts));
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

export async function planSetDocument(root, planSetId, name) {
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
  const { errors } = checkTacticalDesign({ requirements: requirements.text, tacticalDesign: tacticalDesign.text });
  for (const context of (readContextDesign(tacticalDesign.text) || []).filter(needsClassDiagram)) {
    const source = await planSetDocument(root, planSetId, classDiagramPath(context.id, 'puml'));
    const svg = await planSetDocument(root, planSetId, classDiagramPath(context.id, 'svg'));
    const sourceHash = source.text === null ? null : createHash('sha256').update(source.text).digest('hex');
    if (!/^\s*@startuml\b/m.test(source.text ?? '') || !/<svg\b/.test(svg.text ?? '') || !svg.text.includes(`<!-- harness-source-sha256: ${sourceHash} -->`)) errors.push({
      code: 'CLASS_DIAGRAM_ARTIFACT_INVALID', message: `Render ${source.path} to ${svg.path} with the installed PlantUML renderer`, id: context.id, owner_stage: WORKTREE_STAGE.AGGREGATE_DESIGN,
    });
  }
  return result(errors);
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
  return `${head} Errors whose owner_stage is ${earlier.join(', ')} are in sections of earlier stages, which are settled input and are not repaired by ${verdict.stage}. Return the errors to the same subagent so it returns blocked / DEPENDENCY_INCOMPLETE with result.owner_stage ${earlier[0]} (the earliest stage to reopen) and result.dependency_gap holding these errors as the evidence, without editing any earlier section, restores ${TACTICAL_DESIGN_DOCUMENT} to the content it had when the stage started, which is its committed content (the restart needs a clean tree) and rewrites its output file, then run finish again. The orchestrator then reopens ${earlier[0]} itself with --reopen-for and re-runs the stale stages in order, without asking the user.`;
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
