import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Harness commands find their own workspace context so an agent does not read worktree.json or state files just to
// copy IDs into arguments (that cost hundreds of calls per run and caused truncated SHAs and mistyped UUIDs).
// Explicit arguments still work; one that contradicts the current worktree is an error.
export function cliContext(cwd = process.cwd()) {
  let root = resolve(cwd);
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || root; } catch { /* not a repository */ }
  const worktreeRef = join(root, '.io/worktree.json');
  let record = null;
  if (existsSync(worktreeRef)) { try { record = JSON.parse(readFileSync(worktreeRef, 'utf8')); } catch { record = null; } }
  return { root, worktree_ref: record ? worktreeRef : null, plan_set_id: record?.plan_set_id || null, execution_id: process.env.HARNESS_SKILL_EXECUTION_ID || null, record };
}

export function pick(name, explicit, inferred, same = (a, b) => a === b) {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    if (inferred && !same(explicit, inferred)) throw new Error(`${name} ${explicit} does not match the current worktree (${inferred}); omit it to use the current one`);
    return explicit;
  }
  return inferred ?? undefined;
}

export const samePath = (a, b) => resolve(a) === resolve(b);

function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }

// The orchestrator's latest reply: from the Stop hook (last-turn.json) or a delivered turn's output (last-turn.txt).
export function lastOrchestratorTurn(root) {
  const dir = join(root, '.io/runtime/orchestrator');
  const hook = readJson(join(dir, 'last-turn.json'));
  let delivered = null;
  try { const path = join(dir, 'last-turn.txt'); delivered = { at: statSync(path).mtime.toISOString(), message: readFileSync(path, 'utf8') }; } catch { delivered = null; }
  const candidates = [hook, delivered].filter((item) => item?.at && typeof item.message === 'string' && item.message.trim());
  return candidates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] || null;
}

export function orchestratorState(root) { return readJson(join(root, '.io/runtime/orchestrator/state.json')); }

// The latest implement-wrapper result that asked for review of this plan.
export function latestReviewResult(root, planId) {
  const executions = join(root, '.io/runtime/executions');
  let best = null;
  for (const name of existsSync(executions) ? readdirSync(executions) : []) {
    if (!name.startsWith('implement-wrapper-')) continue;
    const result = readJson(join(executions, name, 'result.json'));
    if (result?.code !== 'REVIEW_REQUIRED') continue;
    const input = findInput(root, name);
    if (input?.context?.plan_id && input.context.plan_id !== planId) continue;
    const at = Date.parse(readJson(join(executions, name, 'return.json'))?.recorded_at || 0) || statTime(join(executions, name, 'result.json'));
    if (!best || at > best.at) best = { at, ref: `runtime/executions/${name}/result.json` };
  }
  return best?.ref || null;
}

function statTime(path) { try { return statSync(path).mtimeMs; } catch { return 0; } }

function findInput(root, executionId) {
  const io = join(root, '.io');
  for (const set of existsSync(io) ? readdirSync(io) : []) {
    const stageDir = join(io, set);
    for (const stage of ['implement-wrapper']) {
      const path = join(stageDir, stage, executionId, 'input.json');
      if (existsSync(path)) return readJson(path);
    }
  }
  return null;
}

// The fixed point a plan's review rounds keep: the one its earlier review evidence used.
export function reviewFixedPoint(root, planId) {
  return readJson(join(root, `.io/runtime/reviews/implementation-${planId}-evidence.json`))?.review_input?.fixed_point || null;
}

// Resolves a command's workspace from an explicit --root (or the cwd) and fills the plan set and worktree from it.
export function resolveCommandContext({ root, planSetId, worktreeRef } = {}) {
  const ctx = cliContext(root ? resolve(root) : process.cwd());
  return {
    ...ctx,
    root: root ? resolve(root) : ctx.root,
    plan_set_id: pick('--plan-set', planSetId, ctx.plan_set_id) ?? null,
    worktree_ref: pick('--worktree-ref', worktreeRef, ctx.worktree_ref, samePath) ?? null,
  };
}
