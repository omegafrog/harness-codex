#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
const base = new URL('../../.harness/src/workflow/', import.meta.url);
const { prepareStageInput } = await import(new URL('stage-input.mjs', base));
const { parseWorktreeRecord } = await import(new URL('worktrees.mjs', base));
const { resolveSkillSession, readSkillSessionJson, readExecutionInput } = await import(new URL('skill-execution.mjs', base));
try {
  const allowed = new Set(['worktree-ref', 'stage-id', 'answer', 'feedback', 'review-admission-ref', 'publication-approved']);
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, '');
    if (!process.argv[i]?.startsWith('--') || !allowed.has(key) || !process.argv[i + 1] || Object.hasOwn(options, key)) throw new Error(`Invalid argument: ${process.argv[i]}`);
    options[key] = process.argv[i + 1];
  }
  if (!isAbsolute(options['worktree-ref'] || '') || basename(options['worktree-ref']) !== 'worktree.json' || !options['stage-id']) throw new Error('Absolute worktree-ref and stage-id are required');
  const repository = await realpath((await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })).stdout.trim());
  const bindings = JSON.parse(await readFile(join(repository, '.codex/internal-skills/skill-execution/bindings.json'), 'utf8'));
  if (!Object.hasOwn(bindings.skills, options['stage-id'])) throw new Error(`Unregistered skill: ${options['stage-id']}; --stage-id must be the selected skill name`);
  const session = await resolveSkillSession(repository, dirname(options['worktree-ref']));
  const workflowRef = null;
  const state = await readSkillSessionJson({ root: repository, session_directory: session, path: 'runtime/orchestrator/state.json' });
  const composer = state.stages?.['workflow-compose'];
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(composer?.execution_id || '') || composer.status !== 'completed' || composer.code !== 'OK') throw new Error('Workflow composition record is missing');
  const input = await readExecutionInput({ root: repository, execution_id: composer.execution_id });
  const worktreeRef = options['worktree-ref'];
  if (input.context?.worktree_ref !== worktreeRef) throw new Error('Worktree reference does not match workflow');
  await resolveSkillSession(repository, dirname(worktreeRef));
  const info = await lstat(worktreeRef);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Worktree record must be a regular file');
  const record = parseWorktreeRecord(await readFile(worktreeRef, 'utf8'));
  const root = await realpath(record.workspace);
  const worktreeSession = await resolveSkillSession(root, record.session_directory);
  if (record.state !== 'active' || worktreeRef !== join(worktreeSession, 'worktree.json')) throw new Error('Worktree record is not active or canonical');
  await resolveSkillSession(root, session);
  const codexSessionId = record.agent_sessions?.orchestrator?.session_id || state.codex_session_id || null;
  if (options['publication-approved'] !== undefined && options['publication-approved'] !== 'true') throw new Error('publication-approved must be true');
  const prepared = await prepareStageInput({ root, session, worktreeRef, workflowRef, stageId: options['stage-id'], codexSessionId, answer: options.answer ?? null, feedback: options.feedback ?? null, reviewAdmissionRef: options['review-admission-ref'] ?? null, publicationApproved: options['publication-approved'] === 'true' });
  process.stdout.write(`${JSON.stringify(prepared)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
}
