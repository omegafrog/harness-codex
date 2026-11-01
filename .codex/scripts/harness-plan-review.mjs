#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
const installed = new URL('../../.harness/src/workflow/plan-review.mjs', import.meta.url);
const { snapshotPlanSet, inspectPlanSet, inspectPlanSetImpact, updatePlanReview } = await import(installed.href);
const { reviewDelta } = await import(new URL('./review-delta.mjs', installed).href);
function validateReviewRecord(review, options) {
  const allowed = new Set(['schema_version', 'attempt_id', 'plan_set_id', 'reviewer_id', 'author_ids', 'fork_turns', 'verdict', 'inputs', 'findings']);
  if (!review || typeof review !== 'object' || Array.isArray(review) || Object.keys(review).some((key) => !allowed.has(key))) throw new Error('Review record has an invalid shape');
  if (review.schema_version !== 1 || review.attempt_id !== options.attempt || review.plan_set_id !== options.planSetId) throw new Error('Review record target does not match the admitted attempt');
  if (typeof review.reviewer_id !== 'string' || !review.reviewer_id.trim() || !Array.isArray(review.author_ids) || !review.author_ids.length || review.author_ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(review.author_ids).size !== review.author_ids.length || review.author_ids.includes(review.reviewer_id) || review.fork_turns !== 'none') throw new Error('Review record does not prove an independent fresh reviewer');
  if (!['pass', 'revise'].includes(review.verdict) || !Array.isArray(review.inputs) || !review.inputs.length || review.inputs.some((item) => !item || typeof item.path !== 'string' || !item.path || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) || new Set(review.inputs.map((item) => item.path)).size !== review.inputs.length) throw new Error('Review verdict or snapshot inputs are invalid');
  if (!Array.isArray(review.findings) || review.findings.some((item) => !item || !['blocker', 'major', 'minor'].includes(item.severity) || typeof item.description !== 'string' || !item.description.trim() || typeof item.evidence !== 'string' || !item.evidence.trim())) throw new Error('Review findings do not match the review record schema');
}
try {
  const [action, ...args] = process.argv.slice(2), options = { root: process.cwd() };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!['--root', '--plan-set', '--phase', '--plan', '--attempt', '--reason', '--reviews'].includes(flag) || !value) throw new Error('Invalid plan review arguments');
    options[flag === '--plan-set' ? 'planSetId' : flag === '--plan' ? 'planId' : flag.slice(2)] = value;
  }
  options.root = resolve(options.root);
  let result;
  if (['begin', 'record', 'abort', 'resolve'].includes(action)) {
    if (action === 'record') {
      const { sessionOutputPath } = await import(new URL('./session-output.mjs', installed).href);
      const review = JSON.parse(await readFile(sessionOutputPath(options.root, options.reviews), 'utf8'));
      validateReviewRecord(review, options);
      const reviewInputs = Object.fromEntries(review.inputs.map(({ path, sha256 }) => [path, sha256]));
      if (Object.keys(reviewInputs).length !== review.inputs.length) throw new Error('Review inputs contain duplicate paths');
      const recordedReview = { ...review, inputs: reviewInputs, findings: review.findings.map((finding) => ({ ...finding, evidence: Array.isArray(finding.evidence) ? finding.evidence.join('; ') : finding.evidence })) };
      result = await updatePlanReview({ ...options, action, attemptId: options.attempt, review: recordedReview });
    } else {
      result = await updatePlanReview({ ...options, action });
      if (action === 'begin') result.review_delta = await reviewDelta({ root: options.root, inputs: result.inputs, previousInputs: result.previous_inputs });
    }
  } else if (action === 'snapshot') result = await snapshotPlanSet(options);
  else if (action === 'impact') result = await inspectPlanSetImpact(options);
  else if (action === 'check') result = await inspectPlanSet(options);
  else throw new Error('Usage: harness-plan-review.mjs begin|record|abort|resolve|snapshot|check|impact --root DIR --plan-set ID [--phase planning|dispatch|completion] [--plan ID] [--attempt ID] [--reviews SESSION-RELATIVE-JSON] [--reason TEXT]');
  if (result.status && result.status !== 'pass' && action !== 'record') process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
