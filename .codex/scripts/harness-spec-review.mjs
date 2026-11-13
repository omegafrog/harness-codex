#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const installed = new URL('../../.harness/src/workflow/spec-review.mjs', import.meta.url);
const { snapshotSpecReview, inspectSpecReviews, assertSpecReadyForReview } = await import(installed.href);
const outputModule = new URL('./session-output.mjs', installed);
const { sessionOutputPath, sessionDirectory } = await import(outputModule.href);
const { updateReviewAttempt } = await import(new URL('./review-attempts.mjs', installed).href);
const { reviewDelta } = await import(new URL('./review-delta.mjs', installed).href);
const { resolveCommandContext, latestReviewResult, reviewFixedPoint } = await import(new URL('../../.harness/src/workflow/cli-context.mjs', import.meta.url).href);
try {
  const [action, ...args] = process.argv.slice(2), options = {}, inputs = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!['--root', '--ticket', '--axis', '--reviews', '--input', '--attempt', '--reason'].includes(flag) || !value) throw new Error('Invalid review arguments');
    if (flag === '--input') inputs.push(value);
    else options[flag === '--ticket' ? 'ticketId' : flag.slice(2)] = value;
  }
  { const ctx = resolveCommandContext({ root: options.root }); options.root = ctx.root; options.ticketId ??= ctx.plan_set_id ?? undefined; }
  let result;
  if (['begin', 'record', 'abort', 'resolve'].includes(action)) {
    if (options.axis !== 'architecture') throw new Error('Only Architecture Spec review is supported');
    const reviews = options.reviews ? JSON.parse(await readFile(sessionOutputPath(options.root, options.reviews), 'utf8')) : null;
    const review = reviews?.[options.axis];
    if (action === 'record' && review && (review.axis !== options.axis || review.ticket_id !== options.ticketId)) throw new Error('Review axis and ticket must match the admitted target');
    if (action === 'record' && review && Object.hasOwn(review, 'inputs')) throw new Error('Review inputs are owned by the admission, not the reviewer');
    // Verdict, findings and reviewer identity come from the native reviewer bound by the subagent hook.
    const supplied = action === 'record' && review ? ['reviewer_id', 'author_ids', 'fork_turns', 'verdict', 'findings'].filter((key) => Object.hasOwn(review, key)) : [];
    if (supplied.length) throw new Error(`Review record must not supply ${supplied.join(', ')}; they are recorded from the native reviewer hook`);
    const snapshot = ['abort', 'resolve'].includes(action) ? null : await snapshotSpecReview({ ...options, input_paths: action === 'record' ? [] : inputs });
    if (action === 'begin') await assertSpecReadyForReview(options);
    result = await updateReviewAttempt({ root: options.root, scope: `spec-${options.ticketId}-${options.axis}`, action, inputs: snapshot, attemptId: options.attempt, review: action === 'record' ? { axis: options.axis, ticket_id: options.ticketId } : review, reason: options.reason, requireNative: action === 'record' });
    if (action === 'begin') {
      result.target = { workspace_root: options.root, session_directory: sessionDirectory(options.root), ticket_id: options.ticketId, axis: options.axis, attempt_id: result.attempt_id };
      result.review_delta = await reviewDelta({ root: options.root, inputs: result.inputs, previousInputs: result.previous_inputs });
    }
  } else if (action === 'snapshot') {
    if (options.axis !== 'architecture') throw new Error('Only Architecture Spec review is supported');
    result = await snapshotSpecReview({ ...options, input_paths: inputs });
  }
  else if (action === 'check') {
    const reviews = JSON.parse(await readFile(sessionOutputPath(options.root, options.reviews), 'utf8'));
    if (options.axis && options.axis !== 'architecture') throw new Error('Only Architecture Spec review is supported');
    result = await inspectSpecReviews({ ...options, reviews });
    if (result.status !== 'pass') process.exitCode = 1;
  } else throw new Error('Usage: harness-spec-review.mjs begin|record|abort|resolve|snapshot|check --root DIR --ticket ID --axis architecture [--input RELATIVE] [--reviews SESSION-RELATIVE-JSON] [--attempt ID] [--reason TEXT]');
  if (result.status && result.status !== 'pass') process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
