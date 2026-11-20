#!/usr/bin/env node
const { updatePublication, publicationDraftFingerprint } = await import('../src/tracker/publication.mjs');
const { resolveCommandContext } = await import(new URL('../src/workflow/cli-context.mjs', import.meta.url).href);
const { readExecutionInput, readSkillSessionJson, validateSkillInput } = await import('../src/workflow/skill-execution.mjs');

try {
  const [action, ...args] = process.argv.slice(2);
  const options = { action };
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--root': 'root', '--plan-set': 'planSetId', '--plan': 'planId' }[args[i]];
    if (!key || !args[i + 1] || Object.hasOwn(options, key) && key !== 'root') throw new Error('Invalid publication argument');
    options[key] = args[i + 1];
  }
  { const ctx = resolveCommandContext({ root: options.root, planSetId: options.planSetId }); options.root = ctx.root; options.planSetId = ctx.plan_set_id ?? undefined; }
  if (['publish', 'activate'].includes(action)) {
    const root = options.root;
    const workflow = await readSkillSessionJson({ root, path: 'runtime/orchestrator/workflow.json' }).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    const state = workflow?.state || await readSkillSessionJson({ root, path: 'runtime/orchestrator/state.json' });
    const publisher = state.stages?.['tracker-publish'];
    if (state.current_stage !== 'tracker-publish' || publisher?.status !== 'running') throw new Error('Publication mutation requires the active, user-approved tracker-publish execution');
    const input = await readExecutionInput({ root, execution_id: publisher.execution_id });
    const approvedSnapshot = input.context?.publication_review_snapshot_sha256;
    const ticket = state.stages?.['to-ticket'];
    const approvedDrafts = input.context?.publication_drafts;
    if (input.skill !== 'tracker-publish' || input.context.plan_set_id !== options.planSetId || !approvedSnapshot || ticket?.status !== 'completed' || ticket.stale || approvedSnapshot !== ticket.review_snapshot_sha256
      || !Array.isArray(approvedDrafts) || publicationDraftFingerprint(approvedDrafts) !== ticket.publication_drafts_sha256) throw new Error('Publication approval no longer matches the completed plan review snapshot and final body hashes');
    await validateSkillInput({ root, input });
    options.expectedSnapshotSha256 = approvedSnapshot;
    options.expectedDraftsSha256 = ticket.publication_drafts_sha256;
  }
  process.stdout.write(`${JSON.stringify(await updatePublication(options))}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
