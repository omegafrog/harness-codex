#!/usr/bin/env node
import { resolve } from 'node:path';
const installed = new URL('../../.harness/src/workflow/contract-review.mjs', import.meta.url);
const { updateContractReview, inspectContractReview } = await import(installed.href);
const { resolveCommandContext } = await import(new URL('../../.harness/src/workflow/cli-context.mjs', import.meta.url).href);
// The stage only names the admitted attempt. Verdict, findings and reviewer identity come from the native reviewer
// that the subagent hook bound to this attempt, so the stage cannot vouch for itself.
try {
  const [action, ...args] = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!['--root', '--plan-set', '--attempt', '--reason'].includes(flag) || !value) throw new Error('Invalid contract review arguments');
    options[flag === '--plan-set' ? 'planSetId' : flag.slice(2)] = value;
  }
  { const ctx = resolveCommandContext({ root: options.root, planSetId: options.planSetId }); options.root = resolve(ctx.root); options.planSetId = ctx.plan_set_id ?? undefined; }
  let result;
  if (['begin', 'record', 'abort', 'resolve'].includes(action)) result = await updateContractReview({ root: options.root, planSetId: options.planSetId, action, attemptId: options.attempt, reason: options.reason });
  else if (action === 'check') result = await inspectContractReview({ root: options.root, planSetId: options.planSetId });
  else throw new Error('Usage: harness-contract-review.mjs begin|record|abort|resolve|check --root DIR --plan-set ID [--attempt ID] [--reason TEXT]');
  if (result.status && result.status !== 'pass' && action !== 'record') process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
