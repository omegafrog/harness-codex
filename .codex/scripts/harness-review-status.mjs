#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const installed = new URL('../harness-runtime/src/workflow/review-attempts.mjs', import.meta.url);
const runtime = existsSync(installed) ? installed : new URL('../../src/workflow/review-attempts.mjs', import.meta.url);
const { inspectReviewHistory } = await import(runtime.href);
const { sessionOutputPath } = await import(new URL('./session-output.mjs', runtime).href);
const { implementationReviewRoot, classifyReviewFindings, validReviewProvenance } = await import(new URL('../wrapper/repair.mjs', runtime).href);
try {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!['--root', '--spec-root', '--ticket', '--plan-set', '--plan', '--reviews'].includes(flag) || !value || options[flag]) throw new Error('Invalid review status arguments');
    options[flag] = value;
  }
  if (!options['--root'] || !['--ticket', '--plan-set', '--plan'].some((key) => options[key])) throw new Error('Usage: harness-review-status.mjs --root DIR [--spec-root DIR] [--ticket ID] [--plan-set ID] [--plan ID] [--reviews SESSION-RELATIVE-JSON]');
  for (const key of ['--ticket', '--plan-set', '--plan']) if (options[key] && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options[key])) throw new Error('Invalid review scope ID');
  const root = resolve(options['--root']), specRoot = resolve(options['--spec-root'] || root);
  const primary = implementationReviewRoot(root);
  if (implementationReviewRoot(specRoot) !== primary) throw new Error('Spec and plan roots must share the same repository');
  const scopes = [];
  if (options['--ticket']) scopes.push({ root: specRoot, scope: `spec-${options['--ticket']}-architecture` });
  if (options['--plan-set']) scopes.push({ root, scope: `plan-${options['--plan-set']}` });
  if (options['--plan']) scopes.push({ root: primary, scope: `implementation-${options['--plan']}` });
  const records = await Promise.all(scopes.map(async (scope) => {
    try { return await inspectReviewHistory(scope); }
    catch (error) { return { ...scope, recorded_state: 'unreadable', error: error.message }; }
  }));
  const result = { status: records.some((item) => item.error) ? 'blocked' : 'pass', reason: 'recorded_review_history_only', records };
  if (options['--reviews']) {
    try {
      const evidence = JSON.parse(await readFile(sessionOutputPath(root, options['--reviews'], { create: false }), 'utf8'));
      if (resolve(evidence.review_input?.repository || '') !== root) throw new Error('Review evidence belongs to another workspace');
      if (!validReviewProvenance(evidence.reviews, evidence.review_input.implementation_commit_sha, evidence.review_input)) throw new Error('Both reviewers must match the same complete fixed-point input');
      result.implementation_findings = { implementation_commit_sha: evidence.review_input?.implementation_commit_sha, ...classifyReviewFindings(evidence.reviews) };
    } catch (error) { result.status = 'blocked'; result.implementation_findings = { error: error.message }; }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'pass') process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
