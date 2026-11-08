#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const installed = new URL('../../.harness/src/wrapper/repair.mjs', import.meta.url);
const { reserveImplementationRepair } = await import(installed.href);
const { buildReviewInput, readImplementerAdditions, assembleReviews, writeReviewEvidence } = await import(new URL('review-input.mjs', installed).href);
const { sessionOutputPath } = await import(new URL('../workflow/session-output.mjs', installed).href);
try {
  const [action, ...args] = process.argv.slice(2), options = { root: process.cwd() };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!['--root', '--plan', '--reviews', '--reason', '--max-rounds', '--answers-ref', '--question-id', '--fixed-point', '--commit', '--implementation-result', '--standards-answer', '--standards-id', '--spec-answer', '--spec-id'].includes(flag) || !value) throw new Error('Invalid code-review arguments');
    options[flag.slice(2)] = value;
  }
  options.root = resolve(options.root);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.plan || '')) throw new Error('Valid plan ID is required');
  let result;
  if (action === 'assemble') {
    // Builds runtime/reviews/implementation-<plan>.json for `repair` from the real commits and the reviewers' own answers.
    if (!options['fixed-point'] || !options['implementation-result'] || !options['standards-answer'] || !options['standards-id'] || !options['spec-answer'] || !options['spec-id']) throw new Error('assemble needs --fixed-point, --implementation-result, --standards-answer, --standards-id, --spec-answer and --spec-id');
    const additions = await readImplementerAdditions({ root: options.root, resultRef: options['implementation-result'] });
    const reviewInput = await buildReviewInput({ root: options.root, planId: options.plan, fixedPoint: options['fixed-point'], commit: options.commit || 'HEAD', unplannedAdditions: additions });
    const answer = async (path) => readFile(sessionOutputPath(options.root, path, { create: false }), 'utf8');
    const evidence = assembleReviews({ reviewInput, standards: { contextId: options['standards-id'], raw: await answer(options['standards-answer']) }, spec: { contextId: options['spec-id'], raw: await answer(options['spec-answer']) } });
    result = { status: 'pass', reviews: await writeReviewEvidence({ root: options.root, planId: options.plan, evidence }), implementation_commit_sha: reviewInput.implementation_commit_sha, fixed_point: reviewInput.fixed_point };
  } else if (action === 'repair') {
    const evidence = JSON.parse(await readFile(sessionOutputPath(options.root, options.reviews), 'utf8'));
    result = await reserveImplementationRepair({ root: options.root, planId: options.plan, reviewInput: evidence.review_input, reviews: evidence.reviews, scopeDecisions: evidence.scope_decisions ?? [], scopeGroups: evidence.scope_groups ?? [], maxRounds: options['max-rounds'] === undefined ? 1 : Number(options['max-rounds']) });
  } else if (action === 'resolve') result = await reserveImplementationRepair({ root: options.root, planId: options.plan, resolution: options.reason, cycleApproval: options['answers-ref'] ? { answers_ref: options['answers-ref'], question_id: options['question-id'] } : null });
  else throw new Error('Usage: harness-code-review.mjs assemble|repair|resolve --root DIR --plan ID [--reviews SESSION-RELATIVE-JSON] [--max-rounds N] [--reason USER-RESOLUTION] [--answers-ref SESSION-RELATIVE-JSON --question-id ID]');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'pass' && result.state !== 'passed') process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
