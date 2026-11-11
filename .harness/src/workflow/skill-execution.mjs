import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path';
import { parseYaml } from '../eval/yaml.mjs';
import { assertWorkspaceTarget } from '../eval/case-workspace.mjs';
import { loadNamedWorkflow } from './loader.mjs';
import { sessionDirectory, stageExecutionPaths } from './session-output.mjs';
import { findExecutionInput } from './execution-input.mjs';
import { assertSingleProvider, configuredProvider, parseWorkflowBinding } from './providers/index.mjs';
import { providerAgents, tierSettingKeys } from './agent-config.mjs';
import { readSkillDeclaration } from './skill-declaration.mjs';
import { parseWorktreeRecord, resolveExecutionWorkspace } from './worktrees.mjs';

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

// A skill's tier comes from its own document (see skill-declaration.mjs) and a workflow stage may override it with another
// setup tier; the model and effort are always the active provider's agents.<provider>.<tier>_* values written by setup.
export async function resolveSkillBinding({ root, skill, workflow = null, stage = null, workflowBinding = null }) {
  const declaration = await readSkillDeclaration({ root, skill });
  requireValue(!declaration.main_session, `${skill} runs in the main session and cannot be bound as a subagent`);
  let tier = declaration.model_tier;
  requireValue(Boolean(workflow) === Boolean(stage), 'workflow and stage must be supplied together');
  if (workflow) {
    const manifest = await loadNamedWorkflow(workflow, { root });
    const selected = manifest.stages.find((item) => item.id === stage);
    requireValue(selected?.skill === skill, 'Workflow stage does not match the requested skill');
    tier = selected.model_tier || tier;
  }
  const config = parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8'));
  const keys = tierSettingKeys(tier);
  // Model settings live under agents.<provider>; only the active provider's section is read.
  const provider = configuredProvider(config);
  const settings = providerAgents(config, provider);
  const model = settings[keys.model], effort = settings[keys.reasoning_effort];
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
  assertSingleProvider(config, override);
  if (recordedBinding && workflowBinding) {
    const supplied = parseWorkflowBinding(workflowBinding);
    requireValue(['provider', 'model', 'reasoning_effort'].every((key) => supplied[key] === override[key]), 'Workflow binding conflicts with canonical worktree record');
  }
  if (!override) for (const [key, value] of [[keys.model, model], [keys.reasoning_effort, effort]]) {
    requireValue(typeof value === 'string' && value.trim() && !value.startsWith('agents.'), `Missing or invalid model binding: agents.${provider}.${key}`);
  }
  return { skill, provider: override?.provider || configuredProvider(config), model_tier: tier, model: override?.model || model, reasoning_effort: override?.reasoning_effort || effort };
}

// The subagent hook logs every reviewer a stage starts. A reviewer outside an admitted attempt, or forked
// from the author's conversation, may still have steered the documents; the stage completes only when an
// admitted fresh reviewer finished after the last such reviewer.
export async function assertNoRogueReviewer({ root, session, input }) {
  let text;
  try { text = String(await readReference(root, { base: 'session', path: `runtime/executions/${input.execution_id}/subagents.jsonl` }, session)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const events = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((item) => item.review_scope);
  const lastRogue = events.findLastIndex((item) => item.admitted === false);
  if (lastRogue < 0) return;
  const laterAdmitted = events.slice(lastRogue + 1).some((item) => item.event === 'SubagentStop' && item.admitted !== false && item.review_attempt_id);
  const rogue = events[lastRogue];
  requireValue(laterAdmitted, `Reviewer ${rogue.agent_id} ran ${rogue.forked ? 'forked from the author conversation' : 'outside an admitted review attempt'} after the last admitted review; begin a new review with a fresh reviewer before completing`);
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
  if (!input.context?.worktree_ref) return input;
  const ref = input.context.worktree_ref;
  requireValue(ref === join(sessionDirectory(root, { create: false }), 'worktree.json'), 'Invalid canonical worktree reference');
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
  return { ...stageInput, workspace_root: record.workspace, session_directory: record.session_directory, context: { ...input.context, execution_workspace: await resolveExecutionWorkspace(root, record.plan_set_id || null), ...(record.plan_set_id ? { plan_set_id: record.plan_set_id } : {}) } };
}

export async function validateSkillInput({ root, input }) {
  input = await resolveInputWorktree(root, input);
  validate(input, await json(join(root, CONTRACT, 'schemas/input.schema.json')));
  if (input.skill === 'tracker-publish') requireValue(input.context?.publication_approved === true, 'User publication approval is required');
  if (input.context?.worktree_ref && ['to-ticket', 'tracker-publish'].includes(input.skill)) {
    const { requireCurrentSpecReview } = await import('./spec-review.mjs');
    await requireCurrentSpecReview({ root, ticketId: input.context.plan_set_id });
  }
  if (input.skill === 'tracker-publish' && input.context?.worktree_ref) {
    const { preparePublicationDrafts } = await import('../tracker/publication.mjs');
    const expected = await preparePublicationDrafts({ root, planSetId: input.context.plan_set_id });
    const supplied = input.context.publication_drafts;
    requireValue(Array.isArray(supplied) && supplied.length === expected.length && expected.every((item) => supplied.some((candidate) => candidate.plan_id === item.plan_id && candidate.body_path === item.body_path && candidate.body_sha256 === item.body_sha256)), 'Publication body references must match static runner output');
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
  if (input.skill === 'e2e-test') {
    const requests = input.input_refs.filter((item) => item.kind === 'approved_e2e_request' && item.base === 'session');
    requireValue(input.context?.agent_profile === 'e2e_test_runner' && requests.length === 1, 'E2E requires one approved request and a dedicated runner');
    const request = JSON.parse(await readReference(root, requests[0], session, controlSession));
    const head = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
    const manifestText = await readFile(join(root, 'docs/agents/execution.json'));
    requireValue(request.manifest_sha256 === createHash('sha256').update(manifestText).digest('hex'), 'E2E request execution profile has changed');
    const manifest = JSON.parse(manifestText);
    const profile = manifest.profiles?.[request.profile_id];
    requireValue(request.target_commit === head && Array.isArray(request.scenarios) && request.scenarios.length > 0 && request.scenarios.every((item) => typeof item === 'string' && item.trim()) && profile?.purpose === 'e2e' && Number.isInteger(request.timeout_ms) && request.timeout_ms > 0 && profile.timeout_ms === request.timeout_ms, 'E2E request does not match the current commit or profile');
    const inputs = (await readFile(join(session, 'runtime/orchestrator/user-inputs.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const orchestratorId = input.context.orchestrator_session_id || input.context.codex_session_id;
    requireValue(typeof request.approval_answer === 'string' && request.approval_answer.trim() && orchestratorId && inputs.some((item) => item.text === request.approval_answer && item.session_id === orchestratorId), 'E2E request approval was not recorded');
  }
}

// reopening: 사용자 수정으로 다시 열 완료 stage는 고칠 대상 Spec의 현재 리뷰를 요구하지 않는다.
export async function validateSkillReturn({ root, input, envelope, reopening = false }) {
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
  const expected = stageExecutionPaths(root, input.execution_id, { create: false }).refs.result;
  requireValue(envelope.result_ref === expected, 'Result must belong to the requested execution');
  const result = envelope.result || JSON.parse(await readReference(root, { base: 'session', path: expected }, session, controlSession));
  requireValue(!(input.skill === 'spec-me' && result.review_request?.skill === 'spec-review'), 'spec-me must perform spec-review internally using a fresh native reviewer');
  requireValue(!(input.skill === 'to-ticket' && (result.review_request?.skill === 'plan-review' || envelope.code === 'REVIEW_REQUIRED')), 'to-ticket must complete its independent plan-review loop internally');
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
  if (input.skill === 'e2e-test' && envelope.status === 'completed') {
    const requests = input.input_refs.filter((item) => item.kind === 'approved_e2e_request');
    const receipts = result.artifacts.filter((item) => item.kind === 'e2e_receipt' && item.base === 'session');
    const cleanups = result.artifacts.filter((item) => item.kind === 'e2e_cleanup' && item.base === 'session');
    requireValue(requests.length === 1 && receipts.length === 1 && cleanups.length === 1, 'Completed E2E requires its approved request, receipt and cleanup evidence');
    requireValue(/^runtime\/execution\/[A-Za-z0-9._-]+\/receipt\.json$/.test(receipts[0].path) && /^runtime\/e2e\/[A-Za-z0-9._-]+\/cleanup\.json$/.test(cleanups[0].path), 'E2E evidence must belong to the execution session');
    const request = JSON.parse(await readReference(root, requests[0], session, controlSession));
    const receipt = JSON.parse(await readReference(root, receipts[0], session, controlSession));
    const cleanup = JSON.parse(await readReference(root, cleanups[0], session, controlSession));
    requireValue(receipt.status === 'passed' && receipt.exit_code === 0 && receipt.profile_id === request.profile_id && receipt.head === request.target_commit && receipt.config_hashes?.['docs/agents/execution.json'] === request.manifest_sha256, 'E2E receipt does not prove the approved run passed');
    requireValue(cleanup.status === 'passed', 'E2E cleanup is not verified');
  }
  if (result.review_request && Object.hasOwn(result.review_request, 'agent_profile')) {
    const request = result.review_request;
    // A review runs a sub-agent skill, so the skill must declare a setup tier in its own document.
    const reviewer = await readSkillDeclaration({ root, skill: request.skill }).catch((error) => { throw new Error(`Unregistered review skill: ${request.skill} (${error.message})`); });
    requireValue(!reviewer.main_session, `Unregistered review skill: ${request.skill} runs in the main session`);
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
  if (envelope.status === 'completed' && ['spec-me', 'to-ticket', 'sync-contracts'].includes(input.skill)) await assertNoRogueReviewer({ root, session, input });
  if (envelope.status === 'completed') {
    if (!reopening && input.skill === 'spec-me' && input.context?.worktree_ref && !input.context?.agent_profile && !input.context?.role) {
      const { requireCurrentSpecReview } = await import('./spec-review.mjs');
      await requireCurrentSpecReview({ root, ticketId: input.context.plan_set_id });
    }
    if (input.skill === 'tracker-publish') {
      const { verifyActivatedPublication } = await import('../tracker/publication.mjs');
      await verifyActivatedPublication({ root, planSetId: input.context?.plan_set_id });
    }
    // The sync-contracts stage seals the contract and has it independently reviewed; it cannot finish on a revision that no
    // hook-recorded fresh reviewer passed. A stage being reopened is replaced by the new run, which needs its own review.
    if (input.skill === 'sync-contracts' && input.context?.worktree_ref && input.context?.plan_set_id) {
      const { inspectContractReview } = await import('./contract-review.mjs');
      const review = await inspectContractReview({ root, planSetId: input.context.plan_set_id });
      requireValue(reopening || review.status === 'pass', `sync-contracts requires a current passing independent contract review: ${review.reason}${review.details?.problem ? ` (${review.details.problem})` : ''}${review.details?.next ? `; ${review.details.next}` : ''}`);
    }
    if (input.skill === 'to-ticket') {
      const { inspectPlanSet } = await import('./plan-review.mjs');
      const review = await inspectPlanSet({ root, planSetId: input.context?.plan_set_id, phase: 'planning' });
      // A completed plan being reopened (user revision, or a Spec change that requires a plan revision) is replaced by the
      // new run, whose own completion needs a fresh review; the stale review of the old plan must not block the reopening.
      requireValue(reopening || review.status === 'pass', `to-ticket requires a current passing independent plan review: ${review.reason}`);
      // GitHub publication later reads these drafts; a plan set without them can never be published.
      const tracker = parseYaml(await readFile(join(root, '.codex/harness.yaml'), 'utf8').catch(() => '')).tracker;
      // A completed result being reopened for a user revision is re-validated only to be replaced; it may predate this check.
      if (tracker?.mode === 'github' && !reopening) {
        const snapshot = await (await import('./plan-review.mjs')).snapshotPlanSet({ root, planSetId: input.context?.plan_set_id });
        const missing = [];
        for (const planId of ['@parent', ...snapshot.plans.map((plan) => plan.id)]) {
          const name = planId === '@parent' ? 'parent' : planId;
          const body = await readFile(join(session, 'runtime/to-ticket/drafts', `${name}.md`), 'utf8').catch(() => '');
          if (!body.trim()) missing.push(`runtime/to-ticket/drafts/${name}.md`);
        }
        requireValue(!missing.length, `to-ticket must save a GitHub Issue draft for the plan set and every plan in the session directory before completing; missing or empty: ${missing.join(', ')}`);
      }
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
      // A technology question shows, per option, why it meets each criterion, citing a stored Claim from an authoritative source.
      if (question.decision_kind === 'technology') await assertTechnologyQuestionEvidence(root, question);
    }
  }
  if (['implement', 'implement-wrapper'].includes(input.skill) && (envelope.code === 'USER_DECISION_REQUIRED' || questions.length)) throw new Error('Implementation does not ask the user; return SPEC_REVISION_REQUIRED for a decision the approved Spec does not settle');
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

export async function assertTechnologyQuestionEvidence(root, question) {
  const { readClaim, readSource } = await import('../knowledge/registry.mjs');
  for (const option of question.options) {
    requireValue(Array.isArray(option.evidence) && option.evidence.length > 0, `Technology option ${option.id} needs evidence citing stored knowledge Claims`);
    const tiers = [];
    for (const item of option.evidence) {
      const claim = await readClaim({ root, claimId: item.claim_id }).catch(() => null);
      requireValue(claim, `Technology option ${option.id} cites Claim ${item.claim_id}, which is not in knowledge/claims; save it with harness-knowledge.mjs claim save`);
      tiers.push((await readSource({ root, sourceId: claim.source_id })).tier);
    }
    requireValue(tiers.some((tier) => tier !== 'community'), `Technology option ${option.id} rests only on community sources; cite a standard, official document or measurement`);
  }
}

