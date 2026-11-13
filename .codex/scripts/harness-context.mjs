#!/usr/bin/env node
// One read of the current workflow: worktree, plan set, stage states, plans with their Issues, and the latest
// result of each stage. Use it instead of reading worktree.json, state.json or result files one by one.
//   node .codex/scripts/harness-context.mjs [--root DIR | --worktree-ref FILE]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const { resolveCommandContext, orchestratorState, lastOrchestratorTurn } = await import(new URL('../../.harness/src/workflow/cli-context.mjs', import.meta.url).href);
const read = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
try {
  const args = process.argv.slice(2);
  if (args.length && (!['--root', '--worktree-ref'].includes(args[0]) || !args[1] || args.length > 2)) throw new Error('Usage: harness-context.mjs [--root DIR | --worktree-ref FILE]');
  const ctx = resolveCommandContext(args[0] === '--worktree-ref' ? { worktreeRef: args[1] } : { root: args[1] });
  // The primary checkout exposes active worktree paths so the user can change directories, not route commands.
  let worktrees = {};
  if (!ctx.worktree_ref) {
    const { inspectStartupState } = await import(new URL('../../.harness/src/workflow/startup-state.mjs', import.meta.url));
    const observed = await inspectStartupState({ workspaceRoot: ctx.root, sessionId: process.env.CODEX_THREAD_ID || null, provider: process.env.HARNESS_PROVIDER_ID || 'codex' });
    worktrees = { session_worktrees: observed.session_worktrees, workflows: observed.matching_workflows, worktree_candidates: observed.worktree_candidates, issues: observed.issues, decision_hint: observed.decision_hint, omitted_workflow_count: observed.omitted_workflow_count, omitted_worktree_candidate_count: observed.omitted_worktree_candidate_count };
  }
  const state = orchestratorState(ctx.root);
  const stages = Object.fromEntries(Object.entries(state?.stages || {}).map(([id, stage]) => {
    const result = stage.result_ref ? read(join(ctx.root, '.io', stage.result_ref)) : null;
    return [id, { status: stage.status, code: stage.code || null, execution_id: stage.execution_id, attempts: (stage.attempts || []).length, ...(result ? { summary: (result.summary || '').slice(0, 400), questions: (result.questions || []).map((q) => ({ question_id: q.question_id, title: q.title })), commit_sha: result.commit_sha || undefined } : {}) }];
  }));
  let planTickets = [];
  try { planTickets = await (await import(new URL('../../.harness/src/tracker/lifecycle.mjs', import.meta.url).href)).listPlanTickets({ workspace_root: ctx.root, plan_set_id: ctx.plan_set_id }); } catch { planTickets = []; }
  const plansDir = ctx.plan_set_id ? join(ctx.root, 'docs/plans', ctx.plan_set_id) : null;
  const plans = plansDir && existsSync(plansDir) ? readdirSync(plansDir).filter((name) => name.endsWith('.md') && name !== 'plans.md').map((name) => name.slice(0, -3)) : [];
  const reviews = Object.fromEntries(plans.map((plan) => [plan, read(join(ctx.root, `.io/runtime/reviews/implementation-${plan}-evidence.json`))]).filter(([, e]) => e).map(([plan, e]) => [plan, { fixed_point: e.review_input?.fixed_point, commit: e.review_input?.implementation_commit_sha, passed: Boolean(e.passed), reviews: (e.reviews || []).map((r) => ({ role: r.role, state: r.state, findings: (r.report?.findings || []).length })) }]));
  const lastTurn = lastOrchestratorTurn(ctx.root);
  const latestStage = Math.max(0, ...Object.values(state?.stages || {}).map((stage) => Date.parse(stage.updated_at || 0) || 0));
  process.stdout.write(`${JSON.stringify({
    workspace_root: ctx.root, worktree_ref: ctx.worktree_ref, plan_set_id: ctx.plan_set_id, branch: ctx.record?.branch || null,
    current_stage: state?.current_stage || null, workflow_status: state?.status || null,
    // The orchestrator's last reply; when it is newer than every stage update it may be a question awaiting the user.
    orchestrator_last_turn: lastTurn ? { at: lastTurn.at, after_latest_stage: Date.parse(lastTurn.at) > latestStage, message: lastTurn.message.slice(0, 4000) } : null,
    stages,
    // Take a plan's ticket from here: Issue numbers do not follow the plan order.
    plan_tickets: planTickets,
    plans, implementation_reviews: reviews,
    ...worktrees,
  }, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
