#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
let sourceCheckout = false;
try { sourceCheckout = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).name === '@omegafrog/harness-codex'; } catch {}
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
const installed = new URL('../harness-runtime/src/workflow/stage-input.mjs', import.meta.url);
const base = existsSync(installed) && !sourceCheckout ? new URL('../harness-runtime/src/workflow/', import.meta.url) : new URL('../../src/workflow/', import.meta.url);
const { prepareStageInput } = await import(new URL('stage-input.mjs', base));
const { parseWorktreeRecord } = await import(new URL('worktrees.mjs', base));
const { resolveSkillSession, readSkillSessionJson, readExecutionInput } = await import(new URL('skill-execution.mjs', base));
try {
  const allowed = new Set(['worktree-ref', 'workflow-ref', 'stage-id', 'answer', 'review-admission-ref', 'subtask', 'subtask-result', 'resume-subtask', 'review-subtask', 'review-result', 'review-details']);
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, '');
    if (!process.argv[i]?.startsWith('--') || !allowed.has(key) || !process.argv[i + 1] || Object.hasOwn(options, key)) throw new Error(`Invalid argument: ${process.argv[i]}`);
    options[key] = process.argv[i + 1];
  }
  if (!isAbsolute(options['worktree-ref'] || '') || basename(options['worktree-ref']) !== 'worktree.json' || !isAbsolute(options['workflow-ref'] || '') || !options['stage-id']) throw new Error('Absolute worktree-ref and workflow-ref, and stage-id are required');
  const repository = await realpath(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
  const preparedWorkspace = await realpath(dirname(dirname(options['worktree-ref'])));
  if (repository !== preparedWorkspace) throw new Error('Stage dispatch requires running from the prepared worktree; open a new Codex session in that directory');
  const workflowPath = options['workflow-ref'];
  const session = await resolveSkillSession(repository, dirname(dirname(dirname(workflowPath))));
  const workflowRef = relative(session, workflowPath);
  if (workflowRef !== 'runtime/orchestrator/workflow.json') throw new Error('Workflow reference must identify the canonical workflow');
  const workflow = await readSkillSessionJson({ root: repository, session_directory: session, path: workflowRef });
  const state = workflow.state || await readSkillSessionJson({ root: repository, session_directory: session, path: 'runtime/orchestrator/state.json' });
  if (state.workflow_ref !== workflowRef) throw new Error('Workflow state/reference mismatch');
  const composer = state.stages?.['workflow-compose'];
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(composer?.execution_id || '') || !composer.result_ref) throw new Error('Workflow composition record is missing');
  const input = await readExecutionInput({ root: repository, execution_id: composer.execution_id });
  const result = await readSkillSessionJson({ root: repository, session_directory: session, path: composer.result_ref });
  const worktreeRef = options['worktree-ref'];
  if ((input.context?.worktree_ref || result.worktree_ref) !== worktreeRef) throw new Error('Worktree reference does not match workflow');
  await resolveSkillSession(repository, dirname(worktreeRef));
  const info = await lstat(worktreeRef);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Worktree record must be a regular file');
  const record = parseWorktreeRecord(await readFile(worktreeRef, 'utf8'));
  const root = await realpath(record.workspace);
  if (repository !== root) throw new Error('Stage dispatch requires running from the prepared worktree; open a new Codex session in that directory');
  const worktreeSession = await resolveSkillSession(root, record.session_directory);
  if (record.state !== 'active' || worktreeRef !== join(worktreeSession, 'worktree.json')) throw new Error('Worktree record is not active or canonical');
  await resolveSkillSession(root, session);
  const codexSessionId = record.agent_sessions?.orchestrator?.session_id || state.codex_session_id || null;
  if (options['review-details'] && options['review-details'] !== '1') throw new Error('Invalid review detail request');
  const prepared = await prepareStageInput({ root, session, worktreeRef, workflowRef, stageId: options['stage-id'], codexSessionId, answer: options.answer ?? null, reviewAdmissionRef: options['review-admission-ref'] ?? null, subtask: options.subtask ?? null, subtaskResult: options['subtask-result'] ?? null, resumeSubtask: options['resume-subtask'] ?? null, reviewSubtask: options['review-subtask'] ?? null, reviewResult: options['review-result'] ?? null, reviewDetails: options['review-details'] === '1' });
  process.stdout.write(`${JSON.stringify(prepared)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
}
