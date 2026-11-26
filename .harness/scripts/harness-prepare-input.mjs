#!/usr/bin/env node
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
const base = new URL('../../.harness/src/workflow/', import.meta.url);
const { prepareStageInput, resolveStageSkill } = await import(new URL('stage-input.mjs', base));
const { parseWorktreeRecord } = await import(new URL('worktrees.mjs', base));
const { resolveSkillSession, readSkillSessionJson, readExecutionInput } = await import(new URL('stage-runtime.mjs', base));
const { readSkillDeclaration } = await import(new URL('skill-declaration.mjs', base));
const { TAKEOVER_FEEDBACK, compactPrepared, extractVerbose, launchAttemptDirectory, launchCommand, stageAfter, writeError } = await import(new URL('stage-cli.mjs', base));
const { sessionOutputPath } = await import(new URL('session-output.mjs', base));
const PREPARE_OPTIONS = ['worktree-ref', 'stage-id', 'answer', 'feedback', 'review-admission-ref', 'publication-approved', 'requirements-approved', 'design-approved', 'restart', 'restart-requirements', 'discard-out-of-order', 'take-over-interrupted', 'user-revision', 'plan', 'repair-receipt', 'approval-answer', 'e2e-request', 'test-defect-failure', 'reopen-for', 'stage-binding'];
if (['--help', '-h'].includes(process.argv[2])) { process.stdout.write(`Usage: node .harness/scripts/harness-prepare-input.mjs --stage-id STAGE [--<option> VALUE ...] [--verbose] (run inside the workflow worktree)\nOptions: ${PREPARE_OPTIONS.map((o) => `--${o}`).join(' ')}\nEach option takes one value. Prefer harness-native-stage.mjs launch, which accepts the same options.\n`); process.exit(0); }
// What the error output needs to know about this call.
const errorContext = { script: 'prepare', stageId: undefined, root: undefined, mode: null };
try {
  const { args: rawArgs, verbose } = extractVerbose(process.argv.slice(2));
  const allowed = new Set(PREPARE_OPTIONS);
  const options = {};
  for (let i = 0; i < rawArgs.length; i += 2) {
    const key = rawArgs[i]?.replace(/^--/, '');
    if (!rawArgs[i]?.startsWith('--') || !allowed.has(key) || !rawArgs[i + 1] || Object.hasOwn(options, key)) throw new Error(`Invalid argument: ${rawArgs[i]}`);
    options[key] = rawArgs[i + 1];
  }
  errorContext.stageId = options['stage-id'];
  errorContext.mode = options['restart-requirements'] !== undefined ? 'restart' : options['discard-out-of-order'] !== undefined ? 'discard' : options['take-over-interrupted'] !== undefined ? 'takeover' : null;
  const commandContext = (await import(new URL('../../.harness/src/workflow/cli-context.mjs', import.meta.url).href)).resolveCommandContext({ worktreeRef: options['worktree-ref'] });
  options['worktree-ref'] = commandContext.worktree_ref ?? options['worktree-ref'];
  if (!isAbsolute(options['worktree-ref'] || '') || basename(options['worktree-ref']) !== 'worktree.json' || !options['stage-id']) throw new Error('Absolute worktree-ref and stage-id are required');
  const repository = await realpath(commandContext.root);
  errorContext.root = repository;
  if (!(options['stage-id'] === 'spec-me' && options['discard-out-of-order'] === 'true')) {
    const stage = await resolveStageSkill({ root: repository, stageId: options['stage-id'] });
    const stageSkill = await readSkillDeclaration({ root: repository, skill: stage.skill }).catch((error) => { throw new Error(`${error.message}; --stage-id must select a registered sub-agent skill`); });
    if (stageSkill.main_session) throw new Error(`${stage.skill} runs in the main session; --stage-id must select a sub-agent skill`);
  }
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
  // Codex stages need the trusted Harness subagent hook to record native reviewer identity.
  const assertCodexHookTrusted = async (callerProvider = null) => {
    const { parseYaml } = await import(new URL('../eval/yaml.mjs', base));
    const provider = callerProvider || record.agent_sessions?.orchestrator?.provider || record.workflow_binding?.provider || parseYaml(await readFile(join(root, '.harness/harness.yaml'), 'utf8')).agents?.provider || 'codex';
    if (provider === 'codex') {
      const { inspectCodexHookTrust } = await import('../../.codex/harness/providers/codex.mjs');
      const trust = await inspectCodexHookTrust();
      if (!trust.trusted) throw new Error(`PERMISSION_REQUIRED: the Harness subagent hook in ${trust.hooks_path} is ${trust.missing.length ? 'missing; run setup with the codex provider' : 'not trusted; open Codex, run /hooks and trust "Recording Harness subagent" for SubagentStart and SubagentStop'}. Stages do not start without it.`);
    }
    return provider;
  };
  const { parseWorkflowBinding, modelBelongsToProvider } = await import(new URL('providers/index.mjs', base));
  let requestedStageBinding;
  try { requestedStageBinding = parseWorkflowBinding(options['stage-binding']); }
  catch { throw new Error('Invalid argument: --stage-binding must be JSON with provider, model and reasoning_effort'); }
  const assertRequestedProvider = (provider) => {
    if (requestedStageBinding && (requestedStageBinding.provider !== provider || !modelBelongsToProvider(provider, requestedStageBinding.model))) throw new Error('Execution provider must match the requested stage binding');
  };
  if (options['restart-requirements'] !== undefined) {
    if (options['restart-requirements'] !== 'true' || Object.keys(options).some((key) => !['worktree-ref', 'stage-id', 'restart-requirements'].includes(key))) throw new Error('Requirements restart must be requested alone');
    const { restartRequirements } = await import(new URL('requirements-restart.mjs', base));
    const restarted = await restartRequirements({ root, session: worktreeSession, stageId: options['stage-id'] });
    process.stdout.write(`${JSON.stringify({ ...restarted, next: `Keep the backup. Prepare the restarted stage the normal way: ${launchCommand(options['stage-id'])}; stop at the point the user named.` })}\n`);
    process.exit(0);
  }
  if (options['discard-out-of-order'] !== undefined) {
    if (options['discard-out-of-order'] !== 'true' || Object.keys(options).some((key) => !['worktree-ref', 'stage-id', 'discard-out-of-order'].includes(key))) throw new Error('Discarding an out-of-order stage must be requested alone');
    const { discardOutOfOrderStage } = await import(new URL('requirements-restart.mjs', base));
    const discarded = await discardOutOfOrderStage({ root, session: worktreeSession, stageId: options['stage-id'] });
    const following = stageAfter(discarded.previous_stage);
    process.stdout.write(`${JSON.stringify({ ...discarded, next: following ? `The flow returned to ${discarded.previous_stage}. Continue with the stage that follows it: ${launchCommand(following)}` : `The flow returned to ${discarded.previous_stage}. Continue per the orchestrator skill.` })}\n`);
    process.exit(0);
  }
  if (options['take-over-interrupted'] !== undefined) {
    if (options['take-over-interrupted'] !== 'true' || Object.keys(options).some((key) => !['worktree-ref', 'stage-id', 'take-over-interrupted', 'stage-binding'].includes(key))) throw new Error('Taking over an interrupted stage must be requested alone');
    const { takeOverInterruptedStage, callerIdentity } = await import(new URL('stage-takeover.mjs', base));
    // The caller (Codex or Claude Code) becomes the orchestrator, so its provider decides the hook trust and the binding.
    const caller = await callerIdentity(root);
    assertRequestedProvider(await assertCodexHookTrusted(caller.provider || undefined));
    const taken = await takeOverInterruptedStage({ root, session: worktreeSession, stageId: options['stage-id'], ...caller });
    const requestedArgs = requestedStageBinding ? ` --stage-binding '${JSON.stringify(requestedStageBinding)}'` : '';
    process.stdout.write(`${JSON.stringify({ ...taken, next: `The interrupted run is recorded and this conversation is the orchestrator now. Start the stage again with a fresh execution: ${launchCommand(options['stage-id'], `${taken.plan_id ? `--plan ${taken.plan_id} ` : ''}--feedback '${TAKEOVER_FEEDBACK}'${requestedArgs}`)}` })}\n`);
    process.exit(0);
  }
  await resolveSkillSession(root, session);
  assertRequestedProvider(await assertCodexHookTrusted());
  const recordedOrchestrator = record.agent_sessions?.orchestrator;
  const orchestrator = recordedOrchestrator ? { ...recordedOrchestrator, provider: recordedOrchestrator.provider || 'codex' } : state.orchestrator_session_id ? { session_id: state.orchestrator_session_id, provider: state.orchestrator_provider || 'codex' } : state.codex_session_id ? { session_id: state.codex_session_id, provider: 'codex' } : null;
  const codexSessionId = orchestrator?.provider === 'codex' ? orchestrator.session_id : null;
  if (options['publication-approved'] !== undefined && options['publication-approved'] !== 'true') throw new Error('publication-approved must be true');
  if (options['requirements-approved'] !== undefined && options['requirements-approved'] !== 'true') throw new Error('requirements-approved must be true');
  if (options['design-approved'] !== undefined && options['design-approved'] !== 'true') throw new Error('design-approved must be true');
  if (options.restart !== undefined && options.restart !== 'true') throw new Error('restart must be true');
  if (options['user-revision'] !== undefined && options['user-revision'] !== 'true') throw new Error('user-revision must be true');
  const prepared = await prepareStageInput({ root, session, worktreeRef, workflowRef, stageId: options['stage-id'], codexSessionId, orchestratorSession: orchestrator, answer: options.answer ?? null, feedback: options.feedback ?? null, userRevision: options['user-revision'] === 'true', planId: options.plan ?? null, repairReceipt: options['repair-receipt'] ?? null, approvalAnswer: options['approval-answer'] ?? null, e2eRequest: options['e2e-request'] ?? null, testDefectFailure: options['test-defect-failure'] ?? null, reviewAdmissionRef: options['review-admission-ref'] ?? null, designApproved: options['design-approved'] === 'true', publicationApproved: options['publication-approved'] === 'true', requirementsApproved: options['requirements-approved'] === 'true', restart: options.restart === 'true', reopenFor: options['reopen-for'] ?? null, requestedStageBinding });
  const attemptId = process.env.HARNESS_NATIVE_LAUNCH_ATTEMPT_ID;
  if (attemptId && prepared.input?.execution_id) {
    // This receipt is independent of stdout. Record it only after prepare's inputs and support files are ready.
    try {
      const path = sessionOutputPath(root, `${launchAttemptDirectory(attemptId)}/prepared.json`);
      await writeFile(path, `${JSON.stringify({ execution_id: prepared.input.execution_id })}\n`, { flag: 'wx', mode: 0o600 });
    } catch { /* A receipt write must not prevent delivery of the normal result. */ }
  }
  process.stdout.write(`${JSON.stringify(verbose ? prepared : compactPrepared(prepared))}\n`);
} catch (error) {
  writeError(process.stderr, error, errorContext);
  process.exitCode = 1;
}
