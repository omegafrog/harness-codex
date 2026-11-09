#!/usr/bin/env node
// One read of the current workflow: worktree, plan set, stage states, plans with their Issues, and the latest
// result of each stage. Use it instead of reading worktree.json, state.json or result files one by one.
//   node .codex/scripts/harness-context.mjs [--root DIR]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const { resolveCommandContext, orchestratorState } = await import(new URL('../../.harness/src/workflow/cli-context.mjs', import.meta.url).href);
const read = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
try {
  const args = process.argv.slice(2);
  if (args.length && (args[0] !== '--root' || !args[1] || args.length > 2)) throw new Error('Usage: harness-context.mjs [--root DIR]');
  const ctx = resolveCommandContext({ root: args[1] });
  const state = orchestratorState(ctx.root);
  const stages = Object.fromEntries(Object.entries(state?.stages || {}).map(([id, stage]) => {
    const result = stage.result_ref ? read(join(ctx.root, '.io', stage.result_ref)) : null;
    return [id, { status: stage.status, code: stage.code || null, execution_id: stage.execution_id, attempts: (stage.attempts || []).length, ...(result ? { summary: (result.summary || '').slice(0, 400), questions: (result.questions || []).map((q) => ({ question_id: q.question_id, title: q.title })), commit_sha: result.commit_sha || undefined } : {}) }];
  }));
  const plansDir = ctx.plan_set_id ? join(ctx.root, 'docs/plans', ctx.plan_set_id) : null;
  const plans = plansDir && existsSync(plansDir) ? readdirSync(plansDir).filter((name) => name.endsWith('.md') && name !== 'plans.md').map((name) => name.slice(0, -3)) : [];
  const reviews = Object.fromEntries(plans.map((plan) => [plan, read(join(ctx.root, `.io/runtime/reviews/implementation-${plan}-evidence.json`))]).filter(([, e]) => e).map(([plan, e]) => [plan, { fixed_point: e.review_input?.fixed_point, commit: e.review_input?.implementation_commit_sha, passed: Boolean(e.passed), reviews: (e.reviews || []).map((r) => ({ role: r.role, state: r.state, findings: (r.report?.findings || []).length })) }]));
  process.stdout.write(`${JSON.stringify({
    workspace_root: ctx.root, worktree_ref: ctx.worktree_ref, plan_set_id: ctx.plan_set_id, branch: ctx.record?.branch || null,
    current_stage: state?.current_stage || null, workflow_status: state?.status || null, stages, plans, implementation_reviews: reviews,
  }, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
