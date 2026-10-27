#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const installed = new URL('../harness-runtime/src/workflow/spec-review.mjs', import.meta.url);
const source = new URL('../../src/workflow/spec-review.mjs', import.meta.url);
const { snapshotSpecReview, inspectSpecReviews } = await import(existsSync(installed) ? installed.href : source.href);
const outputModule = new URL('./session-output.mjs', existsSync(installed) ? installed : source);
const { sessionOutputPath, sessionDirectory } = await import(outputModule.href);
const { updateReviewAttempt } = await import(new URL('./review-attempts.mjs', existsSync(installed) ? installed : source).href);
try {
  const [action, ...args] = process.argv.slice(2), options = { root: process.cwd() }, inputs = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!['--root', '--ticket', '--axis', '--reviews', '--input', '--attempt', '--reason'].includes(flag) || !value) throw new Error('Invalid review arguments');
    if (flag === '--input') inputs.push(value);
    else options[flag === '--ticket' ? 'ticketId' : flag.slice(2)] = value;
  }
  options.root = resolve(options.root);
  let result;
  if (['begin', 'record', 'abort', 'resolve'].includes(action)) {
    if (options.axis !== 'architecture') throw new Error('Only Architecture Spec review is supported');
    const reviews = options.reviews ? JSON.parse(await readFile(sessionOutputPath(options.root, options.reviews), 'utf8')) : null;
    const review = reviews?.[options.axis];
    if (action === 'record' && (review?.axis !== options.axis || review?.ticket_id !== options.ticketId)) throw new Error('Review axis and ticket must match the admitted target');
    const snapshot = ['abort', 'resolve'].includes(action) ? null : await snapshotSpecReview({ ...options, input_paths: action === 'record' ? Object.keys(review?.inputs || {}) : inputs });
    result = await updateReviewAttempt({ root: options.root, scope: `spec-${options.ticketId}-${options.axis}`, action, inputs: snapshot, attemptId: options.attempt, review, reason: options.reason });
    if (action === 'begin') result.target = { workspace_root: options.root, session_directory: sessionDirectory(options.root), ticket_id: options.ticketId, axis: options.axis, attempt_id: result.attempt_id };
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
