import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { sessionDirectory, sessionOutputPath } from './session-output.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DECLARATION = /^(?:#{1,6}\s+((?:BR|UC|AC|INV)-[A-Za-z0-9._-]+)(?=\s|:|—|–|-|$)|[-*]\s+\*\*((?:BR|UC|AC|INV)-[A-Za-z0-9._-]+)(?::\*\*|\*\*:))/;
const DIGEST = /^[a-f0-9]{64}$/;
const execFileAsync = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
function requireValue(value, message) { if (!value) throw new Error(message); }

async function safeFile(root, path) {
  requireValue(typeof path === 'string' && path && !path.startsWith('/') && !path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'), `Invalid workspace-relative path: ${path}`);
  await assertWorkspaceTarget(root, path);
  const info = await lstat(join(root, path));
  requireValue(info.isFile() && !info.isSymbolicLink(), `Expected a regular non-symlink file: ${path}`);
  const content = await readFile(join(root, path));
  return { content, sha256: hash(content) };
}

async function optionalFile(root, path) {
  try { return await safeFile(root, path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function normalizePlanBody(body) { return body.replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/, (frontmatter) => frontmatter.replace(/^status:\s*[^\r\n]+\r?\n/gm, '')); }

async function canonicalPlanBody(root, plan, trackerPort, strict) {
  requireValue(!(plan.content_path && plan.canonical?.kind === 'github'), `Plan ${plan.id} must use one canonical source, not both content_path and GitHub`);
  if (typeof plan.content_path === 'string') {
    try { return (await safeFile(root, plan.content_path)).content.toString('utf8'); }
    catch (error) { if (!strict && error.code === 'ENOENT') return null; throw error; }
  }
  if (plan.canonical?.kind === 'github') {
    const { repository, issue } = plan.canonical;
    requireValue(typeof repository === 'string' && /^[^/\s]+\/[^/\s]+$/.test(repository) && Number.isSafeInteger(issue) && issue > 0, `Invalid GitHub canonical reference for ${plan.id}`);
    if (trackerPort && typeof trackerPort.execute === 'function') {
      const response = await trackerPort.execute({ system: 'github', operation: 'read_issue', target: { repository, issue }, intent: 'tracker-read-plan-traceability', payload: {} });
      const body = response?.body || response?.issue?.body || response?.data?.body;
      requireValue(typeof body === 'string', `Tracker returned no canonical body for ${plan.id}`);
      return body;
    }
    const { stdout } = await execFileAsync('gh', ['issue', 'view', String(issue), '--repo', repository, '--json', 'body'], { cwd: root, encoding: 'utf8' });
    return JSON.parse(stdout).body;
  }
  throw new Error(`Plan ${plan.id} must reference its canonical local content or GitHub issue body`);
}

async function collectInputs(root, planSetId, ledger, { trackerPort = null, strict = true, canonicalBodies = new Map() } = {}) {
  const base = planSetPath(planSetId), ticketId = ledger.ticket_id;
  requireValue(ID.test(ticketId || ''), 'Valid ticket_id is required');
  const productPath = ledger.product_spec_path || `docs/specs/${ticketId}/product-spec.md`;
  const architecturePath = ledger.architecture_spec_path || `docs/specs/${ticketId}/architecture-spec.md`;
  requireValue(ledger.spec_paths.includes(productPath) && ledger.spec_paths.includes(architecturePath), 'Product and Architecture Specs are required review inputs');
  const paths = new Set(ledger.spec_paths);
  for (const path of [
    `docs/specs/${ticketId}/request.md`, `docs/specs/${ticketId}/runtime-decisions.md`,
    `docs/specs/${ticketId}/system-targets.yaml`, `docs/specs/${ticketId}/system-targets.md`,
    'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/architecture/domain-model.md',
  ]) if (await optionalFile(root, path)) paths.add(path);
  for (const directory of [`docs/specs/${ticketId}/diagrams`, `${base}/diagrams`]) {
    await assertWorkspaceTarget(root, directory);
    const dirInfo = await lstat(join(root, directory)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    requireValue(!dirInfo || (dirInfo.isDirectory() && !dirInfo.isSymbolicLink()), `Review input directory must not be a symlink: ${directory}`);
    const walk = async (relative) => {
      const absolute = join(root, relative);
      let entries;
      try { entries = await readdir(absolute, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const path = `${relative}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error(`Review inputs must not contain symlinks: ${path}`);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) paths.add(path);
      }
    };
    await walk(directory);
  }
  const inputs = {};
  for (const path of [...paths].sort()) {
    try { inputs[path] = (await safeFile(root, path)).sha256; }
    catch (error) { if (strict || error.code !== 'ENOENT') throw error; inputs[path] = null; }
  }
  inputs[`${base}/traceability.json#planning`] = hash(JSON.stringify({ schema_version: ledger.schema_version, plan_set_id: ledger.plan_set_id, ticket_id: ledger.ticket_id, spec_paths: ledger.spec_paths, product_spec_path: ledger.product_spec_path || null, architecture_spec_path: ledger.architecture_spec_path || null, requirements: ledger.requirements, plans: ledger.plans, handoffs: ledger.handoffs || [] }));
  for (const plan of ledger.plans || []) {
    const body = canonicalBodies.has(plan.id) ? canonicalBodies.get(plan.id) : await canonicalPlanBody(root, plan, trackerPort, strict);
    inputs[`${base}/plans/${plan.id}#canonical`] = body === null ? null : hash(normalizePlanBody(body));
  }
  return inputs;
}

function declarations(text) {
  return [...text.split(/\r?\n/)].flatMap((line) => {
    const match = line.trim().match(DECLARATION);
    return match ? [match[1] || match[2]] : [];
  });
}

function planSetPath(id) {
  requireValue(ID.test(id || ''), 'Valid plan-set ID is required');
  return `docs/plans/${id}`;
}

export async function snapshotPlanTraceability({ root, planSetId, trackerPort = null } = {}) {
  const base = planSetPath(planSetId);
  const ledgerPath = `${base}/traceability.json`;
  const ledgerFile = await safeFile(root, ledgerPath);
  const ledger = JSON.parse(ledgerFile.content.toString('utf8'));
  requireValue([1, 2].includes(ledger.schema_version) && ledger.plan_set_id === planSetId, 'Unsupported or mismatched traceability ledger');
  requireValue(Array.isArray(ledger.spec_paths) && ledger.spec_paths.length > 0, 'spec_paths must list current review inputs');
  requireValue(Array.isArray(ledger.requirements) && ledger.requirements.length > 0, 'Requirements inventory is empty');
  requireValue(Array.isArray(ledger.plans) && ledger.plans.length > 0, 'Plan inventory is empty');
  const canonicalBodies = new Map();
  for (const plan of ledger.plans) canonicalBodies.set(plan.id, await canonicalPlanBody(root, plan, trackerPort, true));
  const inputs = await collectInputs(root, planSetId, ledger, { trackerPort, canonicalBodies });
  const declared = new Map();
  for (const path of ledger.spec_paths) {
    const file = await safeFile(root, path);
    for (const id of declarations(file.content.toString('utf8'))) {
      const key = `${path}#${id}`;
      requireValue(!declared.has(key), `Duplicate declared requirement: ${key}`);
      declared.set(key, id);
    }
  }
  const seen = new Set();
  for (const req of ledger.requirements) {
    requireValue(req && typeof req.id === 'string' && req.id.trim() && typeof req.source_path === 'string' && typeof req.source_anchor === 'string' && req.source_anchor.trim() && typeof req.statement === 'string' && req.statement.trim(), 'Requirement entries need id, source_path, source_anchor, and statement');
    const key = `${req.source_path}#${req.id}`;
    requireValue(!seen.has(key), `Duplicate requirement: ${key}`); seen.add(key);
    requireValue(ledger.spec_paths.includes(req.source_path), `Requirement source is not in spec_paths: ${req.source_path}`);
    requireValue(typeof req.owner === 'string' && req.owner.trim(), `Requirement owner is required: ${key}`);
    requireValue((await safeFile(root, req.source_path)).content.toString('utf8').includes(req.source_anchor), `Requirement source anchor not found: ${key}`);
    requireValue(['covered', 'excluded'].includes(req.disposition), `Invalid disposition for ${key}`);
    if (req.disposition === 'excluded') requireValue(typeof req.exclusion_reason === 'string' && req.exclusion_reason.trim(), `Excluded requirement needs a reason: ${key}`);
    requireValue(Array.isArray(req.plan_ids) && req.plan_ids.every((id) => typeof id === 'string' && ID.test(id)), `plan_ids must contain valid plan IDs: ${key}`);
    if (req.disposition === 'covered') requireValue(req.plan_ids.length > 0, `Covered requirement has no owning plan: ${key}`);
    if (/^(BR|UC|AC|INV)-/.test(req.id)) requireValue(declared.has(key), `Requirement declaration missing from source: ${key}`);
  }
  for (const key of declared.keys()) requireValue(seen.has(key), `Declared requirement missing from ledger: ${key}`);
  const planIds = new Set();
  for (const plan of ledger.plans) {
    requireValue(plan && ID.test(plan.id || '') && !planIds.has(plan.id), `Invalid or duplicate plan ID: ${plan?.id}`); planIds.add(plan.id);
    requireValue(Array.isArray(plan.requirement_ids) && plan.requirement_ids.length > 0 && plan.requirement_ids.every((key) => typeof key === 'string' && key.includes('#') && key.trim()) && new Set(plan.requirement_ids).size === plan.requirement_ids.length, `Plan ${plan.id} needs unique qualified requirement_ids`);
    requireValue(Array.isArray(plan.acceptance_criteria) && plan.acceptance_criteria.some((v) => typeof v === 'string' && v.trim()), `Plan ${plan.id} needs acceptance criteria`);
    requireValue(Array.isArray(plan.counterexamples) && plan.counterexamples.some((v) => typeof v === 'string' && v.trim()), `Plan ${plan.id} needs counterexamples`);
    requireValue(Array.isArray(plan.verification_cases) && plan.verification_cases.some((v) => typeof v === 'string' && v.trim()), `Plan ${plan.id} needs verification cases`);
  }
  for (const plan of ledger.plans) for (const key of plan.requirement_ids) requireValue(seen.has(key) && ledger.requirements.find((item) => `${item.source_path}#${item.id}` === key)?.disposition === 'covered' && ledger.requirements.find((item) => `${item.source_path}#${item.id}` === key)?.plan_ids.includes(plan.id), `Plan ${plan.id} references unknown or unassigned requirement ${key}`);
  for (const req of ledger.requirements.filter((item) => item.disposition === 'covered')) {
    for (const id of req.plan_ids) requireValue(planIds.has(id) && ledger.plans.find((plan) => plan.id === id).requirement_ids.includes(`${req.source_path}#${req.id}`), `Requirement ${req.id} has dangling plan mapping ${id}`);
    if (req.plan_ids.length > 1) requireValue(req.integration_owner_plan_id && req.plan_ids.includes(req.integration_owner_plan_id) && typeof req.integration_verification === 'string' && req.integration_verification.trim(), `Cross-plan requirement ${req.id} needs integration owner and scenario`);
  }
  if (ledger.schema_version === 2) {
    requireValue(Array.isArray(ledger.handoffs), 'Version 2 traceability ledgers need a handoffs list');
    for (const req of ledger.requirements) {
      requireValue(Array.isArray(req.coverage), `Requirement ${req.id} needs explicit plan coverage`);
      if (req.disposition === 'excluded') {
        requireValue(req.coverage.length === 0, `Excluded requirement ${req.id} cannot have plan coverage`);
        continue;
      }
      const coveredPlans = req.coverage.map((entry) => entry?.plan_id);
      requireValue(coveredPlans.length === req.plan_ids.length && new Set(coveredPlans).size === coveredPlans.length && req.plan_ids.every((id) => coveredPlans.includes(id)), `Requirement ${req.id} must map criteria and verification for every owning plan`);
      for (const entry of req.coverage) {
        const plan = ledger.plans.find((item) => item.id === entry.plan_id);
        requireValue(plan && Array.isArray(entry.acceptance_criteria) && entry.acceptance_criteria.length > 0 && entry.acceptance_criteria.every((criterion) => plan.acceptance_criteria.includes(criterion)), `Requirement ${req.id} needs matching acceptance criteria in ${entry.plan_id}`);
        requireValue(Array.isArray(entry.verification_cases) && entry.verification_cases.length > 0 && entry.verification_cases.every((scenario) => plan.verification_cases.includes(scenario)), `Requirement ${req.id} needs matching verification cases in ${entry.plan_id}`);
      }
      if (req.plan_ids.length > 1) {
        const owner = ledger.plans.find((plan) => plan.id === req.integration_owner_plan_id);
        requireValue(owner?.verification_cases.includes(req.integration_verification), `Cross-plan requirement ${req.id} integration scenario must be a verification case of its owner`);
      }
    }
    const handoffIds = new Set();
    for (const handoff of ledger.handoffs) {
      requireValue(handoff && ID.test(handoff.id || '') && !handoffIds.has(handoff.id), `Invalid or duplicate handoff ID: ${handoff?.id}`);
      handoffIds.add(handoff.id);
      const producer = ledger.plans.find((plan) => plan.id === handoff.producer_plan_id);
      const consumer = ledger.plans.find((plan) => plan.id === handoff.consumer_plan_id);
      requireValue(producer && consumer && producer.id !== consumer.id, `Handoff ${handoff.id} needs distinct producer and consumer plans`);
      requireValue(typeof handoff.produces === 'string' && handoff.produces.trim() && producer.acceptance_criteria.includes(handoff.produces), `Handoff ${handoff.id} producer responsibility must match its acceptance criteria`);
      requireValue(typeof handoff.consumes === 'string' && handoff.consumes.trim() && consumer.acceptance_criteria.includes(handoff.consumes), `Handoff ${handoff.id} consumer responsibility must match its acceptance criteria`);
      requireValue(typeof handoff.verification_case === 'string' && consumer.verification_cases.includes(handoff.verification_case), `Handoff ${handoff.id} needs a consumer verification case`);
    }
  }
  const planIndex = await safeFile(root, `${base}/plans.md`);
  for (const plan of ledger.plans) {
    const body = canonicalBodies.get(plan.id);
    requireValue(body.includes(plan.id) && planIndex.content.toString('utf8').includes(plan.id), `Canonical plan content/index missing ${plan.id}`);
    for (const key of plan.requirement_ids) requireValue(body.includes(key.split('#').at(-1)), `Canonical plan ${plan.id} does not link requirement ${key}`);
    for (const field of ['acceptance_criteria', 'counterexamples', 'verification_cases']) for (const item of plan[field]) requireValue(body.includes(item), `Canonical plan ${plan.id} content is missing ${field} entry`);
  }
  return { plan_set_id: planSetId, ledger, inputs, declarations: [...declared.keys()].sort() };
}

function checkReview(snapshot, ledger) {
  const review = ledger.review;
  requireValue(review && Array.isArray(review.author_ids) && review.author_ids.length && review.author_ids.every((id) => typeof id === 'string' && id.trim()), 'Independent plan review is missing');
  requireValue(typeof review.reviewer_id === 'string' && review.reviewer_id.trim() && !review.author_ids.includes(review.reviewer_id), 'Plan reviewer must be independent of all authors');
  requireValue(review.fork_turns === 'none' && review.verdict === 'pass' && Array.isArray(review.findings), 'Plan review must be fresh and passing');
  requireValue(review.findings.every((finding) => ['blocker', 'major', 'minor'].includes(finding?.severity) && typeof finding.description === 'string' && finding.description.trim() && typeof finding.evidence === 'string' && finding.evidence.trim()), 'Plan review findings need severity and concrete source evidence');
  requireValue(review.findings.every((finding) => finding.severity === 'minor'), 'Plan review has unresolved major or blocker findings');
  requireValue(review.inputs && Object.keys(snapshot.inputs).length === Object.keys(review.inputs).length && Object.entries(snapshot.inputs).every(([path, digest]) => review.inputs[path] === digest), 'Plan review is stale; create a fresh independent review');
}

export async function inspectPlanTraceability({ root, planSetId, phase, planId, trackerPort = null } = {}) {
  try {
    requireValue(['planning', 'dispatch', 'completion'].includes(phase), 'Valid traceability phase is required');
    const snapshot = await snapshotPlanTraceability({ root, planSetId, trackerPort });
    if (phase === 'planning') requireValue(snapshot.ledger.schema_version === 2, 'New plans must use traceability schema_version 2 with explicit requirement coverage');
    checkReview(snapshot, snapshot.ledger);
    if (phase === 'dispatch') requireValue(snapshot.ledger.plans.some((plan) => plan.id === planId), `Dispatch plan ${planId || '(missing)'} is not in the reviewed plan set`);
    if (phase === 'completion') {
      const plans = planId ? snapshot.ledger.plans.filter((item) => item.id === planId) : snapshot.ledger.plans;
      requireValue(plans.length && (!planId || plans.length === 1), `Completion plan ${planId || '(missing)'} is not in the reviewed plan set`);
      for (const plan of plans) {
      const evidence = snapshot.ledger.implementation?.[plan.id];
      requireValue(evidence && Array.isArray(evidence.requirements) && evidence.requirements.length, `Implementation evidence missing for ${plan.id}`);
      const evidenced = new Set();
      for (const item of evidence.requirements) {
        requireValue(plan.requirement_ids.includes(item.requirement_id), `Implementation evidence references unrelated requirement ${item.requirement_id}`);
        requireValue(!evidenced.has(item.requirement_id), `Duplicate implementation evidence for ${item.requirement_id}`); evidenced.add(item.requirement_id);
        requireValue(Array.isArray(item.files) && item.files.length && Array.isArray(item.verification) && item.verification.length, `Implementation evidence incomplete for ${item.requirement_id}`);
        for (const entry of [...item.files, ...item.verification]) {
          requireValue(typeof entry.path === 'string' && DIGEST.test(entry.sha256 || ''), `Evidence hash missing for ${item.requirement_id}`);
          requireValue((await safeFile(root, entry.path)).sha256 === entry.sha256, `Implementation evidence stale: ${entry.path}`);
        }
        requireValue(typeof item.receipt === 'string' && item.receipt, `Execution receipt missing for ${item.requirement_id}`);
        requireValue(typeof plan.verification_profile === 'string' && ID.test(plan.verification_profile), `Plan ${plan.id} must select a configured verification_profile`);
        const executionConfig = JSON.parse((await safeFile(root, 'docs/agents/execution.json')).content.toString('utf8'));
        const selectedProfile = executionConfig.profiles?.[plan.verification_profile];
        requireValue(selectedProfile, `Unknown execution profile ${plan.verification_profile}`);
        const receiptPath = sessionOutputPath(root, item.receipt);
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
        requireValue(receipt.status === 'passed' && receipt.phase === 'command' && receipt.exit_code === 0 && receipt.steps?.some((step) => step.phase === 'command' && step.exit_code === 0) && receipt.profile_id === plan.verification_profile && receipt.config_hashes?.['docs/agents/execution.json'] === (await safeFile(root, 'docs/agents/execution.json')).sha256, `Successful current harness-exec receipt required for ${item.requirement_id}`);
        requireValue(new RegExp(`^runtime/execution/${plan.verification_profile}-[a-f0-9-]{36}/receipt\\.json$`).test(item.receipt), `Receipt must come from the harness-exec session output for ${item.requirement_id}`);
        const expectedConfig = new Set(['docs/agents/execution.json', ...selectedProfile.config_inputs]);
        requireValue(Object.keys(receipt.config_hashes).length === expectedConfig.size && [...expectedConfig].every((path) => Object.hasOwn(receipt.config_hashes, path)), `Receipt configuration inputs do not match profile ${plan.verification_profile}`);
        requireValue(receipt.steps.filter((step) => step.phase === 'prepare').length === selectedProfile.prepare.length && receipt.steps.filter((step) => step.phase === 'verify_config').length === selectedProfile.verify_config.length && receipt.steps.filter((step) => step.phase === 'command').length === 1, `Receipt execution stages do not match profile ${plan.verification_profile}`);
        const sessionRoot = sessionDirectory(root);
        for (const step of receipt.steps) {
          requireValue(typeof step.phase === 'string' && Number.isInteger(step.exit_code) && typeof step.log === 'string' && isAbsolute(step.log), `Execution receipt step is incomplete for ${item.requirement_id}`);
          const logRelative = relative(sessionRoot, step.log);
          requireValue(logRelative && logRelative !== '..' && !logRelative.startsWith(`..${sep}`) && !isAbsolute(logRelative), `Execution log escapes session directory for ${item.requirement_id}`);
          const verifiedLog = sessionOutputPath(root, logRelative);
          requireValue(verifiedLog === step.log, `Execution log path is not canonical for ${item.requirement_id}`);
          await readFile(verifiedLog);
        }
        for (const step of receipt.steps.filter((item) => ['prepare', 'verify_config', 'command'].includes(item.phase))) requireValue(step.exit_code === 0, `Execution prerequisite failed for ${item.requirement_id}`);
        const allowedPhases = new Set(['prepare', 'verify_config', 'command', ...(selectedProfile.dependencies || []).map(({ id }) => `dependency:${id}`)]);
        requireValue(receipt.steps.every((step) => allowedPhases.has(step.phase)), `Receipt contains an unconfigured execution step for ${item.requirement_id}`);
        for (const dependency of selectedProfile.dependencies || []) {
          const attempts = receipt.steps.filter((step) => step.phase === `dependency:${dependency.id}`);
          requireValue(attempts.length && attempts.at(-1).exit_code === 0, `Execution dependency did not become ready: ${dependency.id}`);
        }
        const configInputs = new Set(executionConfig.profiles[plan.verification_profile].config_inputs);
        for (const [path, expectedHash] of Object.entries(receipt.config_hashes)) requireValue((await safeFile(root, path)).sha256 === expectedHash, `Execution receipt has stale configuration input ${path}`);
        for (const entry of [...item.files, ...item.verification]) requireValue(configInputs.has(entry.path) && receipt.config_hashes[entry.path] === entry.sha256, `Selected execution profile receipt does not bind evidence file ${entry.path}`);
      }
      for (const requirementId of plan.requirement_ids) requireValue(evidenced.has(requirementId), `Implementation evidence missing requirement ${requirementId}`);
      }
    }
    return { status: 'pass', reason: `plan_traceability_${phase}_current`, violations: [], details: {
      plan_set_id: planSetId,
      ticket_id: snapshot.ledger.ticket_id,
      plan_id: planId || null,
      ledger_path: `${planSetPath(planSetId)}/traceability.json`,
      product_spec_path: snapshot.ledger.product_spec_path || `docs/specs/${snapshot.ledger.ticket_id}/product-spec.md`,
      architecture_spec_path: snapshot.ledger.architecture_spec_path || `docs/specs/${snapshot.ledger.ticket_id}/architecture-spec.md`,
      requirement_ids: planId ? snapshot.ledger.plans.find((item) => item.id === planId).requirement_ids : [],
      plan_reference: planId ? (() => { const plan = snapshot.ledger.plans.find((item) => item.id === planId); return plan.content_path || `${plan.canonical.repository}#${plan.canonical.issue}`; })() : null,
    } };
  } catch (error) { return { status: 'blocked', reason: error.message, violations: ['plan_traceability'] }; }
}

export async function inspectTraceabilityImpact({ root, planSetId } = {}) {
  try {
    const base = planSetPath(planSetId);
    const ledger = JSON.parse((await safeFile(root, `${base}/traceability.json`)).content.toString('utf8'));
    const canonicalBodies = new Map();
    for (const plan of ledger.plans || []) canonicalBodies.set(plan.id, await canonicalPlanBody(root, plan, null, false));
    const inputs = await collectInputs(root, planSetId, ledger, { strict: false, canonicalBodies });
    const prior = ledger.review?.inputs || {};
    const changed_paths = [...new Set([...Object.keys(prior), ...Object.keys(inputs)])].filter((path) => prior[path] !== inputs[path]).sort();
    const currentDeclared = new Set();
    for (const path of ledger.spec_paths) {
      const file = await optionalFile(root, path);
      if (file) for (const id of declarations(file.content.toString('utf8'))) currentDeclared.add(`${path}#${id}`);
    }
    const previousDeclared = new Set(ledger.requirements.map((item) => `${item.source_path}#${item.id}`).filter((key) => /#(?:BR|UC|AC|INV)-/.test(key)));
    const added = [...currentDeclared].filter((key) => !previousDeclared.has(key)).sort();
    const removed = [...previousDeclared].filter((key) => !currentDeclared.has(key)).sort();
    const affected = changed_paths.length || added.length || removed.length;
    const modified = ledger.requirements.filter((item) => changed_paths.includes(item.source_path) || changed_paths.includes(`${base}/traceability.json#planning`) || item.plan_ids?.some((id) => changed_paths.includes(`${base}/plans/${id}#canonical`))).map((item) => `${item.source_path}#${item.id}`);
    const affectedIds = [...new Set([...added, ...modified, ...removed])].sort();
    return { status: 'pass', plan_set_id: planSetId, changed_paths, added_requirement_ids: added, modified_requirement_ids: [...new Set(modified)].sort(), removed_requirement_ids: removed, affected_requirement_ids: affectedIds, affected_plan_ids: affected ? ledger.plans.map((item) => item.id) : [], revalidation: affected ? 'All plans are conservatively invalidated until fresh review.' : 'No changed review inputs.' };
  } catch (error) { return { status: 'blocked', reason: error.message, plan_set_id: planSetId }; }
}
