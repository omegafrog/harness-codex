import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { parseYaml } from '../eval/yaml.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { loadNamedWorkflow, WORKFLOW_STAGE_GATE_IDS } from './loader.mjs';
import { LifecycleGateRegistry } from '../gates/lifecycle.mjs';
import { sessionDirectory } from './session-output.mjs';

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
  const supported = ['$schema', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minLength', 'pattern', 'oneOf', 'minItems', 'uniqueItems'];
  requireValue(Object.keys(schema).every((key) => supported.includes(key)), 'Unsupported skill schema constraint');
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
  const expected = sessionDirectory(resolve(root), { create: false });
  const chosen = provided || expected;
  requireValue(isAbsolute(chosen) && /^[a-f0-9]{64}$/.test(basename(chosen)), 'Invalid execution session directory');
  requireValue(await realpath(dirname(chosen)) === await realpath(dirname(expected)), 'Execution session belongs to another repository');
  requireValue(await realpath(chosen) === resolve(chosen), 'Execution session must not be a symlink');
  return resolve(chosen);
}

async function readReference(root, reference, sessionRoot) {
  requireValue(!isAbsolute(reference.path) && !win32.isAbsolute(reference.path) && reference.path.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..'), 'Artifact path must be relative without traversal');
  let path;
  if (reference.base === 'session') { await assertWorkspaceTarget(sessionRoot, reference.path); path = resolve(sessionRoot, reference.path); }
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

export async function validateComposedWorkflow({ root, session_directory, workflow }) {
  validate(workflow, await json(join(root, '.codex/internal-skills/workflow-compose/schemas/workflow.schema.json')));
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
  validate(input, await json(join(root, CONTRACT, 'schemas/input.schema.json')));
  requireValue(await realpath(input.workspace_root) === await realpath(root), 'Input workspace does not match caller root');
  requireValue(isAbsolute(input.shared_guidance_root), 'shared_guidance_root must be absolute');
  if (input.context?.role) {
    requireValue(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.context.role), 'Invalid role ID');
    await readReference(root, { base: 'workspace', path: `.codex/agents/${input.context.role}.toml` }, input.session_directory);
  }
  const session = await resolveSkillSession(root, input.session_directory);
  for (const reference of input.input_refs) await readReference(root, reference, session);
}

export async function validateSkillReturn({ root, input, envelope }) {
  const schemas = await Promise.all(['input', 'return', 'result'].map((name) => json(join(root, CONTRACT, 'schemas', `${name}.schema.json`))));
  validate(input, schemas[0]); validate(envelope, schemas[1]);
  requireValue(isAbsolute(input.workspace_root) && await realpath(input.workspace_root) === await realpath(root), 'Input workspace does not match caller root');
  requireValue(isAbsolute(input.shared_guidance_root), 'shared_guidance_root must be absolute');
  const session = await resolveSkillSession(root, input.session_directory);
  for (const key of ['execution_id', 'skill']) requireValue(input[key] === envelope[key], `Return ${key} mismatch`);
  requireValue(CODES[envelope.status]?.includes(envelope.code), 'Return status/code mismatch');
  for (const reference of input.input_refs) await readReference(root, reference, session);
  if (envelope.result_ref === null) {
    requireValue(envelope.status === 'failed' && envelope.code === 'ARTIFACT_WRITE_FAILED', 'Only artifact-write failures may omit result_ref');
    return { valid: true, usable_result: false, ...envelope };
  }
  const expected = `runtime/executions/${input.execution_id}/result.json`;
  requireValue(envelope.result_ref === expected, 'Result must belong to the requested execution');
  const result = JSON.parse(await readReference(root, { base: 'session', path: expected }, session));
  validate(result, schemas[2]);
  for (const key of ['execution_id', 'skill', 'status', 'code']) requireValue(result[key] === envelope[key], `Result ${key} mismatch`);
  for (const reference of result.artifacts) await readReference(root, reference, session);
  if (input.context?.review_admission && (envelope.status === 'completed' || envelope.status === 'action_required')) {
    const admission = input.context.review_admission;
    const { validateSpecReviewAdmission } = await import('./spec-review.mjs');
    await validateSpecReviewAdmission({ root, admission, requireActive: false });
    const reviewed = result.details?.inputs;
    requireValue(result.details?.axis === admission.target.axis && result.details?.ticket_id === admission.target.ticket_id && reviewed && Object.keys(reviewed).length === Object.keys(admission.inputs).length && Object.entries(admission.inputs).every(([path, digest]) => reviewed[path] === digest), 'Review result must match the admitted workspace snapshot');
  }
  if (envelope.status === 'completed') {
    for (const output of input.context?.outputs ?? []) {
      requireValue(result.artifacts.filter((artifact) => artifact.kind === output.id).length === 1, `Completed stage must return one artifact with kind=${output.id}`);
    }
  }
  if (envelope.code === 'USER_DECISION_REQUIRED') {
    const questions = result.artifacts.filter((item) => item.kind === 'user_question');
    requireValue(questions.length === 1 && questions[0].base === 'session', 'Decision return requires one session user_question artifact');
    const question = JSON.parse(await readReference(root, questions[0], session));
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
