#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
const installed = new URL('../harness-runtime/src/workflow/completion.mjs', import.meta.url);
const source = new URL('../../src/workflow/completion.mjs', import.meta.url);
const worktreeModule = new URL(existsSync(installed) ? "../harness-runtime/src/workflow/worktrees.mjs" : "../../src/workflow/worktrees.mjs", import.meta.url);
const { finishWorkflowWorktree } = await import(worktreeModule.href);
const { sessionOutputPath } = await import(new URL('./session-output.mjs', worktreeModule).href);
const options = {};
let invoked = false;
const cancellation = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => cancellation.abort(new Error(`Workflow interrupted: ${name}`)));
const { completeWorkflow } = await import(existsSync(installed) ? installed.href : source.href);
try {
  const flags = { '--root': 'workspace_root', '--workflow': 'workflow_id', '--base-ref': 'base_ref', '--state': 'state_file' };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (!flags[args[i]] || !args[i + 1]) throw new Error(`Unknown/missing argument: ${args[i]}`);
    options[flags[args[i]]] = args[++i];
  }
  options.workspace_root = resolve(options.workspace_root || process.cwd());
  if (options.state_file) {
    const target = sessionOutputPath(options.workspace_root, options.state_file);
    if (!(await lstat(target)).isFile()) throw new Error('State file must be a regular session file');
    options.state = JSON.parse(await readFile(target, 'utf8'));
  }
  invoked = true;
  const result = await completeWorkflow({ ...options, signal: cancellation.signal });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.state !== 'completed') process.exitCode = 1;
} catch (error) {
  if (!invoked && options.workspace_root) {
    try { error.worktree_cleanup = await finishWorkflowWorktree({ workspace_root: options.workspace_root, workflow_id: options.workflow_id, outcome: 'failed' }); }
    catch (cleanupError) { error.worktree_cleanup = { state: 'failed', error: cleanupError.message }; }
  }
  process.stderr.write(`${JSON.stringify({ error: error.message, worktree_cleanup: error.worktree_cleanup || null })}\n`);
  process.exitCode = 1;
}
