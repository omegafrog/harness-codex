#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
    if (!['--root', '--session-directory', '--input', '--workflow', '--stage', '--request-workflow', '--codex-session-id', '--answer', '--review-admission', '--subtask', '--subtask-result', '--resume-subtask', '--review-subtask', '--review-result', '--review-details'].includes(key) || !process.argv[i + 1] || options[key]) throw new Error(`Invalid argument: ${key}`);
    options[key] = process.argv[i + 1];
  }
  const root = options['--root'];
  if (!isAbsolute(root || '')) throw new Error('Absolute --root is required');
  if ((options['--subtask'] !== undefined || options['--subtask-result'] !== undefined || options['--resume-subtask'] !== undefined || options['--review-subtask'] !== undefined || options['--review-result'] !== undefined || options['--review-details'] !== undefined) && !options['--request-workflow']) throw new Error('Subtasks require a request workflow stage');
  if (options['--answer'] !== undefined && !options['--request-workflow']) throw new Error('Answer requires a request workflow stage');
  if (options['--review-details'] !== undefined && options['--review-details'] !== '1') throw new Error('Invalid review detail request');
  const session = await resolveSkillSession(root, options['--session-directory']);
  let inputPath = options['--input'];
  let inputSession = session;
  let userAnswer = null;
  if (options['--request-workflow']) {
    if (inputPath || options['--workflow'] || !options['--stage']) throw new Error('Select request workflow stage or explicit input, not both');
    const module = new URL('../harness-runtime/src/workflow/stage-input.mjs', import.meta.url);
    const { prepareStageInput } = await import(existsSync(module) ? module.href : new URL('../../src/workflow/stage-input.mjs', import.meta.url).href);
    const prepared = await prepareStageInput({ root, session, workflowRef: options['--request-workflow'], stageId: options['--stage'], codexSessionId: options['--codex-session-id'] || process.env.CODEX_THREAD_ID, answer: options['--answer'] ?? null, reviewAdmissionRef: options['--review-admission'], subtask: options['--subtask'] ?? null, subtaskResult: options['--subtask-result'] ?? null, resumeSubtask: options['--resume-subtask'] ?? null, reviewSubtask: options['--review-subtask'] ?? null, reviewResult: options['--review-result'] ?? null, reviewDetails: options['--review-details'] === '1' });
    if (prepared.waiting_for_answers) { process.stdout.write(`${JSON.stringify(prepared)}\n`); process.exit(0); }
    inputPath = prepared.path;
    inputSession = prepared.session_directory;
    userAnswer = prepared.answer ?? null;
  }
  const input = await readSkillSessionJson({ root, session_directory: inputSession, path: inputPath });
  if (input.workspace_root !== root || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.execution_id) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.skill)) throw new Error('Invalid execution input');
  await validateSkillInput({ root, input });
  const outputSession = await resolveSkillSession(root, input.session_directory);
  const controlSession = await resolveSkillSession(root, input.context?.control_session_directory || session);
  if (input.skill === 'spec-review') {
    const module = new URL('../harness-runtime/src/workflow/spec-review.mjs', import.meta.url);
    const { validateSpecReviewAdmission } = await import(existsSync(module) ? module.href : new URL('../../src/workflow/spec-review.mjs', import.meta.url).href);
    await validateSpecReviewAdmission({ root, admission: input.context?.review_admission });
  }
  if (input.skill === 'plan-review' && input.context?.plan_review_admission) {
    const module = new URL('../harness-runtime/src/workflow/plan-review.mjs', import.meta.url);
    const { validatePlanReviewAdmission } = await import(existsSync(module) ? module.href : new URL('../../src/workflow/plan-review.mjs', import.meta.url).href);
    await validatePlanReviewAdmission({ root, planSetId: input.context.plan_set_id, admission: input.context.plan_review_admission });
  }
  const binding = await resolveSkillBinding({ root, skill: input.skill, workflow: options['--workflow'], stage: options['--request-workflow'] ? undefined : options['--stage'] });
  const entry = [`.codex/internal-skills/${input.skill}/GUIDE.md`, `.agents/skills/${input.skill}/SKILL.md`, `.codex/skills/${input.skill}/SKILL.md`].find((path) => existsSync(join(root, path)));
  if (!entry) throw new Error(`Skill entrypoint missing: ${input.skill}`);
  const prefix = `runtime/executions/${input.execution_id}`;
  const target = async (directory, path) => { try { await readSkillSessionJson({ root, session_directory: directory, path }); throw new Error(`Execution output already exists: ${path}`); } catch (error) { if (error.code !== 'ENOENT') throw error; } return join(directory, path); };
  const output = await target(outputSession, `${prefix}/return.json`);
  const log = await target(outputSession, `${prefix}/exec.stderr.json`);
  const schema = await target(outputSession, `${prefix}/return.schema.json`);
  const returnSchema = JSON.parse(await readFile(join(root, '.codex/internal-skills/skill-execution/schemas/return.schema.json'), 'utf8'));
  returnSchema.properties.execution_id = { const: input.execution_id };
  returnSchema.properties.skill = { const: input.skill };
  returnSchema.properties.result_ref = { enum: [`${prefix}/result.json`, null] };
  returnSchema.properties.result = { type: 'string' };
  if (!returnSchema.required.includes('result')) returnSchema.required.push('result');
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
  let resumeSessionId = input.context?.resume_session_id || null;
  let worktreeRecord = preparedWorkspace;
  if (!worktreeRecord && input.context?.worktree_ref) worktreeRecord = JSON.parse(await readFile(input.context.worktree_ref, 'utf8'));
  const reviewAttempt = input.context?.review_admission?.attempt_id || input.context?.plan_review_admission?.attempt_id;
  const sessionKey = input.context?.parent_stage_id
    ? `stage:${input.context.parent_stage_id}:subtask:${input.context.subtask_index ?? (input.context.reviewed_execution_id ? `review-${input.context.reviewed_execution_id}` : `skill-${input.skill}`)}`
    : `stage:${input.context?.stage_id || input.execution_id}${reviewAttempt ? `:attempt:${reviewAttempt}` : ''}`;
  if (worktreeRecord && !resumeSessionId) resumeSessionId = worktreeRecord.agent_sessions?.[sessionKey]?.session_id || null;
  let worktreeManager = null;
  if (worktreeRecord) {
    worktreeManager = await import(existsSync(installed) ? new URL('../harness-runtime/src/workflow/worktrees.mjs', import.meta.url).href : new URL('../../src/workflow/worktrees.mjs', import.meta.url).href);
    if (input.context?.codex_session_id) await worktreeManager.recordWorkflowSession({ workspace_root: worktreeRecord.workspace, repository_root: worktreeRecord.return_root, key: 'orchestrator', session_id: input.context.codex_session_id, execution_id: input.execution_id });
  }
  const sharedBeads = join(input.shared_guidance_root, '.beads');
  const sharedRoot = await realpath(input.shared_guidance_root);
  const workspaceRoot = await realpath(root);
  const outputDirectories = [...new Set([outputSession, controlSession, ...(preparedWorkspace ? [preparedWorkspace.workspace, preparedWorkspace.session_directory] : []), ...(sharedRoot !== workspaceRoot ? [sharedRoot] : []), ...(existsSync(sharedBeads) ? [sharedBeads] : [])])];
  const args = ['exec', '--sandbox', 'workspace-write', ...outputDirectories.flatMap((directory) => ['--add-dir', directory]), '--cd', root, '--model', binding.model, '-c', `model_reasoning_effort=${JSON.stringify(binding.reasoning_effort)}`, '-c', 'approval_policy="never"', '--disable', 'multi_agent', '--json', '--output-schema', schema, '--output-last-message', output, ...(resumeSessionId ? ['resume', resumeSessionId, '-'] : ['-'])];
  const answerPath = userAnswer ? join(outputSession, prefix, 'answers.json') : null;
  if (answerPath) await writeFile(answerPath, JSON.stringify(userAnswer, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const prompt = `Read ${join(root, entry)}. Input: ${join(inputSession, inputPath)}. Output: ${output}.${answerPath ? ` Answers: ${answerPath}.` : ''} Read only the input fields and referenced artifacts needed for this task. User-facing questions and workflow Markdown must be in Korean. When input.context.role is provided, read .codex/agents/<role>.toml and follow its instructions; the CLI model and effort remain authoritative. You are a dispatched worker, not the main orchestrator. Do not spawn agents; return required subtasks to the caller. For each declared output, return exactly one artifact with its id as kind when completed. Use HARNESS_SESSION_DIR for temporary files. Return envelope.result as a JSON-serialized complete result object with schema_version, execution_id, skill, status, code, summary, artifacts, and details; its execution_id, skill, status, and code must match the outer envelope. The runner parses and validates this string.`;
  const reviewPrompt = (input.context?.review_admission || input.context?.plan_review_admission ? ' Follow the admission review_delta: for an initial review or missing delta inspect all inputs; for an incremental review inspect changed sections, unresolved findings, and directly affected relationships. Verify changed files against their admitted hashes and return the complete admitted workspace hash map in result.details.inputs. Session evidence is separate and must not be added to that map.' : '') + (input.context?.review_details_requested ? ' Continue your previous session. Return REVIEW_REQUIRED with details.review_request containing skill, role, purpose and context with actual reviewer inputs and targets. Preserve existing evidence and uncertainty; do not invent approvals or user claims. Include the files the reviewer needs in result.artifacts. If required reviewer inputs are unavailable, return the relevant question or blocked status.' : '') + (input.context?.review_result ? ' Use the inline validated review result at input.context.review_result, address its findings, and continue your previous session. Do not infer approval from the existence of a review.' : '') + (input.context?.review_context ? ' The caller supplied reviewer inputs in input.context.review_context; apply the review skill gates and return findings with evidence.' : '') + (input.context?.target_result ? ' Review the inline target result at input.context.target_result and its referenced artifacts; do not read a result.json file.' : '') + ' When returning USER_DECISION_REQUIRED, include result.details.question as an object matching .codex/internal-skills/skill-execution/schemas/question.schema.json, including question_id, question, options, recommended_option_id, and rationale. When returning REVIEW_REQUIRED, include details.review_request with the registered skill, role, purpose and context required for an independent review, and return the review target as an artifact.';
  let stderr = '', stdoutBuffer = '', threadId = null, sessionSave = Promise.resolve();
  const codexErrors = [];
  const consumeEvent = (line) => { try { const event = JSON.parse(line); if (event.type === 'error' || event.type === 'turn.failed') codexErrors.push(event); if (event.type === 'thread.started') { threadId = event.thread_id; if (worktreeManager) sessionSave = sessionSave.then(() => worktreeManager.recordWorkflowSession({ workspace_root: worktreeRecord.workspace, repository_root: worktreeRecord.return_root, key: sessionKey, session_id: threadId, execution_id: input.execution_id })); } } catch {} };
  const stop = () => child.kill('SIGTERM');
  const child = spawn('codex', args, { cwd: root, env: { ...process.env, HARNESS_SESSION_DIR: outputSession, HARNESS_CONTROL_SESSION_DIR: controlSession, HARNESS_SKILL_EXECUTION_ID: input.execution_id }, stdio: ['pipe', 'pipe', 'pipe'] });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdout.on('data', (data) => { stdoutBuffer += data; const lines = stdoutBuffer.split('\n'); stdoutBuffer = lines.pop(); for (const line of lines) consumeEvent(line); });
  child.stdin.on('error', () => {});
  const checklistPrompt = input.context?.review_checklist ? ' In your architecture_review report, include exactly one Markdown checkbox line for each decision ID in input.context.review_checklist.decision_ids and each criterion requirements, targets, alternatives, tradeoffs, evidence, boundary, answered_objections, formatted as "- [x] AD-001 / requirements — evidence and location" or "- [ ] AD-001 / evidence — unresolved reason". Mark checked only for a proven pass. For re-review read the previous review checklist first, carry forward unaffected checked items without rereading them, and review only changed sections, directly affected relationships, and unchecked items. If earlier proof or impact is unclear, reopen the affected item. Include the report even when asking a question. Do not infer approval.' : '';
  child.stdin.end(prompt + reviewPrompt + checklistPrompt);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  if (stdoutBuffer) consumeEvent(stdoutBuffer);
  await sessionSave;
  if (threadId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) throw new Error('Invalid Codex session ID');
  if (worktreeRecord && !threadId) throw new Error('Codex session ID missing for worktree execution');
  await writeFile(log, JSON.stringify({ exit_code: code, stderr, codex_errors: codexErrors, binding, thread_id: threadId }), { flag: 'wx', mode: 0o600 });
  if (code !== 0) throw new Error(`codex exec failed (${code}); see ${log}`);
  const envelope = JSON.parse(await readFile(output, 'utf8'));
  if (typeof envelope.result !== 'string') throw new Error('Codex result must be a JSON string');
  envelope.result = JSON.parse(envelope.result);
  if (resumeSessionId && threadId !== resumeSessionId) throw new Error('Resumed Codex session ID mismatch');
  if (!envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) throw new Error('Codex result must be a structured object');
  if (Array.isArray(envelope.result?.details?.questions)) {
    if (envelope.code !== 'REVIEW_REQUIRED') throw new Error('Questions require REVIEW_REQUIRED');
    const module = new URL('../harness-runtime/src/workflow/questions.mjs', import.meta.url);
    const { identifyQuestions } = await import(existsSync(module) ? module.href : new URL('../../src/workflow/questions.mjs', import.meta.url).href);
    const questions = identifyQuestions(input.execution_id, envelope.result.details.questions);
    await writeFile(join(outputSession, prefix, 'questions.json'), JSON.stringify(questions, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    envelope.result.details.questions = questions;
  }
  if (envelope.result) {
    const resultPath = join(outputSession, `${prefix}/result.json`);
    try {
      if (!isDeepStrictEqual(JSON.parse(await readFile(resultPath, 'utf8')), envelope.result)) throw new Error('Worker result file differs from its session response');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(resultPath, JSON.stringify(envelope.result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    if (envelope.result_ref === null && !(envelope.status === 'failed' && envelope.code === 'ARTIFACT_WRITE_FAILED')) envelope.result_ref = `${prefix}/result.json`;
  }
  await writeFile(output, JSON.stringify(envelope, null, 2) + '\n', { mode: 0o600 });
  if (envelope.code === 'USER_DECISION_REQUIRED' && !threadId) throw new Error('Codex session ID missing for pending question');
  if (threadId && worktreeRecord) {
    await worktreeManager.recordWorkflowSession({ workspace_root: worktreeRecord.workspace, repository_root: worktreeRecord.return_root, key: sessionKey, session_id: threadId, execution_id: input.execution_id });
  }
  await validateSkillReturn({ root, input, envelope });
  await recordExecutionState({ ...lifecycle, status: envelope.status, code: envelope.code, result_ref: envelope.result_ref });
  lifecycle = null;
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} catch (error) {
  if (lifecycle) { try { await recordExecutionState({ ...lifecycle, status: 'failed', code: 'EXECUTION_ERROR', reason: error.message }); } catch (recordError) { error.message += `; state recording failed: ${recordError.message}`; } }
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
