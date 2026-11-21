#!/usr/bin/env node
import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
const installed = new URL('../../.harness/src/workflow/completion.mjs', import.meta.url);
const worktreeModule = new URL('../../.harness/src/workflow/worktrees.mjs', import.meta.url);
const { sessionOutputPath } = await import(new URL('./session-output.mjs', worktreeModule).href);
const options = {};
const cancellation = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => cancellation.abort(new Error(`Workflow interrupted: ${name}`)));
const { completeWorkflow } = await import(installed.href);
try {
  const flags = { '--root': 'workspace_root', '--workflow': 'workflow_id', '--worktree-id': 'worktree_id', '--base-ref': 'base_ref', '--state': 'state_file' };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--final-workflow') { options.final_workflow = true; continue; }
    if (!flags[args[i]] || !args[i + 1]) throw new Error(`Unknown/missing argument: ${args[i]}`);
    options[flags[args[i]]] = args[++i];
  }
  options.workspace_root = resolve(options.workspace_root || process.cwd());
  if (options.state_file) {
    const target = sessionOutputPath(options.workspace_root, options.state_file);
    if (!(await lstat(target)).isFile()) throw new Error('State file must be a regular session file');
    options.state = JSON.parse(await readFile(target, 'utf8'));
  }
  const result = await completeWorkflow({ ...options, signal: cancellation.signal });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.state !== 'completed') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ state: 'failed', error: error.message })}\n`);
  process.exitCode = 1;
}
