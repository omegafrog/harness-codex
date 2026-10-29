#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
let sourceCheckout = false;
try { sourceCheckout = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).name === '@omegafrog/harness-codex'; } catch {}
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const installed = new URL('../harness-runtime/src/workflow/worktrees.mjs', import.meta.url);
const source = new URL('../../src/workflow/worktrees.mjs', import.meta.url);
const { bindWorkflowPlanSetId, createWorkflowWorktree, registerWorkflowWorktree, finishWorkflowWorktree, listWorkflowWorktrees } = await import(existsSync(installed) && !sourceCheckout ? installed.href : source.href);
const cancellation = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => cancellation.abort(new Error(`Workflow interrupted: ${name}`)));
try {
  const [command, ...args] = process.argv.slice(2), options = {};
  const flags = { '--root': 'workspace_root', '--return-root': 'return_root', '--repository': 'repository_root', '--outcome': 'outcome', '--branch': 'branch', '--worktree-id': 'worktree_id', '--plan-set-id': 'plan_set_id', '--feature-name': 'feature_name' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!flags[key] || !value) throw new Error(`Unknown/missing argument: ${key}`);
    options[flags[key]] = value;
  }
  if (!['create', 'register', 'bind-plan-set-id', 'finish', 'list'].includes(command) || (command !== 'create' && !options.workspace_root)) throw new Error('Usage: harness-workflow-worktree.mjs create|register|bind-plan-set-id|finish|list [--root DIR] [--branch NAME] [--return-root DIR] [--repository DIR] [--worktree-id UUID] [--plan-set-id ID|--feature-name NAME] [--outcome completed|failed|aborted|handoff]');
  if (command === 'create' && !options.workspace_root) options.workspace_root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (command === 'create' && options.worktree_id) throw new Error('create generates worktree_id; do not provide one');
  for (const key of ['workspace_root', 'return_root', 'repository_root']) if (options[key]) options[key] = resolve(options[key]);
  const result = await (command === 'create' ? createWorkflowWorktree : command === 'register' ? registerWorkflowWorktree : command === 'bind-plan-set-id' ? bindWorkflowPlanSetId : command === 'list' ? listWorkflowWorktrees : finishWorkflowWorktree)({ ...options, signal: cancellation.signal });
  if (command === 'create' && cancellation.signal.aborted && result.state === 'active') Object.assign(result, await finishWorkflowWorktree({ workspace_root: result.workspace, repository_root: result.return_root, worktree_id: result.worktree_id, outcome: 'aborted' }));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.state === 'failed' || cancellation.signal.aborted) process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
