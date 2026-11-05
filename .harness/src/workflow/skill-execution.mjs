import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path';
import { parseYaml } from '../eval/yaml.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { loadNamedWorkflow } from './loader.mjs';
import { sessionDirectory } from './session-output.mjs';
import { findExecutionInput } from './execution-input.mjs';
import { configuredProvider, parseWorkflowBinding } from './providers/index.mjs';
import { parseWorktreeRecord } from './worktrees.mjs';

const CONTRACT = '.codex/internal-skills/skill-execution';
const execFileAsync = promisify(execFile);
const CODES = {
  completed: ['OK'],
  action_required: ['REVIEW_REQUIRED', 'SPEC_REVISION_REQUIRED', 'PLAN_REVISION_REQUIRED', 'IMPLEMENTATION_REVISION_REQUIRED', 'USER_DECISION_REQUIRED'],
  blocked: ['ENVIRONMENT_UNAVAILABLE', 'PERMISSION_REQUIRED', 'DEPENDENCY_INCOMPLETE', 'INPUT_MISSING', 'MODEL_BINDING_UNAVAILABLE'],
  failed: ['EXECUTION_ERROR', 'INVALID_INPUT', 'ARTIFACT_WRITE_FAILED'],
  cancelled: ['CANCELLED'],
};

function requireValue(condition, message) { if (!condition) throw new Error(message); }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function validateSameRepository(root, sharedRoot) {
  const common = async (path) => realpath(resolve(path, (await execFileAsync('git', ['rev-parse', '--git-common-dir'], { cwd: path, encoding: 'utf8' })).stdout.trim()));
  const [workspaceCommon, guidanceCommon] = await Promise.all([common(root), common(sharedRoot)]);
  requireValue(workspaceCommon === guidanceCommon, 'Worktree return_root must share the workspace Git common directory');
}

export function validateContextBudget(policy) {
  requireValue(policy?.schema_version === 1, 'Unsupported context budget version');
  for (const key of ['context_window_tokens', 'max_plan_tokens', 'handoff_reserve_tokens']) requireValue(Number.isSafeInteger(policy[key]) && policy[key] > 0, `Context budget ${key} must be a positive integer`);
  requireValue(policy.max_plan_tokens + policy.handoff_reserve_tokens <= policy.context_window_tokens, 'Plan budget plus reserve exceeds the context window');
  return policy;
}

export async function assessContextBudget({ root, estimatedTokens, usedTokens = null }) {
  const content = await readFile(join(root, '.codex/context-budget.json'), 'utf8');
  const policy = validateContextBudget(JSON.parse(content));
  requireValue(Number.isSafeInteger(estimatedTokens) && estimatedTokens >= 0, 'Estimated tokens must be a nonnegative integer');
  requireValue(usedTokens === null || (Number.isSafeInteger(usedTokens) && usedTokens >= 0), 'Used tokens must be measured as a nonnegative integer');
  const handoffAt = policy.context_window_tokens - policy.handoff_reserve_tokens;
  return { ...policy, policy_sha256: createHash('sha256').update(content).digest('hex'), estimated_tokens: estimatedTokens, used_tokens: usedTokens, plan_fits: estimatedTokens <= policy.max_plan_tokens, handoff_at_tokens: handoffAt, action_fits: usedTokens === null ? null : usedTokens + estimatedTokens <= handoffAt };
}

// These schemas use only this subset; reject unsupported constraints rather than silently ignoring them.
function validate(value, schema, path = '$') {
  const supported = ['$schema', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minLength', 'pattern', 'oneOf', 'anyOf', 'minItems', 'uniqueItems', 'description'];
  requireValue(Object.keys(schema).every((key) => supported.includes(key)), 'Unsupported skill schema constraint');
  if (schema.anyOf) requireValue(schema.anyOf.some((candidate) => { try { validate(value, candidate, path); return true; } catch { return false; } }), `${path}: expected a permitted shape`);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => { try { validate(value, candidate, path); return true; } catch { return false; } });
    requireValue(matches.length === 1, `${path}: expected one reference shape`);
  }
  if ('const' in schema) requireValue(value === schema.const, `${path}: invalid constant`);
  if (schema.enum) requireValue(schema.enum.includes(value), `${path}: unknown value`);
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type) requireValue([schema.type].flat().includes(type), `${path}: invalid type`);
  if (type === 'string') {
    if (schema.minLength) requireValue(value.trim().length >= schema.minLength, `${path}: empty string`);
    if (schema.pattern) requireValue(new RegExp(schema.pattern).test(value), `${path}: invalid format`);
  }
  if (type === 'object') {
    for (const key of schema.required || []) requireValue(Object.hasOwn(value, key), `${path}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key];
      requireValue(child || schema.additionalProperties !== false, `${path}.${key}: unexpected field`);
      if (child) validate(item, child, `${path}.${key}`);
    }
  }
  if (type === 'array') {
    if (schema.minItems) requireValue(value.length >= schema.minItems, `${path}: missing items`);
    if (schema.uniqueItems) requireValue(new Set(value.map((item) => JSON.stringify(item))).size === value.length, `${path}: duplicate items`);
    if (schema.items) value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`));
  }
}

export async function resolveSkillBinding({ root, skill, workflow = null, stage = null, workflowBinding = null }) {
  const bindings = await json(join(root, CONTRACT, 'bindings.json'));
  requireValue(!bindings.main_session_skills?.includes(skill), `${skill} runs in the main session and cannot be bound as a subagent`);
  let tier = bindings.skills[skill];
  requireValue(typeof tier === 'string', `Unregistered skill: ${skill}`);
  requireValue(Boolean(workflow) === Boolean(stage), 'workflow and stage must be supplied together');
  if (workflow) {
    const manifest = await loadNamedWorkflow(workflow, { root });
    const selected = manifest.stages.find((item) => item.id === stage);
    requireValue(selected?.skill === skill, 'Workflow stage does not match the requested skill');
    tier = selected.model_tier || tier;
  }
  const config = parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8'));
  const keys = bindings.tiers[tier];
  requireValue(keys, `Unknown model tier: ${tier}`);
  const get = (key) => key.split('.').reduce((value, part) => value?.[part], config);
  const model = get(keys.model_key), effort = get(keys.reasoning_effort_key);
  let recordedBinding = null;
  let session;
  try { session = sessionDirectory(root, { create: false }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (session) {
    let info;
    try { info = await lstat(join(session, 'worktree.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info) {
      requireValue(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'Canonical worktree record must be a regular unshared file');
      const record = parseWorktreeRecord(await readFile(join(session, 'worktree.json'), 'utf8'));
      requireValue(await realpath(record.workspace) === await realpath(root) && record.session_directory === session, 'Canonical worktree record does not match binding workspace');
      requireValue(record.state === 'active', 'Workflow binding requires an active worktree');
      recordedBinding = record.workflow_binding || null;
    }
  }
  const override = recordedBinding ? parseWorkflowBinding(recordedBinding) : workflowBinding ? parseWorkflowBinding(workflowBinding) : null;
  if (recordedBinding && workflowBinding) {
    const supplied = parseWorkflowBinding(workflowBinding);
    requireValue(['provider', 'model', 'reasoning_effort'].every((key) => supplied[key] === override[key]), 'Workflow binding conflicts with canonical worktree record');
  }
  if (!override) for (const [key, value] of [[keys.model_key, model], [keys.reasoning_effort_key, effort]]) {
    requireValue(typeof value === 'string' && value.trim() && !value.startsWith('agents.'), `Missing or invalid model binding: ${key}`);
  }
  return { skill, provider: override?.provider || configuredProvider(config), model_tier: tier, model: override?.model || model, reasoning_effort: override?.reasoning_effort || effort };
}

export async function resolveWorkflowStage({ root, input, workflow = null, stage = null }) {
  requireValue(Boolean(workflow) === Boolean(stage), 'workflow and stage must be supplied together');
  if (workflow) {
    requireValue(!input.context?.stage_id || input.context.stage_id === stage, 'Workflow stage does not match the execution input');
    return { workflow, stage };
  }
  if (!input.context?.stage_id) return { workflow: null, stage: null };
  const files = await readdir(join(root, '.codex/workflows'), { withFileTypes: true });
  const matches = [];
  for (const file of files) {
    if (!file.isFile() || !/\.ya?ml$/i.test(file.name)) continue;
    const manifest = await loadNamedWorkflow(file.name, { root });
    if (manifest.stages.some((candidate) => candidate.id === input.context.stage_id && candidate.skill === input.skill)) matches.push(manifest.id);
  }
  requireValue(matches.length <= 1, 'Workflow stage is ambiguous; pass --workflow and --stage');
  return matches.length ? { workflow: matches[0], stage: input.context.stage_id } : { workflow: null, stage: null };
}

export async function resolveAgentSandbox({ root, input, workflow = null, stage = null }) {
  let profile = input.context?.agent_profile || input.context?.role || null;
  if (workflow) {
    const manifest = await loadNamedWorkflow(workflow, { root });
    const selected = manifest.stages.find((item) => item.id === stage);
    requireValue(selected?.skill === input.skill, 'Workflow stage does not match the requested skill');
    if (profile) requireValue(profile === selected.role, 'Execution profile does not match the workflow role');
    profile = selected.role;
  } else requireValue(!stage, 'workflow and stage must be supplied together');
  if (input.skill === 'tracker-publish') requireValue(workflow === 'to-ticket' && stage === 'tracker-publish' && profile === 'tracker_publisher', 'Tracker publishing is available only as the to-ticket workflow stage');
  const mode = profile ? /^sandbox_mode\s*=\s*"([^"]+)"\s*$/m.exec(await readFile(join(root, '.codex/agents', `${profile}.toml`), 'utf8'))?.[1] : 'workspace-write';
  requireValue(['read-only', 'workspace-write', 'danger-full-access'].includes(mode), 'Agent profile requires a supported sandbox_mode');
  if (mode === 'danger-full-access') requireValue(workflow === 'to-ticket' && stage === 'tracker-publish' && profile === 'tracker_publisher', 'danger-full-access is reserved for the to-ticket tracker-publish stage');
  return { profile, sandbox: mode };
}

export async function resolveSkillSession(root, provided = null) {
  const chosen = resolve(provided || sessionDirectory(resolve(root), { create: false }));
  requireValue(isAbsolute(chosen) && basename(chosen) === '.io', 'Invalid execution session directory');
  const workspace = dirname(chosen);
  await validateSameRepository(root, workspace);
  requireValue(await realpath(chosen) === chosen, 'Execution session must not be a symlink');
  return chosen;
}

async function readReference(root, reference, sessionRoot, controlSessionRoot = sessionRoot, allowDirectory = false) {
  const parts = reference.path.split(/[\\/]/);
  if (parts.at(-1) === '') parts.pop();
  requireValue(!isAbsolute(reference.path) && !win32.isAbsolute(reference.path) && parts.length > 0 && parts.every((part) => part && part !== '.' && part !== '..'), 'Artifact path must be relative without traversal');
  const relativePath = parts.join(sep);
  let base;
  if (reference.base === 'session') base = sessionRoot;
  else if (reference.base === 'control_session') base = controlSessionRoot;
  else base = root;
  await assertWorkspaceTarget(base, relativePath);
  const path = resolve(base, relativePath);
  const info = await lstat(path);
  if (allowDirectory && info.isDirectory()) return null;
  requireValue(info.isFile(), `Artifact is not a regular file: ${reference.path}`);
  const content = await readFile(path);
  return content;
}

export async function readSkillSessionJson({ root, session_directory = null, path }) {
  const session = await resolveSkillSession(root, session_directory);
  return JSON.parse(await readReference(root, { base: 'session', path }, session));
}

export async function readExecutionInput({ root, execution_id }) {
  const { input } = await findExecutionInput(root, execution_id);
  return resolveInputWorktree(root, input);
}

async function resolveInputWorktree(root, input) {
  if (!['workflow-compose', 'spec-me', 'to-ticket', 'tracker-publish'].includes(input.skill) || !input.context?.worktree_ref) return input;
  const ref = input.context.worktree_ref;
  requireValue(isAbsolute(ref) && basename(ref) === 'worktree.json', 'Invalid canonical worktree reference');
  const directory = await resolveSkillSession(root, dirname(ref));
  requireValue(ref === join(directory, 'worktree.json'), 'Invalid canonical worktree reference');
  const info = await lstat(ref);
  requireValue(info.isFile() && !info.isSymbolicLink(), 'Worktree record must be a regular file');
  const { parseWorktreeRecord } = await import('./worktrees.mjs');
  const record = parseWorktreeRecord(await readFile(ref, 'utf8'));
  requireValue(record.state === 'active' && record.session_directory === directory && await realpath(record.workspace) === await realpath(root), 'Worktree does not match execution workspace');
  if (input.skill !== 'workflow-compose') requireValue(JSON.stringify(input.context?.workflow_binding ?? null) === JSON.stringify(record.workflow_binding ?? null), 'Input workflow_binding conflicts with canonical worktree record');
  await validateSameRepository(root, record.return_root);
  requireValue(!input.context.plan_set_id || input.context.plan_set_id === record.plan_set_id, 'Input plan_set_id conflicts with worktree record');
  for (const [key, value] of Object.entries({ workspace_root: record.workspace, session_directory: record.session_directory })) {
    requireValue(input[key] === undefined || input[key] === value, `Input ${key} conflicts with worktree record`);
  }
  const { shared_guidance_root: _legacyGuidanceRoot, ...stageInput } = input;
  return { ...stageInput, workspace_root: record.workspace, session_directory: record.session_directory, context: { ...input.context, ...(record.plan_set_id ? { plan_set_id: record.plan_set_id } : {}) } };
}

export async function validateSkillInput({ root, input }) {
  input = await resolveInputWorktree(root, input);
  validate(input, await json(join(root, CONTRACT, 'schemas/input.schema.json')));
  if (input.skill === 'tracker-publish') requireValue(input.context?.publication_approved === true, 'User publication approval is required');
  if (input.context?.worktree_ref && ['to-ticket', 'tracker-publish'].includes(input.skill)) {
    const { requireCurrentSpecReview } = await import('./spec-review.mjs');
    await requireCurrentSpecReview({ root, ticketId: input.context.plan_set_id });
  }
  if (input.skill === 'workflow-compose') {
    validate(input, await json(join(root, CONTRACT, 'schemas/workflow-compose-input.schema.json')));
    requireValue(isAbsolute(input.context?.worktree_ref || '') && basename(input.context.worktree_ref) === 'worktree.json', 'Compose requires a canonical worktree reference');
    requireValue(typeof input.context?.plan_set_id === 'string' && input.context?.stage_id === 'workflow-compose', 'Compose context is incomplete');
  }
  requireValue(await realpath(input.workspace_root) === await realpath(root), 'Input workspace does not match caller root');
  if (input.context?.agent_profile || input.context?.role) {
    requireValue(!(input.context.agent_profile && input.context.role), 'Ambiguous agent profile');
    const profile = input.context.agent_profile || input.context.role;
    requireValue(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(profile), 'Invalid agent profile');
    await readReference(root, { base: 'workspace', path: `.codex/agents/${profile}.toml` }, input.session_directory);
  }
  const session = await resolveSkillSession(root, input.session_directory);
  const controlSession = await resolveSkillSession(root, input.context?.control_session_directory || input.session_directory);
  for (const reference of input.input_refs) await readReference(root, reference, session, controlSession, true);
}

export async function validateSkillReturn({ root, input, envelope }) {
  input = await resolveInputWorktree(root, input);
  const schemas = await Promise.all(['input', 'return'].map((name) => json(join(root, CONTRACT, 'schemas', `${name}.schema.json`))));
  const flow = input.skill;
  const flowSchema = flow === 'workflow-compose' ? 'workflow-compose-result.schema.json' : `flows/${['spec-review', 'plan-review'].includes(flow) ? flow : 'common'}.schema.json`;
  validate(input, schemas[0]); validate(envelope, schemas[1]);
  requireValue(isAbsolute(input.workspace_root) && await realpath(input.workspace_root) === await realpath(root), 'Input workspace does not match caller root');
  const session = await resolveSkillSession(root, input.session_directory);
  const controlSession = await resolveSkillSession(root, input.context?.control_session_directory || input.session_directory);
  for (const key of ['execution_id', 'skill']) requireValue(input[key] === envelope[key], `Return ${key} mismatch`);
  requireValue(CODES[envelope.status]?.includes(envelope.code), 'Return status/code mismatch');
  requireValue(!(input.skill === 'spec-me' && envelope.code === 'IMPLEMENTATION_REVISION_REQUIRED'), 'spec-me cannot request implementation revision; route changed Specs through planning');
  for (const reference of input.input_refs) await readReference(root, reference, session, controlSession, true);
  if (envelope.result_ref === null) {
    requireValue(envelope.status === 'failed' && envelope.code === 'ARTIFACT_WRITE_FAILED', 'Only artifact-write failures may omit result_ref');
    if (envelope.result) {
      const failureSchema = await json(join(root, CONTRACT, 'schemas', flowSchema));
      validate(envelope.result, failureSchema);
      for (const key of ['execution_id', 'skill', 'status', 'code']) requireValue(envelope.result[key] === envelope[key], `Return result ${key} mismatch`);
    }
    return { valid: true, usable_result: false, ...envelope };
  }
  const expected = `runtime/executions/${input.execution_id}/result.json`;
  requireValue(envelope.result_ref === expected, 'Result must belong to the requested execution');
  const result = envelope.result || JSON.parse(await readReference(root, { base: 'session', path: expected }, session, controlSession));
  requireValue(!(input.skill === 'spec-me' && result.review_request?.skill === 'spec-review'), 'spec-me must perform spec-review internally using a fresh native reviewer');
  const resultSchema = await json(join(root, CONTRACT, 'schemas', flowSchema));
  const schemaResult = structuredClone(result);
  if (schemaResult.review_request) {
    const request = schemaResult.review_request;
    requireValue(!(Object.hasOwn(request, 'role') && Object.hasOwn(request, 'agent_profile')), 'Ambiguous agent profile');
    if (Object.hasOwn(request, 'agent_profile')) { request.role = request.agent_profile; delete request.agent_profile; }
  }
  validate(schemaResult, resultSchema);
  for (const key of ['execution_id', 'skill', 'status', 'code']) requireValue(result[key] === envelope[key], `Result ${key} mismatch`);
  for (const reference of result.artifacts) await readReference(root, reference, session, controlSession, true);
  if (result.review_request && Object.hasOwn(result.review_request, 'agent_profile')) {
    const request = result.review_request;
    const bindings = await json(join(root, CONTRACT, 'bindings.json'));
    requireValue(typeof request.skill === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(request.skill) && Object.hasOwn(bindings.skills, request.skill) && !bindings.main_session_skills?.includes(request.skill), `Unregistered review skill: ${request.skill}`);
    const entries = [`.codex/internal-skills/${request.skill}/GUIDE.md`, `.agents/skills/${request.skill}/SKILL.md`, `.codex/skills/${request.skill}/SKILL.md`];
    const present = await Promise.all(entries.map((path) => readReference(root, { base: 'workspace', path }, session).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; })));
    requireValue(present.some(Boolean), `Review skill instruction missing: ${request.skill}`);
    if (request.agent_profile !== null && request.agent_profile !== 'default') {
      requireValue(typeof request.agent_profile === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(request.agent_profile), 'Invalid agent profile');
      await readReference(root, { base: 'workspace', path: `.codex/agents/${request.agent_profile}.toml` }, session);
    }
  }
  if (result.review_request) {
    let context;
    try { context = JSON.parse(await readReference(root, { base: 'session', path: result.review_request.context_path }, session, controlSession)); }
    catch (error) { throw new Error(`Review context must be an existing session-relative JSON file: ${result.review_request.context_path}`, { cause: error }); }
    requireValue(context && typeof context === 'object' && !Array.isArray(context), 'Review context must be an object');
  }
  if (input.context?.review_admission && (envelope.status === 'completed' || envelope.status === 'action_required')) {
    const admission = input.context.review_admission;
    const { validateSpecReviewAdmission } = await import('./spec-review.mjs');
    await validateSpecReviewAdmission({ root, admission, requireActive: false });
    requireValue(result.axis === admission.target.axis && result.ticket_id === admission.target.ticket_id, 'Review result must match the admitted target');
  }
  if (input.context?.plan_review_admission && (envelope.status === 'completed' || envelope.status === 'action_required')) {
    const admission = input.context.plan_review_admission;
    const { validatePlanReviewAdmission } = await import('./plan-review.mjs');
    await validatePlanReviewAdmission({ root, planSetId: input.context.plan_set_id, admission, requireActive: false });
    requireValue(result.plan_set_id === input.context.plan_set_id && result.attempt_id === admission.attempt_id, 'Plan review result must match the admitted target');
  }
  if (envelope.status === 'completed') {
    if (input.skill === 'spec-me' && input.context?.worktree_ref && !input.context?.agent_profile && !input.context?.role) {
      const { requireCurrentSpecReview } = await import('./spec-review.mjs');
      await requireCurrentSpecReview({ root, ticketId: input.context.plan_set_id });
    }
    if (input.skill === 'tracker-publish') {
      const { verifyDraftPublication } = await import('../tracker/publication.mjs');
      await verifyDraftPublication({ root, planSetId: input.context?.plan_set_id });
    }
    for (const output of input.context?.outputs ?? []) {
      requireValue(result.artifacts.filter((artifact) => artifact.kind === output.id).length === 1, `Completed stage must return one artifact with kind=${output.id}`);
    }
  }
  const questions = result.artifacts.filter((item) => item.kind === 'user_question');
  const resultQuestions = result.questions?.length ? result.questions : undefined;
  if (resultQuestions !== undefined) {
    requireValue(['REVIEW_REQUIRED', 'USER_DECISION_REQUIRED'].includes(envelope.code) && Array.isArray(resultQuestions) && resultQuestions.length > 0, 'Question batch requires a waiting decision or review');
    const schema = await json(join(root, CONTRACT, 'schemas/question.schema.json'));
    for (const [index, question] of resultQuestions.entries()) {
      validate(question, schema);
      requireValue(question.question_id === `${input.execution_id}:${index + 1}`, 'Invalid deterministic question ID');
      requireValue(new Set(question.options.map((option) => option.id)).size === question.options.length && question.options.some((option) => option.id === question.recommended_option_id), 'Invalid question options/recommendation');
    }
  }
  if (envelope.code === 'USER_DECISION_REQUIRED' || questions.length) {
    requireValue(questions.length <= 1 && (questions.length === 0 || questions[0].base === 'session'), 'Question requires at most one session user_question artifact');
    requireValue(resultQuestions, 'User decision requires questions');
  }
  if (input.skill === 'workflow-compose' && envelope.status === 'completed') {
    requireValue(result.worktree_ref === input.context?.worktree_ref, 'Prepared worktree reference must match input');
    const { parseWorktreeRecord } = await import('./worktrees.mjs');
    const record = parseWorktreeRecord(await readFile(result.worktree_ref, 'utf8'));
    requireValue(record.state === 'active' && record.workspace === root && record.session_directory === session, 'Prepared worktree must be active and canonical');
    const { inspectWorkspace } = await import('../eval/workspace-preflight.mjs');
    const workspace = await inspectWorkspace({ workspaceRoot: root, cwd: root });
    requireValue(workspace.valid && workspace.is_linked_worktree, 'Prepared workspace is not a registered linked worktree');
    const git = async (...args) => (await execFileAsync('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
    const [branch, common] = await Promise.all([git('branch', '--show-current'), git('rev-parse', '--path-format=absolute', '--git-common-dir')]);
    requireValue(branch === record.branch && await realpath(common) === await realpath(record.common), 'Prepared worktree Git identity mismatch');
    const { inspectProjectReadiness } = await import('./project-readiness.mjs');
    const readiness = await inspectProjectReadiness({ workspace_root: root });
    requireValue(readiness.status === 'pass', `Project preparation incomplete: ${readiness.violations.join(', ')}`);
    await resolveSkillBinding({ root, skill: 'workflow-compose' });
    validateContextBudget(await json(join(root, '.codex/context-budget.json')));
  }
  return { valid: true, usable_result: true, ...envelope };
}
