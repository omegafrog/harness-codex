#!/usr/bin/env node
// Deterministic gate of the tactical design flow: it checks the whole tactical-design.md of a plan set against requirements.md.
// The runner runs it once, when context-boundary (the last tactical stage) reports completed/OK, and rejects the result
// while it fails; no stage runs it. This command runs the same check by hand, for example to see what the runner will say, or for a relaunched stage to see which earlier-stage errors still stand.
// The checks live in the workflow module.
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkTacticalDesign, checkWorkspaceTacticalDesign } from '../../.harness/src/workflow/domain-model-gate.mjs';

export { checkTacticalDesign, parseRequirements, parseTables } from '../../.harness/src/workflow/domain-model-gate.mjs';

const USAGE = 'Usage: harness-domain-model-check.mjs --workspace-root <absolute-workspace-root> | --requirements <path> --tactical-design <path>';

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--workspace-root', '--requirements', '--tactical-design'].includes(args[i]) || args[i + 1] === undefined) throw new Error(USAGE);
    options[args[i].slice(2)] = args[i + 1];
  }
  let verdict;
  if (options.requirements && options['tactical-design']) {
    verdict = checkTacticalDesign({ requirements: await readFile(options.requirements, 'utf8'), tacticalDesign: await readFile(options['tactical-design'], 'utf8') });
  } else {
    const root = options['workspace-root'];
    if (!isAbsolute(root || '')) throw new Error(`--workspace-root must be an absolute path. ${USAGE}`);
    const { parseWorktreeRecord } = await import('../../.harness/src/workflow/worktrees.mjs');
    const record = parseWorktreeRecord(await readFile(join(root, '.io/worktree.json'), 'utf8'));
    if (await realpath(root) !== await realpath(record.workspace)) throw new Error('Workspace does not match worktree.json');
    verdict = await checkWorkspaceTacticalDesign({ root, planSetId: record.plan_set_id });
  }
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  if (!verdict.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
