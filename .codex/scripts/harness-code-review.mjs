#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const installed = new URL('../../.harness/src/wrapper/repair.mjs', import.meta.url);
const { reserveImplementationRepair } = await import(installed.href);
const { prepareBasisRecheck, recordBasisRecheck, verifiedBasisRecheckResults } = await import(new URL('../../.harness/src/wrapper/basis-recheck.mjs', import.meta.url).href);
const { buildReviewInput, readImplementerResult, assembleReviews, carryForwardReview, recordPendingQuestions, recordPassedReview, reviewedCommit, readHookRecordedReviewer, recordScopeDecision, writeReviewEvidence } = await import(new URL('review-input.mjs', installed).href);
const { sessionOutputPath } = await import(new URL('../workflow/session-output.mjs', installed).href);
const { resolveCommandContext, latestReviewResult, reviewFixedPoint } = await import(new URL('../../.harness/src/workflow/cli-context.mjs', import.meta.url).href);
try {
  const [action, ...args] = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    // Accept both `--flag value` and `--flag=value`.
    const [flag, inline] = args[i].includes('=') && args[i].startsWith('--') ? [args[i].slice(0, args[i].indexOf('=')), args[i].slice(args[i].indexOf('=') + 1)] : [args[i], undefined];
    const value = inline !== undefined ? inline : args[++i];
    if (!['--root', '--plan', '--reviews', '--fixed-point', '--commit', '--implementation-result', '--standards-agent', '--spec-agent', '--reuse-axis', '--finding', '--choice', '--answer', '--artifact', '--result'].includes(flag) || !value) throw new Error(`Invalid code-review argument ${flag}${value === undefined ? ' (missing value)' : ''}`);
    options[flag.slice(2)] = value;
  }
  options.root = resolveCommandContext({ root: options.root }).root;
  if (action !== 'spec-items' && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.plan || '')) throw new Error('Valid plan ID is required');
  let result;
  if (action === 'assemble') {
    // Builds runtime/reviews/implementation-<plan>.json for `repair` from the real commits and the reviewers' own answers.
    // The latest review request of this plan and the fixed point its earlier rounds used, unless given.
    options['implementation-result'] ??= latestReviewResult(options.root, options.plan) ?? undefined;
    options['fixed-point'] ??= reviewFixedPoint(options.root, options.plan) ?? undefined;
    const reuse = options['reuse-axis'];
    if (reuse && !['standards', 'spec'].includes(reuse)) throw new Error('--reuse-axis must be standards or spec');
    // --reuse-axis <role> carries that axis's earlier clean pass forward (see carryForwardReview) instead of a new reviewer for it.
    if (!options['fixed-point'] || !options['implementation-result'] || (reuse && options[`${reuse}-agent`]) || (!reuse && options['standards-agent'] && options['standards-agent'] === options['spec-agent'])) throw new Error('assemble needs --fixed-point and --implementation-result; reviewer IDs are optional (the hook-recorded reviewer of each type that finished after the result is used), and the axis named by --reuse-axis takes no agent ID');
    const implemented = await readImplementerResult({ root: options.root, resultRef: options['implementation-result'], commit: options.commit || null });
    if (options.commit && !implemented.commitSha.startsWith(options.commit.toLowerCase())) throw new Error(`--commit ${options.commit} differs from the commit the implementer reported (${implemented.commitSha})`);
    const reviewInput = await buildReviewInput({ root: options.root, planId: options.plan, fixedPoint: options['fixed-point'], commit: implemented.commitSha, unplannedAdditions: implemented.additions });
    const side = async (role) => role === reuse
      ? { carried: await carryForwardReview({ root: options.root, planId: options.plan, role, reviewInput }) }
      : readHookRecordedReviewer({ root: options.root, role, agentId: options[`${role}-agent`] || null, after: implemented.recordedAt });
    const specText = await readFile(resolve(options.root, reviewInput.architecture_spec_path), 'utf8').catch(() => '');
    const specItems = (await import(new URL('../wrapper/spec-items.mjs', installed).href)).extractSpecContractItems(specText);
    const evidence = assembleReviews({ reviewInput, standards: await side('standards'), spec: await side('spec'), specItems });
    result = { status: 'pass', reviews: await writeReviewEvidence({ root: options.root, planId: options.plan, evidence }), implementation_commit_sha: reviewInput.implementation_commit_sha, fixed_point: reviewInput.fixed_point };
  } else if (action === 'record-decision') {
    const { SCOPE_OPTION_LABELS } = await import(installed.href);
    result = { status: 'pass', ...await recordScopeDecision({ root: options.root, planId: options.plan, findingId: options.finding, choice: options.choice, answer: options.answer, labels: SCOPE_OPTION_LABELS }) };
  } else if (action === 'repair') {
    const evidence = JSON.parse(await readFile(sessionOutputPath(options.root, options.reviews), 'utf8'));
    const repairArgs = { root: options.root, planId: options.plan, reviewInput: evidence.review_input, reviews: evidence.reviews, scopeDecisions: evidence.scope_decisions ?? [], scopeGroups: evidence.scope_groups ?? [], specHandoff: evidence.spec_handoff ?? null };
    result = await reserveImplementationRepair(repairArgs);
    if (result.reason === 'basis_unverified' && evidence.basis_recheck_results?.length) {
      const decisions = await verifiedBasisRecheckResults({ root: options.root, planId: options.plan, findings: result.classification.basis_unverified, results: evidence.basis_recheck_results });
      result = await reserveImplementationRepair({ ...repairArgs, basisRechecks: decisions });
    }
    if (result.reason === 'basis_unverified') {
      result.basis_rechecks = [];
      for (const finding of result.classification.basis_unverified) {
        try { result.basis_rechecks.push({ finding_id: finding.id, artifact_ref: await prepareBasisRecheck({ root: options.root, planId: options.plan, reviewInput: evidence.review_input, finding }) }); }
        catch (error) { result.basis_rechecks.push({ finding_id: finding.id, status: 'blocked', reason: 'basis_snapshot_unavailable', message: error.message }); }
      }
      if (result.basis_rechecks.some((item) => item.status === 'blocked')) result.next_action = 'blocked';
    }
    // Remember the hand-off so the next repair of these same reviews asks for a fresh review instead of spec-me again.
    if (result.next_action === 'spec-me' && options.reviews === `runtime/reviews/implementation-${options.plan}-evidence.json`) {
      evidence.spec_handoff = { at: new Date().toISOString(), reviewer_ids: evidence.reviews.map((item) => item.context_id) };
      await writeFile(sessionOutputPath(options.root, options.reviews), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    }
    if (Array.isArray(result.user_questions)) result.user_questions = await recordPendingQuestions({ root: options.root, planId: options.plan, questions: result.user_questions });
    // Remember that this exact commit passed, so re-selecting the plan later does not ask for the same review again.
    if (result.state === 'passed' && options.reviews === `runtime/reviews/implementation-${options.plan}-evidence.json`) await recordPassedReview({ root: options.root, planId: options.plan, evidence });
  } else if (action === 'spec-items') {
    // The Architecture Spec items a Spec reviewer must answer one by one (see report.checked in the code-review guide).
    const { extractSpecContractItems } = await import(new URL('../wrapper/spec-items.mjs', installed).href);
    const { resolveCommandContext } = await import(new URL('../workflow/cli-context.mjs', installed).href);
    const planSetId = resolveCommandContext({ root: options.root }).plan_set_id;
    if (!planSetId) throw new Error('spec-items needs a plan-set worktree');
    const specPath = `docs/specs/${planSetId}/architecture-spec.md`;
    result = { status: 'pass', plan_set_id: planSetId, spec_path: specPath, items: extractSpecContractItems(await readFile(resolve(options.root, specPath), 'utf8')) };
  } else if (action === 'reviewed') {
    result = await reviewedCommit({ root: options.root, planId: options.plan, commit: options.commit });
  } else if (action === 'record-basis-result') {
    if (!options.artifact || !options.result) throw new Error('record-basis-result needs --artifact and --result');
    result = await recordBasisRecheck({ root: options.root, planId: options.plan, artifactRef: options.artifact, result: JSON.parse(await readFile(sessionOutputPath(options.root, options.result), 'utf8')) });
  }
  else throw new Error('Usage: harness-code-review.mjs assemble|record-decision|repair|record-basis-result|reviewed|spec-items [--root DIR] [--plan ID] [--reviews SESSION-RELATIVE-JSON]');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'pass' && result.state !== 'passed') process.exitCode = 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
