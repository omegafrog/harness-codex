import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { parseYaml } from '../eval/yaml.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { loadNamedWorkflow, WORKFLOW_STAGE_GATE_IDS } from './loader.mjs';
import { LifecycleGateRegistry } from '../gates/lifecycle.mjs';
import { sessionDirectory } from './session-output.mjs';
import { findExecutionInput } from './execution-input.mjs';

const CONTRACT = '.codex/internal-skills/skill-execution';
const CODES = {
  completed: ['OK'],
  action_required: ['REVIEW_REQUIRED', 'SUBTASK_REQUIRED', 'SPEC_REVISION_REQUIRED', 'PLAN_REVISION_REQUIRED', 'IMPLEMENTATION_REVISION_REQUIRED', 'USER_DECISION_REQUIRED'],
  blocked: ['ENVIRONMENT_UNAVAILABLE', 'PERMISSION_REQUIRED', 'DEPENDENCY_INCOMPLETE', 'INPUT_MISSING', 'MODEL_BINDING_UNAVAILABLE'],
  failed: ['EXECUTION_ERROR', 'INVALID_INPUT', 'ARTIFACT_WRITE_FAILED'],
  cancelled: ['CANCELLED'],
};

function requireValue(condition, message) { if (!condition) throw new Error(message); }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
function validateSharedGuidanceRoot(root, sharedRoot) {
  const common = (path) => realpathSync(resolve(path, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: path, encoding: 'utf8' }).trim()));
  requireValue(common(root) === common(sharedRoot), 'shared_guidance_root must share the workspace Git common directory');
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
  const supported = ['$schema', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minLength', 'pattern', 'oneOf', 'anyOf', 'minItems', 'uniqueItems'];
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

export async function resolveSkillBinding({ root, skill, workflow = null, stage = null }) {
  const bindings = await json(join(root, CONTRACT, 'bindings.json'));
  requireValue(!bindings.main_session_skills?.includes(skill), `${skill} runs in the main session and cannot be bound as a subagent`);
  let tier = bindings.skills[skill];
  requireValue(typeof tier === 'string', `Unregistered skill: ${skill}`);
  requireValue(Boolean(workflow) === Boolean(stage), 'workflow and stage must be supplied together');
  if (workflow) {
    const manifest = await loadNamedWorkflow(workflow, { root });
    const selected = manifest.stages.find((item) => item.id === stage);
    requireValue(selected?.skill === skill, 'Workflow stage does not match the requested skill');
    tier = selected.model_tier;
  }
  const config = parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8'));
  const keys = bindings.tiers[tier];
  requireValue(keys, `Unknown model tier: ${tier}`);
  const get = (key) => key.split('.').reduce((value, part) => value?.[part], config);
  const model = get(keys.model_key), effort = get(keys.reasoning_effort_key);
  for (const [key, value] of [[keys.model_key, model], [keys.reasoning_effort_key, effort]]) {
    requireValue(typeof value === 'string' && value.trim() && !value.startsWith('agents.'), `Missing or invalid model binding: ${key}`);
  }
  return { skill, model_tier: tier, model, reasoning_effort: effort };
}

export async function resolveSkillSession(root, provided = null) {
  const chosen = resolve(provided || sessionDirectory(resolve(root), { create: false }));
  requireValue(isAbsolute(chosen) && basename(chosen) === '.io', 'Invalid execution session directory');
  const workspace = dirname(chosen);
  validateSharedGuidanceRoot(root, workspace);
  requireValue(await realpath(chosen) === chosen, 'Execution session must not be a symlink');
  return chosen;
}

async function readReference(root, reference, sessionRoot, controlSessionRoot = sessionRoot) {
  requireValue(!isAbsolute(reference.path) && !win32.isAbsolute(reference.path) && reference.path.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..'), 'Artifact path must be relative without traversal');
  let path;
  if (reference.base === 'session') { await assertWorkspaceTarget(sessionRoot, reference.path); path = resolve(sessionRoot, reference.path); }
  else if (reference.base === 'control_session') { await assertWorkspaceTarget(controlSessionRoot, reference.path); path = resolve(controlSessionRoot, reference.path); }
  else { await assertWorkspaceTarget(root, reference.path); path = resolve(root, reference.path); }
  requireValue((await lstat(path)).isFile(), `Artifact is not a regular file: ${reference.path}`);
  const content = await readFile(path);
  if (reference.sha256) requireValue(createHash('sha256').update(content).digest('hex') === reference.sha256, `Artifact hash mismatch: ${reference.path}`);
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
  if (!['spec-me', 'to-ticket'].includes(input.skill) || !input.context?.worktree_ref) return input;
  const ref = input.context.worktree_ref;
  requireValue(isAbsolute(ref) && basename(ref) === 'worktree.json', 'Invalid canonical worktree reference');
  const directory = await resolveSkillSession(root, dirname(ref));
  requireValue(ref === join(directory, 'worktree.json'), 'Invalid canonical worktree reference');
  const info = await lstat(ref);
  requireValue(info.isFile() && !info.isSymbolicLink(), 'Worktree record must be a regular file');
  const { parseWorktreeRecord } = await import('./worktrees.mjs');
  const record = parseWorktreeRecord(await readFile(ref, 'utf8'));
  requireValue(record.state === 'active' && record.session_directory === directory && await realpath(record.workspace) === await realpath(root), 'Worktree does not match execution workspace');
  validateSharedGuidanceRoot(root, record.return_root);
  requireValue(!input.context.plan_set_id || input.context.plan_set_id === record.plan_set_id, 'Input plan_set_id conflicts with worktree record');
  for (const [key, value] of Object.entries({ workspace_root: record.workspace, shared_guidance_root: record.return_root, session_directory: record.session_directory })) {
    requireValue(input[key] === undefined || input[key] === value, `Input ${key} conflicts with worktree record`);
  }
  return { ...input, workspace_root: record.workspace, shared_guidance_root: record.return_root, session_directory: record.session_directory, context: { ...input.context, ...(record.plan_set_id ? { plan_set_id: record.plan_set_id } : {}) } };
}

export async function validateComposedWorkflow({ root, session_directory, workflow }) {
  const { state, ...definition } = workflow;
  validate(definition, await json(join(root, '.codex/internal-skills/workflow-compose/schemas/workflow.schema.json')));
  const session = await resolveSkillSession(root, session_directory);
  const bindings = await json(join(root, CONTRACT, 'bindings.json'));
  const stages = new Map(workflow.stages.map((stage) => [stage.id, stage]));
  requireValue(stages.size === workflow.stages.length, 'Duplicate workflow stage IDs');
  const gates = new Set([...WORKFLOW_STAGE_GATE_IDS, ...new LifecycleGateRegistry().checks.keys()]);
  const visited = new Set(), active = new Set();
  function ancestors(id) {
    requireValue(stages.has(id), `Unknown dependency stage: ${id}`);
    requireValue(!active.has(id), `Cyclic workflow dependency: ${id}`);
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of stages.get(id).needs) ancestors(dependency);
    active.delete(id); visited.add(id);
  }
  for (const stage of stages.values()) {
    ancestors(stage.id);
    requireValue(bindings.skills[stage.skill] && stage.skill !== 'workflow-compose' && !bindings.main_session_skills.includes(stage.skill), `Invalid workflow task skill: ${stage.skill}`);
    const paths = [`.codex/internal-skills/${stage.skill}/GUIDE.md`, `.agents/skills/${stage.skill}/SKILL.md`, `.codex/skills/${stage.skill}/SKILL.md`];
    let found = false;
    for (const path of paths) {
      try { await readReference(root, { base: 'workspace', path }, session); found = true; break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    requireValue(found, `Missing task skill entrypoint: ${stage.skill}`);
    if (stage.role !== 'default') await readReference(root, { base: 'workspace', path: `.codex/agents/${stage.role}.toml` }, session);
    requireValue(stage.gates.every((gate) => gates.has(gate)), `Unknown workflow gate in stage ${stage.id}`);
    requireValue(new Set(stage.outputs.map((output) => output.id)).size === stage.outputs.length, `Duplicate output IDs in stage ${stage.id}`);
    const dependencies = new Set();
    const collect = (id) => { for (const dependency of stages.get(id).needs) if (!dependencies.has(dependency)) { dependencies.add(dependency); collect(dependency); } };
    collect(stage.id);
    for (const input of stage.inputs) {
      if (input.from_stage) {
        requireValue(dependencies.has(input.from_stage), `Input producer is not a dependency: ${input.from_stage}`);
        requireValue(stages.get(input.from_stage).outputs.some((output) => output.id === input.artifact), `Unknown producer artifact: ${input.artifact}`);
      } else await readReference(root, input, session);
    }
  }
  return { valid: true, stage_count: stages.size };
}

export async function validateSkillInput({ root, input }) {
  input = await resolveInputWorktree(root, input);
  validate(input, await json(join(root, CONTRACT, 'schemas/input.schema.json')));
  requireValue(await realpath(input.workspace_root) === await realpath(root), 'Input workspace does not match caller root');
  requireValue(isAbsolute(input.shared_guidance_root), 'shared_guidance_root must be absolute');
  validateSharedGuidanceRoot(root, input.shared_guidance_root);
  if (input.context?.role) {
    requireValue(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.context.role), 'Invalid role ID');
    await readReference(root, { base: 'workspace', path: `.codex/agents/${input.context.role}.toml` }, input.session_directory);
  }
  const session = await resolveSkillSession(root, input.session_directory);
  const controlSession = await resolveSkillSession(root, input.context?.control_session_directory || input.session_directory);
  for (const reference of input.input_refs) await readReference(root, reference, session, controlSession);
}

export async function validateSkillReturn({ root, input, envelope }) {
  input = await resolveInputWorktree(root, input);
  const schemas = await Promise.all(['input', 'return'].map((name) => json(join(root, CONTRACT, 'schemas', `${name}.schema.json`))));
  const flow = input.skill === 'to-ticket' && ['plan_split', 'plan_revision', 'plan_finalize'].includes(input.context?.stage_id) ? `to-ticket-${input.context.stage_id}` : input.skill;
  const flowSchema = flow === 'workflow-compose' ? 'workflow-compose-result.schema.json' : `flows/${flow}.schema.json`;
  validate(input, schemas[0]); validate(envelope, schemas[1]);
  requireValue(isAbsolute(input.workspace_root) && await realpath(input.workspace_root) === await realpath(root), 'Input workspace does not match caller root');
  requireValue(isAbsolute(input.shared_guidance_root), 'shared_guidance_root must be absolute');
  validateSharedGuidanceRoot(root, input.shared_guidance_root);
  const session = await resolveSkillSession(root, input.session_directory);
  const controlSession = await resolveSkillSession(root, input.context?.control_session_directory || input.session_directory);
  for (const key of ['execution_id', 'skill']) requireValue(input[key] === envelope[key], `Return ${key} mismatch`);
  requireValue(CODES[envelope.status]?.includes(envelope.code), 'Return status/code mismatch');
  for (const reference of input.input_refs) await readReference(root, reference, session, controlSession);
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
  const resultSchema = await json(join(root, CONTRACT, 'schemas', flowSchema));
  validate(result, resultSchema);
  for (const key of ['execution_id', 'skill', 'status', 'code']) requireValue(result[key] === envelope[key], `Result ${key} mismatch`);
  for (const reference of result.artifacts) await readReference(root, reference, session, controlSession);
  if (result.review_request) {
    const context = JSON.parse(await readReference(root, { base: 'session', path: result.review_request.context_path }, session, controlSession));
    requireValue(context && typeof context === 'object' && !Array.isArray(context), 'Review context must be an object');
  }
  if (input.context?.review_checklist && ['completed', 'action_required'].includes(envelope.status)) {
    const ids = input.context.review_checklist.decision_ids;
    const criteria = ['requirements', 'targets', 'alternatives', 'tradeoffs', 'evidence', 'boundary', 'answered_objections'];
    requireValue(input.skill === 'architecture-review' && Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length && ids.every((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)), 'Invalid architecture review checklist');
    const reports = result.artifacts.filter((artifact) => artifact.kind === 'architecture_review');
    requireValue(reports.length === 1, 'Architecture review requires one checklist report');
    const report = (await readReference(root, reports[0], session, controlSession)).toString('utf8');
    const entries = [...report.matchAll(/^- \[([ xX])\] ([A-Za-z0-9][A-Za-z0-9._-]*) \/ (requirements|targets|alternatives|tradeoffs|evidence|boundary|answered_objections) — (\S.*)$/gm)];
    for (const id of ids) for (const criterion of criteria) requireValue(entries.filter((entry) => entry[2] === id && entry[3] === criterion).length === 1, `Architecture review checklist missing or duplicates ${id} / ${criterion}`);
  }
  if (input.context?.review_admission && (envelope.status === 'completed' || envelope.status === 'action_required')) {
    const admission = input.context.review_admission;
    const { validateSpecReviewAdmission } = await import('./spec-review.mjs');
    await validateSpecReviewAdmission({ root, admission, requireActive: false });
    const reviewed = result.inputs ? Object.fromEntries(result.inputs.map(({ path, sha256 }) => [path, sha256])) : null;
    if (result.inputs) requireValue(Object.keys(reviewed).length === result.inputs.length, 'Duplicate reviewed input paths');
    requireValue(result.axis === admission.target.axis && result.ticket_id === admission.target.ticket_id && reviewed && Object.keys(reviewed).length === Object.keys(admission.inputs).length && Object.entries(admission.inputs).every(([path, digest]) => reviewed[path] === digest), 'Review result must match the admitted workspace snapshot');
  }
  if (input.context?.plan_review_admission && (envelope.status === 'completed' || envelope.status === 'action_required')) {
    const admission = input.context.plan_review_admission;
    const { validatePlanReviewAdmission } = await import('./plan-review.mjs');
    await validatePlanReviewAdmission({ root, planSetId: input.context.plan_set_id, admission, requireActive: false });
    const reviewed = result.inputs ? Object.fromEntries(result.inputs.map(({ path, sha256 }) => [path, sha256])) : null;
    if (result.inputs) requireValue(Object.keys(reviewed).length === result.inputs.length, 'Duplicate reviewed input paths');
    requireValue(result.plan_set_id === input.context.plan_set_id && result.attempt_id === admission.attempt_id && reviewed && Object.keys(reviewed).length === Object.keys(admission.inputs).length && Object.entries(admission.inputs).every(([path, digest]) => reviewed[path] === digest), 'Plan review result must match the admitted workspace snapshot');
  }
  if (envelope.status === 'completed') {
    for (const output of input.context?.outputs ?? []) {
      requireValue(result.artifacts.filter((artifact) => artifact.kind === output.id).length === 1, `Completed stage must return one artifact with kind=${output.id}`);
    }
  }
  const questions = result.artifacts.filter((item) => item.kind === 'user_question');
  const resultQuestions = result.questions?.length ? result.questions : undefined;
  if (resultQuestions !== undefined) {
    requireValue(envelope.code === 'REVIEW_REQUIRED' && Array.isArray(resultQuestions) && resultQuestions.length > 0, 'Question batch requires REVIEW_REQUIRED');
    const schema = await json(join(root, CONTRACT, 'schemas/question.schema.json'));
    for (const [index, question] of resultQuestions.entries()) {
      validate(question, schema);
      requireValue(question.question_id === `${input.execution_id}:${index + 1}`, 'Invalid deterministic question ID');
      requireValue(new Set(question.options.map((option) => option.id)).size === question.options.length && question.options.some((option) => option.id === question.recommended_option_id), 'Invalid question options/recommendation');
    }
  }
  if (envelope.code === 'USER_DECISION_REQUIRED' || questions.length) {
    requireValue(questions.length <= 1 && (questions.length === 0 || questions[0].base === 'session'), 'Question requires at most one session user_question artifact');
    const question = result.question || (questions.length ? JSON.parse(await readReference(root, questions[0], session)) : null);
    requireValue(question, 'User decision requires an inline question');
    validate(question, await json(join(root, CONTRACT, 'schemas/question.schema.json')));
    requireValue(new Set(question.options.map((option) => option.id)).size === question.options.length && question.options.some((option) => option.id === question.recommended_option_id), 'Invalid question options/recommendation');
  }
  if (input.skill === 'workflow-compose' && envelope.status === 'completed') {
    const workflows = result.artifacts.filter((item) => item.kind === 'request_workflow');
    requireValue(workflows.length === 1 && workflows[0].base === 'session' && workflows[0].path === 'runtime/orchestrator/workflow.json', 'Workflow composition must return one canonical workflow artifact');
    await validateComposedWorkflow({ root, session_directory: session, workflow: JSON.parse(await readReference(root, workflows[0], session)) });
  }
  return { valid: true, usable_result: true, ...envelope };
}
