#!/usr/bin/env node
// Deterministic gate of the tactical design stages (domain-model, aggregate-design, domain-service, application-service,
// integration-design). Each stage runs it before it returns completed; the runner runs the same check again when the
// stage's completed/OK result arrives and rejects the result while it fails. The checks live in the workflow module.
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TACTICAL_STAGE_LEVEL, checkDomainModel, checkWorkspaceDomainModel } from '../../.harness/src/workflow/domain-model-gate.mjs';

export { TACTICAL_STAGE_LEVEL, checkDomainModel, parseRequirements, parseTables } from '../../.harness/src/workflow/domain-model-gate.mjs';

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined) throw new Error('Usage: harness-domain-model-check.mjs --workspace-root <absolute-workspace-root> --stage <stage> [--requirements <path> --domain-model <path>]');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!TACTICAL_STAGE_LEVEL[options.stage]) throw new Error(`--stage must be one of ${Object.keys(TACTICAL_STAGE_LEVEL).join(', ')}`);
  let verdict;
  if (options.requirements && options['domain-model']) {
    verdict = checkDomainModel({ requirements: await readFile(options.requirements, 'utf8'), domainModel: await readFile(options['domain-model'], 'utf8'), stage: options.stage });
  } else {
    const root = options['workspace-root'];
    if (!isAbsolute(root || '')) throw new Error('--workspace-root must be an absolute path');
    const { parseWorktreeRecord } = await import('../../.harness/src/workflow/worktrees.mjs');
    const record = parseWorktreeRecord(await readFile(join(root, '.io/worktree.json'), 'utf8'));
    if (await realpath(root) !== await realpath(record.workspace)) throw new Error('Workspace does not match worktree.json');
    verdict = await checkWorkspaceDomainModel({ root, planSetId: record.plan_set_id, stage: options.stage });
  }
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  if (!verdict.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
