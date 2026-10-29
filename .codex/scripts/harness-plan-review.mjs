#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
let sourceCheckout = false;
try { sourceCheckout = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).name === '@omegafrog/harness-codex'; } catch {}
const installed = new URL('../harness-runtime/src/workflow/plan-review.mjs', import.meta.url);
const source = new URL('../../src/workflow/plan-review.mjs', import.meta.url);
const runtime = existsSync(installed) && !sourceCheckout ? installed : source;
const { snapshotPlanSet, inspectPlanSet, inspectPlanSetImpact, updatePlanReview } = await import(runtime.href);
const { reviewDelta } = await import(new URL('./review-delta.mjs', runtime).href);
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
      const { sessionOutputPath } = await import(new URL('./session-output.mjs', runtime).href);
      const review = JSON.parse(await readFile(sessionOutputPath(options.root, options.reviews), 'utf8'));
      if (review.plan_set_id !== options.planSetId) throw new Error('Review plan set must match the admitted target');
      const recordedReview = { ...review, findings: review.findings.map((finding) => ({ ...finding, evidence: Array.isArray(finding.evidence) ? finding.evidence.join('; ') : finding.evidence })) };
      result = await updatePlanReview({ ...options, action, attemptId: options.attempt, review: recordedReview });
    } else {
      result = await updatePlanReview({ ...options, action });
      if (action === 'begin') result.review_delta = await reviewDelta({ root: options.root, inputs: result.inputs, previousInputs: result.previous_inputs });
    }
  } else if (action === 'snapshot') result = await snapshotPlanSet(options);
  else if (action === 'impact') result = await inspectPlanSetImpact(options);
  else if (action === 'check') result = await inspectPlanSet(options);
  else throw new Error('Usage: harness-plan-review.mjs begin|record|abort|resolve|snapshot|check|impact --root DIR --plan-set ID [--phase planning|dispatch|completion] [--plan ID] [--attempt ID] [--reviews SESSION-RELATIVE-JSON] [--reason TEXT]');
  if (result.status && result.status !== 'pass') process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
