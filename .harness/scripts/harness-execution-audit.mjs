#!/usr/bin/env node
// Read-only audit of the current workflow's stage executions. Run it from the workflow worktree.
//   node .harness/scripts/harness-execution-audit.mjs executions [--root DIR] [--flagged] [--verbose]
//   node .harness/scripts/harness-execution-audit.mjs read-scope [--root DIR] [--plan ID] [--verbose]
// `executions` lists every stage execution and retry with its native thread, fork_turns, observed model/effort and
// attestation status, and flags any that was not fresh or ran with another binding. `read-scope` compares the files
// each implementation worker read with its ticket's declared paths (observational; it never blocks).
// The command writes nothing and exits 0 whenever it could produce a report; flags are data, not failures.
const { resolveCommandContext } = await import(new URL('../../.harness/src/workflow/cli-context.mjs', import.meta.url).href);
const { auditExecutions, auditReadScope, publicAudit } = await import(new URL('../../.harness/src/workflow/execution-audit.mjs', import.meta.url).href);
const USAGE = 'Usage: harness-execution-audit.mjs executions|read-scope [--root DIR] [--plan ID] [--flagged] [--verbose]';
try {
  const [action, ...rest] = process.argv.slice(2);
  const options = { verbose: false, flagged: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--verbose') options.verbose = true;
    else if (flag === '--flagged') options.flagged = true;
    else if (['--root', '--plan'].includes(flag) && rest[index + 1]) options[flag.slice(2)] = rest[++index];
    else throw new Error(USAGE);
  }
  if (!['executions', 'read-scope'].includes(action)) throw new Error(USAGE);
  const { root } = resolveCommandContext({ root: options.root });
  const audit = await auditExecutions({ root });
  let report;
  if (action === 'executions') {
    report = publicAudit(audit);
    if (options.flagged) report.executions = report.executions.filter((row) => row.flags.length);
    if (!options.verbose) report.executions = report.executions.map(({ hook_subagents, subagents, ...row }) => ({ ...row, ...(subagents?.length ? { subagents: subagents.length, subagent_flags: subagents.filter((item) => item.flag).length || undefined } : {}), ...(hook_subagents?.length ? { hook_subagents: hook_subagents.length } : {}) }));
  } else {
    report = await auditReadScope({ root, audit, planId: options.plan || null });
    if (!options.verbose) report.workers = report.workers.map(({ reads, ...worker }) => worker);
  }
  process.stdout.write(`${JSON.stringify(report, null, options.verbose ? 2 : undefined)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
