#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const installed = new URL('../harness-runtime/src/workflow/worktrees.mjs', import.meta.url);
const source = new URL('../../src/workflow/worktrees.mjs', import.meta.url);
const { createWorkflowWorktree, registerWorkflowWorktree, finishWorkflowWorktree, listWorkflowWorktrees } = await import(existsSync(installed) ? installed.href : source.href);
const cancellation = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => cancellation.abort(new Error(`Workflow interrupted: ${name}`)));
try {
  const [command, ...args] = process.argv.slice(2), options = {};
  const flags = { '--root': 'workspace_root', '--workflow': 'workflow_id', '--return-root': 'return_root', '--repository': 'repository_root', '--outcome': 'outcome', '--branch': 'branch' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!flags[key] || !value) throw new Error(`Unknown/missing argument: ${key}`);
    options[flags[key]] = value;
  }
  if (!['create', 'register', 'finish', 'list'].includes(command) || !options.workspace_root) throw new Error('Usage: harness-workflow-worktree.mjs create|register|finish|list --root DIR [--workflow ID] [--return-root DIR] [--repository DIR] [--outcome completed|failed|aborted|handoff]');
  for (const key of ['workspace_root', 'return_root', 'repository_root']) if (options[key]) options[key] = resolve(options[key]);
  const result = await (command === 'create' ? createWorkflowWorktree : command === 'register' ? registerWorkflowWorktree : command === 'list' ? listWorkflowWorktrees : finishWorkflowWorktree)({ ...options, signal: cancellation.signal });
  if (command === 'create' && cancellation.signal.aborted && result.state === 'active') Object.assign(result, await finishWorkflowWorktree({ workspace_root: result.workspace, repository_root: result.return_root, workflow_id: result.workflow_id, outcome: 'aborted' }));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.state === 'failed' || cancellation.signal.aborted) process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
