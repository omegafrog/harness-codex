#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseWorktreeRecord, specArtifactPath } from '../../.harness/src/workflow/worktrees.mjs';

try {
  const [root, path] = process.argv.slice(2);
  if (!isAbsolute(root || '') || !path || process.argv.length !== 4) throw new Error('Usage: harness-spec-path.mjs <absolute-workspace-root> <spec-relative-path>');
  const record = parseWorktreeRecord(await readFile(join(root, '.io/worktree.json'), 'utf8'));
  if (await realpath(root) !== await realpath(record.workspace)) throw new Error('Workspace does not match worktree.json');
  process.stdout.write(`${specArtifactPath(record.plan_set_id, path)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
