#!/usr/bin/env node
// Current workflow: worktree, plan set, stage states, plans with their Issues, and the latest
// result of each stage. Use it instead of reading worktree.json, state.json or result files one by one.
//   node .codex/scripts/harness-context.mjs [--root DIR | --worktree-ref FILE] [--entry] [--verbose]
// By default finished stages are one short entry and empty fields are left out; --verbose prints everything, indented.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const { resolveCommandContext, orchestratorState, lastOrchestratorTurn } = await import(new URL('../../.harness/src/workflow/cli-context.mjs', import.meta.url).href);
const { compactContext, extractVerbose, finishNext, foreignRunningStage, launchCommand, takeoverStep } = await import(new URL('../../.harness/src/workflow/stage-cli.mjs', import.meta.url).href);
const { staleStages } = await import(new URL('../../.harness/src/workflow/stage-reopen.mjs', import.meta.url).href);
const read = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
try {
  const entryMode = process.argv.includes('--entry');
  const { args, verbose } = extractVerbose(process.argv.slice(2).filter((arg) => arg !== '--entry'));
  if (args.length && (entryMode || !['--root', '--worktree-ref'].includes(args[0]) || !args[1] || args.length > 2)) throw new Error('Usage: harness-context.mjs [--entry | --root DIR | --worktree-ref FILE] [--verbose]');
  if (entryMode && process.env.HARNESS_STAGE_EXECUTION_ID) throw new Error('Workflow entry requires the main orchestrator session');
  const output = (value) => process.stdout.write(`${JSON.stringify(value, null, verbose ? 2 : undefined)}\n`);
  const ctx = resolveCommandContext(args[0] === '--worktree-ref' ? { worktreeRef: args[1] } : { root: args[1] });
  let routing = null;
  if (entryMode) {
    const startup = await import(new URL('../../.harness/src/workflow/startup-state.mjs', import.meta.url));
    const { runtimeAgentProvider } = await import(new URL('../../.harness/src/workflow/agent-config.mjs', import.meta.url));
    const provider = runtimeAgentProvider() || 'codex';
    let sessionId = null;
    if (provider === 'codex' && process.env.CODEX_THREAD_ID) {
      const { findRollout } = await import(new URL('../../.harness/src/workflow/providers/codex.mjs', import.meta.url));
      const { readRolloutMetadata } = await import(new URL('../../.harness/src/workflow/native-context.mjs', import.meta.url));
      const { realpath } = await import('node:fs/promises');
      const transcript = await findRollout(join(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex'), 'sessions'), process.env.CODEX_THREAD_ID);
      const metadata = transcript && await readRolloutMetadata(transcript);
      let cwd = metadata?.cwd;
      if (transcript && metadata?.id === process.env.CODEX_THREAD_ID && !metadata.parent_thread_id && !metadata.source?.subagent) {
        const lines = (await (await import('node:fs/promises')).readFile(transcript, 'utf8')).split('\n');
        for (const line of lines) { try { const row = JSON.parse(line); if (row.type === 'turn_context' && typeof row.payload?.cwd === 'string') cwd = row.payload.cwd; } catch { /* Ignore incomplete final line. */ } }
        if (cwd === await realpath(ctx.root)) sessionId = metadata.id;
      }
    }
    if (provider === 'claude-code') sessionId = await startup.currentClaudeSession(ctx.root);
    let observed;
    try { observed = await startup.inspectStartupState({ workspaceRoot: ctx.root, sessionId, provider }); }
    catch (error) {
      try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ctx.root, stdio: 'ignore' }); observed = { decision_hint: 'inspect_required', issues: [{ reason: error.message }] }; }
      catch { observed = { decision_hint: 'setup_candidate', issues: [], matching_workflow_count: 0 }; }
    }
    const target = startup.orchestratorInputTarget(observed);
    observed.input_worktree_ref = target?.record_path || null;
    observed.input_routing = target ? 'local' : 'unbound';
    if (target && ctx.is_linked_worktree && sessionId) await startup.bindOrchestratorSession({ root: ctx.root, provider, sessionId });
    if (observed.decision_hint === 'compose_candidate') {
      const { inspectSetupConfiguration } = await import(new URL('../../.harness/src/workflow/project-readiness.mjs', import.meta.url));
      observed.setup_configuration = await inspectSetupConfiguration({ workspace_root: ctx.root, provider });
      if (observed.setup_configuration.status === 'setup_required') observed.decision_hint = 'setup_candidate';
    }
    const progress = await startup.refreshWorkflowProgress(observed, 'entry');
    const candidates = provider === 'claude-code' ? ['.claude/skills/orchestrator/SKILL.md', '.agents/skills/orchestrator/SKILL.md', '.codex/skills/orchestrator/SKILL.md'] : ['.codex/skills/orchestrator/SKILL.md', '.agents/skills/orchestrator/SKILL.md'];
    const orchestrator = candidates.map((path) => join(ctx.root, path)).find(existsSync) || join(ctx.root, candidates[0]);
    const composer = join(ctx.root, '.codex/internal-skills/workflow-compose/GUIDE.md');
    routing = {
      provider, session_id: sessionId, session_verified: Boolean(sessionId),
      workspace_root: ctx.root, worktree_ref: ctx.worktree_ref, decision_hint: observed.decision_hint,
      current_stage: progress?.current_stage || null, workflow_status: progress?.status || null,
      next: startup.startupProcedure({ observed, progress, orchestrator, composer }),
      ...(observed.decision_hint === 'worktree_required' ? { candidates: observed.worktree_candidates, omitted_candidates: observed.omitted_worktree_candidate_count || undefined } : {}),
      ...(observed.issues?.length ? { issues: observed.issues } : {}),
      ...(observed.setup_configuration?.violations?.length ? { setup_violations: observed.setup_configuration.violations } : {}),
    };
  }
  // The primary checkout exposes active worktree paths so the user can change directories, not route commands.
  let worktrees = {};
  if (!ctx.worktree_ref && !entryMode) {
    const { inspectStartupState } = await import(new URL('../../.harness/src/workflow/startup-state.mjs', import.meta.url));
    const observed = await inspectStartupState({ workspaceRoot: ctx.root, sessionId: process.env.CODEX_THREAD_ID || null, provider: process.env.HARNESS_PROVIDER_ID || 'codex' });
    worktrees = { session_worktrees: observed.session_worktrees, workflows: observed.matching_workflows, worktree_candidates: observed.worktree_candidates, issues: observed.issues, decision_hint: observed.decision_hint, omitted_workflow_count: observed.omitted_workflow_count, omitted_worktree_candidate_count: observed.omitted_worktree_candidate_count };
  }
  let state = orchestratorState(ctx.root);
  let recoveryNext = null;
  const stageId = state?.current_stage;
  const entry = state?.stages?.[stageId];
  if ((!entryMode || (routing.decision_hint === 'resume_candidate' && routing.session_verified))
      && ctx.worktree_ref && state?.orchestrator_provider === 'codex' && state.orchestrator_session_id
      && state.orchestrator_session_id === process.env.CODEX_THREAD_ID
      && entry?.status === 'running' && entry.native_managed && entry.native_agent_id && !entry.result_ref) {
    const runner = fileURLToPath(new URL('./harness-native-stage.mjs', import.meta.url));
    const recovered = JSON.parse(execFileSync(process.execPath, [runner, 'recover-interrupted', '--execution-id', entry.execution_id], { cwd: ctx.root, encoding: 'utf8' }));
    if (recovered.status === 'failed') {
      state = orchestratorState(ctx.root);
      recoveryNext = launchCommand(stageId, "--feedback 'The previous native agent was interrupted. Continue with the saved input and user answers.'");
    }
  }
  const staleOrder = staleStages(state);
  const awaitingApproval = stageId === 'bounded-context' && ctx.plan_set_id && existsSync(join(ctx.root, 'docs/specs', ctx.plan_set_id, 'requirements.md'));
  const revalidationNext = entry?.status === 'completed' && entry.code === 'OK' && (staleOrder.length || awaitingApproval)
    ? finishNext({ status: entry.status, code: entry.code, stageId, executionId: entry.execution_id, staleOrder, requirementsPresent: Boolean(awaitingApproval) })
    : null;
  const foreign = foreignRunningStage(state);
  const next = recoveryNext || (foreign ? takeoverStep(foreign) : revalidationNext);
  if (entryMode) {
    const resuming = routing.decision_hint === 'resume_candidate' && routing.session_verified;
    output({ ...routing, next: (resuming && next) || routing.next });
  } else {
    const stages = Object.fromEntries(Object.entries(state?.stages || {}).map(([id, stage]) => {
      const result = stage.result_ref ? read(join(ctx.root, '.io', stage.result_ref)) : null;
      return [id, { status: stage.status, code: stage.code || null, execution_id: stage.execution_id, attempts: (stage.attempts || []).length, ...(stage.stale ? { stale: stage.stale } : {}), ...(result ? { summary: (result.summary || '').slice(0, 400), questions: stage.stale ? [] : (result.questions || []).map((q) => ({ question_id: q.question_id, title: q.title })), commit_sha: result.commit_sha || undefined } : {}) }];
    }));
    let planTickets = [];
    try { planTickets = await (await import(new URL('../../.harness/src/tracker/lifecycle.mjs', import.meta.url).href)).listPlanTickets({ workspace_root: ctx.root, plan_set_id: ctx.plan_set_id }); } catch { planTickets = []; }
    // The tickets tactical-code can take next: not completed, every prerequisite completed.
    let readyTickets = [];
    if (ctx.plan_set_id && state?.stages?.['tracker-publish']?.status === 'completed') {
      try { readyTickets = (await (await import(new URL('../../.harness/src/workflow/tactical-tickets.mjs', import.meta.url).href)).ticketReadiness({ root: ctx.root, planSetId: ctx.plan_set_id })).filter((ticket) => ticket.ready).map(({ plan_id, depends_on }) => ({ plan_id, depends_on })); } catch { readyTickets = []; }
    }
    const plansDir = ctx.plan_set_id ? join(ctx.root, 'docs/plans', ctx.plan_set_id) : null;
    const plans = plansDir && existsSync(plansDir) ? readdirSync(plansDir).filter((name) => name.endsWith('.md') && name !== 'plans.md').map((name) => name.slice(0, -3)) : [];
    const reviews = Object.fromEntries(plans.map((plan) => [plan, read(join(ctx.root, `.io/runtime/reviews/implementation-${plan}-evidence.json`))]).filter(([, e]) => e).map(([plan, e]) => [plan, { fixed_point: e.review_input?.fixed_point, commit: e.review_input?.implementation_commit_sha, passed: Boolean(e.passed), reviews: (e.reviews || []).map((r) => ({ role: r.role, state: r.state, findings: (r.report?.findings || []).length })) }]));
    const lastTurn = await lastOrchestratorTurn(ctx.root);
    const latestStage = Math.max(0, ...Object.values(state?.stages || {}).map((stage) => Date.parse(stage.updated_at || 0) || 0));
    const context = {
      workspace_root: ctx.root, worktree_ref: ctx.worktree_ref, plan_set_id: ctx.plan_set_id, branch: ctx.record?.branch || null,
      current_stage: state?.current_stage || null, workflow_status: state?.status || null,
      // A stage another Codex conversation left running cannot be waited for from this one: the exact way on is here.
      next,
      // The orchestrator's last reply; when it is newer than every stage update it may be a question awaiting the user.
      orchestrator_last_turn: lastTurn ? { at: lastTurn.at, after_latest_stage: Date.parse(lastTurn.at) > latestStage, message: lastTurn.message.slice(0, 4000) } : null,
      stages,
      // Take a plan's ticket from here: Issue numbers do not follow the plan order.
      plan_tickets: planTickets,
      ready_tickets: readyTickets,
      plans, implementation_reviews: reviews,
      ...worktrees,
    };
    output(verbose ? context : compactContext(context));
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
