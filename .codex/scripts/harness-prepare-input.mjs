#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
const base = new URL('../../.harness/src/workflow/', import.meta.url);
const { prepareStageInput, resolveStageSkill } = await import(new URL('stage-input.mjs', base));
const { parseWorktreeRecord } = await import(new URL('worktrees.mjs', base));
const { resolveSkillSession, readSkillSessionJson, readExecutionInput } = await import(new URL('skill-execution.mjs', base));
const { readSkillDeclaration } = await import(new URL('skill-declaration.mjs', base));
try {
  const allowed = new Set(['worktree-ref', 'stage-id', 'answer', 'feedback', 'review-admission-ref', 'publication-approved', 'spec-overwrite-approved', 'restart', 'user-revision', 'plan', 'repair-receipt', 'approval-answer', 'e2e-request', 'test-defect-failure']);
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.replace(/^--/, '');
    if (!process.argv[i]?.startsWith('--') || !allowed.has(key) || !process.argv[i + 1] || Object.hasOwn(options, key)) throw new Error(`Invalid argument: ${process.argv[i]}`);
    options[key] = process.argv[i + 1];
  }
  const commandContext = (await import(new URL('../../.harness/src/workflow/cli-context.mjs', import.meta.url).href)).resolveCommandContext({ worktreeRef: options['worktree-ref'] });
  options['worktree-ref'] = commandContext.worktree_ref ?? options['worktree-ref'];
  if (!isAbsolute(options['worktree-ref'] || '') || basename(options['worktree-ref']) !== 'worktree.json' || !options['stage-id']) throw new Error('Absolute worktree-ref and stage-id are required');
  const repository = await realpath(commandContext.root);
  const stage = await resolveStageSkill({ root: repository, stageId: options['stage-id'] });
  const stageSkill = await readSkillDeclaration({ root: repository, skill: stage.skill }).catch((error) => { throw new Error(`${error.message}; --stage-id must select a registered sub-agent skill`); });
  if (stageSkill.main_session) throw new Error(`${stage.skill} runs in the main session; --stage-id must select a sub-agent skill`);
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
  // Codex stages need the trusted Harness subagent hook to record native reviewer identity.
  const { parseYaml } = await import(new URL('../eval/yaml.mjs', base));
  const stageProvider = record.agent_sessions?.orchestrator?.provider || record.workflow_binding?.provider || parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8')).agents?.provider || 'codex';
  if (stageProvider === 'codex') {
    const { inspectCodexHookTrust } = await import(new URL('providers/codex.mjs', base));
    const trust = await inspectCodexHookTrust();
    if (!trust.trusted) throw new Error(`PERMISSION_REQUIRED: the Harness subagent hook in ${trust.hooks_path} is ${trust.missing.length ? 'missing; run setup with the codex provider' : 'not trusted; open Codex, run /hooks and trust "Recording Harness subagent" for SubagentStart and SubagentStop'}. Stages do not start without it.`);
  }
  const recordedOrchestrator = record.agent_sessions?.orchestrator;
  const orchestrator = recordedOrchestrator ? { ...recordedOrchestrator, provider: recordedOrchestrator.provider || 'codex' } : state.orchestrator_session_id ? { session_id: state.orchestrator_session_id, provider: state.orchestrator_provider || 'codex' } : state.codex_session_id ? { session_id: state.codex_session_id, provider: 'codex' } : null;
  const codexSessionId = orchestrator?.provider === 'codex' ? orchestrator.session_id : null;
  if (options['publication-approved'] !== undefined && options['publication-approved'] !== 'true') throw new Error('publication-approved must be true');
  if (options['spec-overwrite-approved'] !== undefined && options['spec-overwrite-approved'] !== 'true') throw new Error('spec-overwrite-approved must be true');
  if (options.restart !== undefined && options.restart !== 'true') throw new Error('restart must be true');
  if (options['user-revision'] !== undefined && options['user-revision'] !== 'true') throw new Error('user-revision must be true');
  const prepared = await prepareStageInput({ root, session, worktreeRef, workflowRef, stageId: options['stage-id'], codexSessionId, orchestratorSession: orchestrator, answer: options.answer ?? null, feedback: options.feedback ?? null, userRevision: options['user-revision'] === 'true', planId: options.plan ?? null, repairReceipt: options['repair-receipt'] ?? null, approvalAnswer: options['approval-answer'] ?? null, e2eRequest: options['e2e-request'] ?? null, testDefectFailure: options['test-defect-failure'] ?? null, reviewAdmissionRef: options['review-admission-ref'] ?? null, publicationApproved: options['publication-approved'] === 'true', specOverwriteApproved: options['spec-overwrite-approved'] === 'true', restart: options.restart === 'true' });
  process.stdout.write(`${JSON.stringify(prepared)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
}
