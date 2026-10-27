#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
const installed = new URL('../harness-runtime/src/workflow/skill-execution.mjs', import.meta.url);
const { validateSkillInput, resolveSkillSession, readSkillSessionJson, resolveSkillBinding, validateSkillReturn } = await import(existsSync(installed) ? installed.href : new URL('../../src/workflow/skill-execution.mjs', import.meta.url).href);
const stateModule = new URL('../harness-runtime/src/workflow/execution-state.mjs', import.meta.url);
const { recordExecutionState } = await import(existsSync(stateModule) ? stateModule.href : new URL('../../src/workflow/execution-state.mjs', import.meta.url).href);
let lifecycle = null;
try {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    if (!['--root', '--session-directory', '--input', '--workflow', '--stage', '--request-workflow', '--codex-session-id', '--answer', '--review-admission'].includes(key) || !process.argv[i + 1] || options[key]) throw new Error(`Invalid argument: ${key}`);
    options[key] = process.argv[i + 1];
  }
  const root = options['--root'];
  if (!isAbsolute(root || '')) throw new Error('Absolute --root is required');
  const session = await resolveSkillSession(root, options['--session-directory']);
  let inputPath = options['--input'];
  if (options['--request-workflow']) {
    if (inputPath || options['--workflow'] || !options['--stage']) throw new Error('Select request workflow stage or explicit input, not both');
    const module = new URL('../harness-runtime/src/workflow/stage-input.mjs', import.meta.url);
    const { prepareStageInput } = await import(existsSync(module) ? module.href : new URL('../../src/workflow/stage-input.mjs', import.meta.url).href);
    inputPath = (await prepareStageInput({ root, session, workflowRef: options['--request-workflow'], stageId: options['--stage'], codexSessionId: options['--codex-session-id'] || process.env.CODEX_THREAD_ID, answerRef: options['--answer'], reviewAdmissionRef: options['--review-admission'] })).path;
  }
  const input = await readSkillSessionJson({ root, session_directory: session, path: inputPath });
  if (input.workspace_root !== root || input.session_directory !== session || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.execution_id) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.skill)) throw new Error('Invalid execution input');
  await validateSkillInput({ root, input });
  if (input.skill === 'spec-review') {
    const module = new URL('../harness-runtime/src/workflow/spec-review.mjs', import.meta.url);
    const { validateSpecReviewAdmission } = await import(existsSync(module) ? module.href : new URL('../../src/workflow/spec-review.mjs', import.meta.url).href);
    await validateSpecReviewAdmission({ root, admission: input.context?.review_admission });
  }
  const binding = await resolveSkillBinding({ root, skill: input.skill, workflow: options['--workflow'], stage: options['--request-workflow'] ? undefined : options['--stage'] });
  const entry = [`.codex/internal-skills/${input.skill}/GUIDE.md`, `.agents/skills/${input.skill}/SKILL.md`, `.codex/skills/${input.skill}/SKILL.md`].find((path) => existsSync(join(root, path)));
  if (!entry) throw new Error(`Skill entrypoint missing: ${input.skill}`);
  const prefix = `runtime/executions/${input.execution_id}`;
  const target = async (path) => { try { await readSkillSessionJson({ root, session_directory: session, path }); throw new Error(`Execution output already exists: ${path}`); } catch (error) { if (error.code !== 'ENOENT') throw error; } return join(session, path); };
  const output = await target(`${prefix}/return.json`);
  const log = await target(`${prefix}/exec.stderr.json`);
  const schema = await target(`${prefix}/return.schema.json`);
  const returnSchema = JSON.parse(await readFile(join(root, '.codex/internal-skills/skill-execution/schemas/return.schema.json'), 'utf8'));
  returnSchema.properties.execution_id = { const: input.execution_id };
  returnSchema.properties.skill = { const: input.skill };
  returnSchema.properties.result_ref = { enum: [`${prefix}/result.json`, null] };
  await writeFile(schema, JSON.stringify(returnSchema, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await recordExecutionState({ root, input, binding, status: 'running' });
  lifecycle = { root, input, binding };
  let preparedWorkspace = null;
  if (input.skill === 'workflow-compose') {
    const module = new URL('../harness-runtime/src/workflow/composer-workspace.mjs', import.meta.url);
    const { prepareComposerWorkspace } = await import(existsSync(module) ? module.href : new URL('../../src/workflow/composer-workspace.mjs', import.meta.url).href);
    preparedWorkspace = await prepareComposerWorkspace({ root, session, input, inputPath });
  }
  if (!preparedWorkspace && input.context?.worktree_ref) {
    const reference = input.context.worktree_ref;
    if (!reference.endsWith('/worktree.json')) throw new Error('Invalid worktree reference');
    const directory = await resolveSkillSession(root, reference.slice(0, -'/worktree.json'.length));
    preparedWorkspace = await readSkillSessionJson({ root, session_directory: directory, path: 'worktree.json' });
    if (preparedWorkspace.state !== 'active') throw new Error('Worktree is not active');
  }
  const sharedBeads = join(input.shared_guidance_root, '.beads');
  const args = ['exec', '--sandbox', 'workspace-write', '--add-dir', session, ...(preparedWorkspace ? ['--add-dir', preparedWorkspace.workspace] : []), ...(existsSync(sharedBeads) ? ['--add-dir', sharedBeads] : []), '--cd', root, '--model', binding.model, '-c', `model_reasoning_effort=${JSON.stringify(binding.reasoning_effort)}`, '-c', 'approval_policy="never"', '--disable', 'multi_agent', '--output-schema', schema, '--output-last-message', output, '-'];
  const prompt = `Read ${join(root, entry)} and perform only the single task in ${join(session, inputPath)}. When input.context.role is provided, read .codex/agents/<role>.toml in the workspace and follow its developer instructions; the CLI model and effort remain authoritative. You are a dispatched worker, not the main orchestrator. Do not compose another workflow unless skill is workflow-compose. Do not spawn agents; return required subtasks to the caller. For each output declared in input.context.outputs, return exactly one result artifact with its id as kind when completed. Give other files distinct kinds or omit their kind. Write the detailed result JSON to the absolute path ${join(session, prefix, 'result.json')}; result_ref is the session-relative path ${prefix}/result.json. Resolve all session-relative paths against ${session}, not the workspace cwd. Then return only the common schema-constrained envelope. Do not write return.json yourself; codex exec owns it. For self-validation, write validation-envelope.json beside result.json and pass that session-relative file to validate-return. The final envelope status/code must exactly match result.json. All temporary output belongs in ${session}.`;
  const reviewPrompt = input.context?.review_admission ? ' Inspect every workspace file listed in input.context.review_admission.inputs, independently verify its hash, and return exactly that workspace-relative hash map in result.details.inputs with the admitted axis and ticket_id. Session evidence is separate and must not be added to that map.' : '';
  let stderr = '';
  const stop = () => child.kill('SIGTERM');
  const child = spawn('codex', args, { cwd: root, env: { ...process.env, HARNESS_SESSION_DIR: session, HARNESS_SKILL_EXECUTION_ID: input.execution_id }, stdio: ['pipe', 'ignore', 'pipe'] });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt + reviewPrompt);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  await writeFile(log, JSON.stringify({ exit_code: code, stderr, binding }), { flag: 'wx', mode: 0o600 });
  if (code !== 0) throw new Error(`codex exec failed (${code}); see ${log}`);
  const envelope = JSON.parse(await readFile(output, 'utf8'));
  await validateSkillReturn({ root, input, envelope });
  await recordExecutionState({ ...lifecycle, status: envelope.status, code: envelope.code, result_ref: envelope.result_ref });
  lifecycle = null;
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} catch (error) {
  if (lifecycle) { try { await recordExecutionState({ ...lifecycle, status: 'failed', code: 'EXECUTION_ERROR', reason: error.message }); } catch (recordError) { error.message += `; state recording failed: ${recordError.message}`; } }
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
