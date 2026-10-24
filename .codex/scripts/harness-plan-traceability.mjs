#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const installed = new URL('../harness-runtime/src/workflow/plan-traceability.mjs', import.meta.url);
const source = new URL('../../src/workflow/plan-traceability.mjs', import.meta.url);
const { snapshotPlanTraceability, inspectPlanTraceability, inspectTraceabilityImpact } = await import(existsSync(installed) ? installed.href : source.href);
const runtime = existsSync(installed) ? installed : source;
const { updateReviewAttempt } = await import(new URL('./review-attempts.mjs', runtime).href);
try {
  const [action, ...args] = process.argv.slice(2), options = { root: process.cwd() };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!['--root', '--plan-set', '--phase', '--plan', '--attempt', '--reason', '--reviews'].includes(flag) || !value) throw new Error('Invalid traceability arguments');
    options[flag === '--plan-set' ? 'planSetId' : flag === '--plan' ? 'planId' : flag.slice(2)] = value;
  }
  options.root = resolve(options.root);
  let result;
  if (['begin', 'record', 'abort', 'resolve'].includes(action)) {
    const snapshot = ['abort', 'resolve'].includes(action) ? null : await snapshotPlanTraceability(options);
    let review;
    if (action === 'record') {
      const { readFile } = await import('node:fs/promises');
      const { sessionOutputPath } = await import(new URL('./session-output.mjs', runtime).href);
      review = JSON.parse(await readFile(sessionOutputPath(options.root, options.reviews), 'utf8'));
      if (review.plan_set_id !== options.planSetId) throw new Error('Review plan set must match the admitted target');
    }
    result = await updateReviewAttempt({ root: options.root, scope: `plan-${options.planSetId}`, action, inputs: snapshot?.inputs, attemptId: options.attempt, review, reason: options.reason });
  } else if (action === 'snapshot') result = await snapshotPlanTraceability(options);
  else if (action === 'impact') result = await inspectTraceabilityImpact(options);
  else if (action === 'check') result = await inspectPlanTraceability(options);
  else throw new Error('Usage: harness-plan-traceability.mjs begin|record|abort|resolve|snapshot|check|impact --root DIR --plan-set ID [--phase planning|dispatch|completion] [--plan ID] [--attempt ID] [--reviews SESSION-RELATIVE-JSON] [--reason TEXT]');
  if (result.status && result.status !== 'pass') process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
