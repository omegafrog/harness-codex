#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
const installed = new URL('../../.harness/src/workflow/plan-review.mjs', import.meta.url);
const { snapshotPlanSet, inspectPlanSet, inspectPlanSetImpact, updatePlanReview } = await import(installed.href);
const { reviewDelta } = await import(new URL('./review-delta.mjs', installed).href);
const { resolveCommandContext, latestReviewResult, reviewFixedPoint } = await import(new URL('../../.harness/src/workflow/cli-context.mjs', import.meta.url).href);
// The stage only names the admitted attempt. Verdict, findings and reviewer identity come from the
// native reviewer that the subagent hook bound to this attempt, so a stage cannot vouch for itself.
function validateReviewRecord(review, options) {
  const allowed = new Set(['schema_version', 'attempt_id', 'plan_set_id']);
  if (!review || typeof review !== 'object' || Array.isArray(review)) throw new Error('Review record has an invalid shape');
  const identity = ['reviewer_id', 'author_ids', 'fork_turns', 'verdict', 'findings'].filter((key) => Object.hasOwn(review, key));
  if (identity.length) throw new Error(`Review record must not supply ${identity.join(', ')}; they are recorded from the native reviewer hook`);
  if (Object.keys(review).some((key) => !allowed.has(key))) throw new Error('Review record has an invalid shape');
  if (review.schema_version !== 1 || review.attempt_id !== options.attempt || review.plan_set_id !== options.planSetId) throw new Error('Review record target does not match the admitted attempt');
}
try {
  const [action, ...args] = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!['--root', '--plan-set', '--phase', '--plan', '--attempt', '--reason', '--reviews'].includes(flag) || !value) throw new Error('Invalid plan review arguments');
    options[flag === '--plan-set' ? 'planSetId' : flag === '--plan' ? 'planId' : flag.slice(2)] = value;
  }
  { const ctx = resolveCommandContext({ root: options.root, planSetId: options.planSetId }); options.root = ctx.root; options.planSetId = ctx.plan_set_id ?? undefined; }
  let result;
  if (['begin', 'record', 'abort', 'resolve'].includes(action)) {
    if (action === 'record') {
      const { sessionOutputPath } = await import(new URL('./session-output.mjs', installed).href);
      if (options.reviews) validateReviewRecord(JSON.parse(await readFile(sessionOutputPath(options.root, options.reviews), 'utf8')), options);
      result = await updatePlanReview({ ...options, action, attemptId: options.attempt, review: { schema_version: 1, attempt_id: options.attempt, plan_set_id: options.planSetId }, requireNative: true });
    } else {
      result = await updatePlanReview({ ...options, action, attemptId: options.attempt });
      if (action === 'begin') result.review_delta = await reviewDelta({ root: options.root, inputs: result.inputs, previousInputs: result.previous_inputs });
    }
  } else if (action === 'snapshot') result = await snapshotPlanSet(options);
  else if (action === 'impact') result = await inspectPlanSetImpact(options);
  else if (action === 'check') result = await inspectPlanSet(options);
  else throw new Error('Usage: harness-plan-review.mjs begin|record|abort|resolve|snapshot|check|impact --root DIR --plan-set ID [--phase planning|dispatch|completion] [--plan ID] [--attempt ID] [--reviews SESSION-RELATIVE-JSON] [--reason TEXT]');
  if (result.status && result.status !== 'pass' && action !== 'record') process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
