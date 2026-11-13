#!/usr/bin/env node
import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateStageListenerTarget, waitForStageResult } from '../../.harness/src/workflow/stage-result-events.mjs';
import { resolveCommandContext } from '../../.harness/src/workflow/cli-context.mjs';

const args = process.argv.slice(2);
const values = Object.fromEntries(args.flatMap((arg, index) => arg.startsWith('--') ? [[arg.slice(2).replaceAll('-', '_'), args[index + 1]]] : []));
if (!values.execution_id) {
  process.stderr.write('Usage: harness-stage-listen.mjs --execution-id <id>\n');
  process.exitCode = 2;
} else {
  const context = resolveCommandContext({ root: values.root, worktreeRef: values.worktree_ref });
  if (!context.worktree_ref) throw new Error('Run the listener from inside the target worktree');
  const root = resolve(context.root), worktree_ref = resolve(context.worktree_ref);
  const { task_session, control_session } = await validateStageListenerTarget({ root, worktree_ref, execution_id: values.execution_id });
  const executionDir = join(task_session, 'runtime/executions', values.execution_id);
  const eventDir = join(control_session, 'runtime/orchestrator/stage-results');
  await mkdir(executionDir, { recursive: true });
  await mkdir(eventDir, { recursive: true });
  let busy = false, done = false;
  const attempt = async () => {
    if (busy || done) return;
    busy = true;
    try {
      const result = await waitForStageResult({ root, worktree_ref, execution_id: values.execution_id });
      done = true;
      process.stdout.write(JSON.stringify(result) + '\n');
      watcher.close();
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) { done = true; process.stderr.write(`${error.message}\n`); watcher.close(); process.exitCode = 1; } }
    finally { busy = false; }
  };
  const watchers = [executionDir, eventDir].map((dir) => watch(dir, { persistent: true }, () => void attempt()));
  const watcher = { close: () => watchers.forEach((item) => item.close()) };
  await attempt();
}
