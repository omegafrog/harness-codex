#!/usr/bin/env node
// Deterministic design-freeze gate: the implementation-design documents (api.md, data.md, ui-handoff.md) add no scope, and every
// requirement is covered, against requirements.md and tactical-design.md. The runner runs it when tactical-data reports
// completed/OK and before to-ticket starts; this command runs the same check by hand. The checks live in the workflow module.
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkDesignFreeze, checkWorkspaceDesignFreeze } from '../../.harness/src/workflow/design-freeze-gate.mjs';

export { checkDesignFreeze } from '../../.harness/src/workflow/design-freeze-gate.mjs';

const USAGE = 'Usage: harness-design-freeze-check.mjs --workspace-root <absolute-workspace-root> | --requirements <path> --tactical-design <path> [--api <path>] [--data <path>] [--ui <path>]';

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--workspace-root', '--requirements', '--tactical-design', '--api', '--data', '--ui'].includes(args[i]) || args[i + 1] === undefined) throw new Error(USAGE);
    options[args[i].slice(2)] = args[i + 1];
  }
  let verdict;
  if (options.requirements && options['tactical-design']) {
    const documents = {};
    for (const kind of ['api', 'data', 'ui']) if (options[kind]) documents[kind] = await readFile(options[kind], 'utf8');
    verdict = checkDesignFreeze({ requirements: await readFile(options.requirements, 'utf8'), tacticalDesign: await readFile(options['tactical-design'], 'utf8'), documents });
  } else {
    const root = options['workspace-root'];
    if (!isAbsolute(root || '')) throw new Error(`--workspace-root must be an absolute path. ${USAGE}`);
    const { parseWorktreeRecord } = await import('../../.harness/src/workflow/worktrees.mjs');
    const record = parseWorktreeRecord(await readFile(join(root, '.io/worktree.json'), 'utf8'));
    if (await realpath(root) !== await realpath(record.workspace)) throw new Error('Workspace does not match worktree.json');
    verdict = await checkWorkspaceDesignFreeze({ root, planSetId: record.plan_set_id });
  }
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  if (!verdict.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
