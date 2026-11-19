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
  let isPrimaryWorktree = false, isLinkedWorktree = false;
  if (record) {
    try {
      const worktrees = [...execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).matchAll(/^worktree (.+)$/gm)].map((match) => resolve(match[1]));
      isPrimaryWorktree = worktrees[0] === root;
      isLinkedWorktree = worktrees.includes(root) && !isPrimaryWorktree;
    } catch { /* command validation below reports the missing repository context */ }
  }
  return { root, worktree_ref: record ? worktreeRef : null, plan_set_id: record?.plan_set_id || null, execution_id: process.env.HARNESS_SKILL_EXECUTION_ID || null, record, is_primary_worktree: isPrimaryWorktree, is_linked_worktree: isLinkedWorktree };
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

// Reconcile the provider transcript with explicitly delivered and legacy turns without reviving an answered question.
export async function lastOrchestratorTurn(root) {
  const record = readJson(join(root, '.io/worktree.json'));
  const owner = record?.agent_sessions?.orchestrator;
  const dir = join(root, '.io/runtime/orchestrator');
  let delivered = null;
  try { const path = join(dir, 'last-turn.txt'); delivered = { at: statSync(path).mtime.toISOString(), message: readFileSync(path, 'utf8') }; } catch { /* No delivered turn. */ }
  if (owner?.provider === 'codex' && owner.session_id) {
    const { findRollout } = await import('./providers/codex.mjs');
    const { readFile } = await import('node:fs/promises');
    const path = await findRollout(join(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex'), 'sessions'), owner.session_id);
    if (path) {
      try {
        const rows = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
        if (rows[0]?.type === 'session_meta' && rows[0].payload?.id === owner.session_id && !rows[0].payload?.parent_thread_id && !rows[0].payload?.source?.subagent) {
          let last = null, cwd = rows[0].payload?.cwd, latestEvidence = 0;
          const forms = new Set();
          for (const row of rows) {
            if (row.type === 'turn_context' && typeof row.payload?.cwd === 'string') { cwd = row.payload.cwd; if (cwd !== root) { last = null; latestEvidence = Date.parse(row.timestamp) || latestEvidence; } }
            if (cwd !== root) continue;
            const p = row.payload || {};
            if (row.type !== 'response_item') continue;
            if (p.type === 'function_call' && /^(?:functions\.)?request_user_input$/.test(p.name || '')) forms.add(p.call_id);
            if (p.type === 'function_call_output' && forms.has(p.call_id)) { last = null; latestEvidence = Date.parse(row.timestamp) || latestEvidence; }
            if (p.type !== 'message') continue;
            if (p.role === 'user' && p.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes('user.text')) { last = null; latestEvidence = Date.parse(row.timestamp) || latestEvidence; }
            if (p.role === 'assistant' && p.phase === 'final_answer') {
              const message = (p.content || []).filter((item) => item.type === 'output_text').map((item) => item.text).join('\n');
              if (message) { last = { at: row.timestamp, message }; latestEvidence = Date.parse(row.timestamp) || latestEvidence; }
            }
          }
          return delivered && Date.parse(delivered.at) > latestEvidence ? delivered : last;
        }
      } catch { /* A missing or incomplete transcript cannot establish a pending turn. */ }
    }
  }
  const legacy = readJson(join(dir, 'last-turn.json'));
  if (legacy?.session_id !== owner?.session_id || !owner?.session_id) return delivered;
  return delivered && Date.parse(delivered.at) > Date.parse(legacy.at) ? delivered : legacy;
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
  const caller = cliContext(process.cwd());
  const ctx = cliContext(root ? resolve(root) : caller.root);
  if (ctx.worktree_ref && !ctx.is_linked_worktree) throw new Error(`Workflow commands require a registered linked worktree; change directory to the target worktree (${ctx.root})`);
  if (ctx.worktree_ref && !samePath(caller.root, ctx.root)) throw new Error(`Run this command from the target worktree (${ctx.root}); change directory first`);
  if (worktreeRef && (!ctx.worktree_ref || !samePath(worktreeRef, ctx.worktree_ref))) throw new Error('A worktree-ref cannot select another workspace; change directory into the target worktree');
  return {
    ...ctx,
    root: root ? resolve(root) : ctx.root,
    plan_set_id: pick('--plan-set', planSetId, ctx.plan_set_id) ?? null,
    worktree_ref: pick('--worktree-ref', worktreeRef, ctx.worktree_ref, samePath) ?? null,
  };
}
