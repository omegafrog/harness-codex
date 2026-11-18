import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';

// tracker-publish activates the published plan set so implementation can start: drafts become Issues, children
// become sub-issues of the parent. A rerun only
// completes what is missing, and the result passes the same tracker check implementation uses.
test('installed tracker activation links directly published Issues despite Project failure', async () => {
  const sourceRoot = resolve('.');
  await mkdir('.io/runtime', { recursive: true });
  const directory = await mkdtemp(resolve('.io/runtime/tracker-activation-'));
  const primary = join(directory, 'primary');
  const root = join(directory, 'workspace');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', primary]);
    execFileSync('git', ['-C', primary, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '--allow-empty', '-qm', 'base']);
    execFileSync('git', ['-C', primary, 'worktree', 'add', '-qb', 'feature/test', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    const runtime = (path) => pathToFileURL(join(root, '.harness/src', path)).href;
    const { snapshotPlanSet } = await import(runtime('workflow/plan-review.mjs'));
    const { updateReviewAttempt } = await import(runtime('workflow/review-attempts.mjs'));
    const { preparePublicationDrafts, activatePublication, verifyActivatedPublication } = await import(runtime('tracker/publication.mjs'));
    const { listPlanTickets } = await import(runtime('tracker/lifecycle.mjs'));
    await mkdir(join(root, '.io'), { recursive: true });
    await writeFile(join(root, '.io/worktree.json'), JSON.stringify({ schema_version: 1, worktree_id: 'c5c669a2-2967-4831-98db-63a24954e857', workspace: root, common: join(primary, '.git'), return_root: primary, session_directory: join(root, '.io'), branch: 'feature/test', state: 'active', plan_set_id: 'example' }));
    const plans = join(root, 'docs/plans/example'), specs = join(root, 'docs/specs/example'), drafts = join(root, '.io/runtime/to-ticket/drafts');
    for (const path of [plans, specs, drafts, join(root, 'docs/agents')]) await mkdir(path, { recursive: true });
    await writeFile(join(root, 'docs/agents/EXEC.md'), '');
    for (const id of ['auth', 'posts']) await writeFile(join(plans, `${id}.md`), `# ${id}\nDo ${id}.\n`);
    await writeFile(join(plans, 'plans.md'), '# Plans\n\n| 순서 | Plan | Issue | 범위 | 의존성 | 토큰 |\n|---|---|---|---|---|---|\n| 1 | [auth](auth.md) | #35 | 로그인 | 없음 | 1 |\n| 2 | [posts](posts.md) | #38 | 글 | auth (인증 경계) | 1 |\n');
    for (const name of ['product', 'architecture']) await writeFile(join(specs, `${name}-spec.md`), `# ${name}\n`);
    for (const name of ['parent', 'auth', 'posts']) await writeFile(join(drafts, `${name}.md`), `${name}\n`);
    const snapshot = await snapshotPlanSet({ root, planSetId: 'example' });
    const admission = await updateReviewAttempt({ root, scope: 'plan-example', action: 'begin', inputs: snapshot.inputs });
    await updateReviewAttempt({ root, scope: 'plan-example', action: 'record', attemptId: admission.attempt_id, inputs: snapshot.inputs, review: { reviewer_id: 'reviewer', author_ids: ['writer'], fork_turns: 'none', verdict: 'pass', findings: [] } });
    await (await import('node:fs/promises')).mkdir(join(root, '.harness'), { recursive: true });
    await writeFile(join(root, '.harness/harness.yaml'), JSON.stringify({ tracker: { mode: 'github', github: { repository: 'owner/repo', project_owner: 'owner', project_number: 8, status_field: 'Workflow Status' } } }));
    const prepared = await preparePublicationDrafts({ root, planSetId: 'example' });

    const items = [];
    const issues = new Map();
    for (const [index, draft] of prepared.entries()) {
      const number = 100 + index;
      items.push({ number, html_url: `https://github.com/owner/repo/issues/${number}`, body: await readFile(join(root, '.io', draft.body_path), 'utf8') });
      issues.set(number, { id: `issue-${number}`, subIssues: new Set() });
    }
    const calls = { subIssue: 0, labels: new Set(), appliedLabels: [] };
    const run = async (command, args) => {
      if (command === 'gh') {
        if (args[0] === 'project') throw new Error('Project rate limit');
        if (args[0] === 'label' && args[1] === 'list') return JSON.stringify([...calls.labels].map((name) => ({ name })));
        if (args[0] === 'label' && args[1] === 'create') { calls.labels.add(args[2]); return ''; }
        if (args[0] === 'api' && args[1] === '--paginate') return JSON.stringify([items]);
        if (args[0] === 'issue' && args[1] === 'edit') { calls.appliedLabels.push([args[2], args[args.indexOf('--add-label') + 1]]); return ''; }
        const query = args.find((arg) => arg.startsWith('query='))?.slice(6) || '';
        if (query.includes('addSubIssue')) {
          calls.subIssue++;
          const [, parentId, childId] = query.match(/issueId:"([^"]+)",subIssueId:"([^"]+)"/);
          [...issues.values()].find((issue) => issue.id === parentId).subIssues.add(childId);
          return JSON.stringify({ data: { addSubIssue: { subIssue: { id: childId } } } });
        }
        if (query.includes('subIssues(first')) {
          const number = Number(query.match(/issue\(number:(\d+)\)/)[1]);
          const issue = issues.get(number);
          return JSON.stringify({ data: { repository: { issue: { id: issue.id, subIssues: { nodes: [...issue.subIssues].map((id) => ({ id })) } } } } });
        }
        throw new Error(`Unexpected gh query: ${query.slice(0, 80)}`);
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    };

    const result = await activatePublication({ root, planSetId: 'example', run });
    assert.equal(result.status, 'activated');
    assert.match(result.warnings[0], /Project rate limit/);
    assert.deepEqual(result.issues.map((issue) => issue.number), [100, 101, 102]);
    assert.deepEqual([...calls.labels].sort(), ['harness:intake', 'harness:plan', 'harness:plan-set']);
    assert.deepEqual(calls.appliedLabels, [['100', 'harness:plan-set'], ['101', 'harness:plan'], ['102', 'harness:plan']]);
    assert.deepEqual([...issues.get(100).subIssues].sort(), ['issue-101', 'issue-102']);
    await verifyActivatedPublication({ root, planSetId: 'example', run: async () => { throw new Error('unexpected GitHub call'); } });
    const { syncTrackerStatus } = await import(runtime('tracker/lifecycle.mjs'));
    const warning = await syncTrackerStatus({ workspace_root: root, ticket_ref: 'owner/repo#101', status: 'in-progress', run: async () => { throw new Error('rate limit'); } });
    assert.equal(warning.status, 'pass');
    assert.equal(warning.tracker_updated, false);
    assert.match(warning.warnings[0], /rate limit/);
    items[1].body = items[1].body.replace(/<!-- harness-plan [^\n]* -->/, '').trimEnd();
    assert.deepEqual(await listPlanTickets({ workspace_root: root, plan_set_id: 'example', run }), [
      { plan_id: 'auth', ticket_ref: 'owner/repo#101' }, { plan_id: 'posts', ticket_ref: 'owner/repo#102' },
    ], 'the recorded Issue link survives removal of the Issue body marker');

    // A rerun adds no duplicate links.
    await activatePublication({ root, planSetId: 'example', run });
    assert.equal(calls.subIssue, 2);
    assert.equal(calls.labels.size, 3, 'reruns do not recreate taxonomy labels');
    assert.equal(calls.appliedLabels.length, 6, 'reruns safely reapply labels');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// A local-markdown plan file is already its own ticket, so publication prepares no GitHub Issue drafts for it.
test('local-markdown publication prepares no Issue drafts', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { preparePublicationDrafts } = await import('../.harness/src/tracker/publication.mjs');
  const root = await mkdtemp(join(tmpdir(), 'harness-local-publish-'));
  try {
    await mkdir(join(root, '.harness'), { recursive: true });
    await writeFile(join(root, '.harness/harness.yaml'), 'tracker:\n  mode: local-markdown\n');
    // Without a reviewed plan set the preparation still refuses; the mode only decides whether drafts are read afterwards.
    await assert.rejects(preparePublicationDrafts({ root, planSetId: 'example' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

// implement-wrapper reads completed/OK after every single plan, so sync-contracts must wait for the plan set's own tracker.
test('sync-contracts waits until every plan of the set is completed in the local tracker', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { assertEveryPlanCompleted } = await import('../.harness/src/workflow/stage-input.mjs');
  const root = await mkdtemp(join(tmpdir(), 'harness-all-plans-'));
  try {
    await mkdir(join(root, '.harness'), { recursive: true });
    await writeFile(join(root, '.harness/harness.yaml'), 'tracker:\n  mode: local-markdown\n  local_markdown:\n    directory: docs/plans\n');
    await mkdir(join(root, 'docs/plans/set'), { recursive: true });
    const write = (id, status) => writeFile(join(root, `docs/plans/set/${id}.md`), `---\nstatus: ${status}\n---\n# ${id}\n`);
    await write('a', 'completed'); await write('b', 'planned');
    await assert.rejects(assertEveryPlanCompleted({ root, planSetId: 'set', planIds: ['a', 'b'] }), /still open: b/);
    await write('b', 'completed');
    await assertEveryPlanCompleted({ root, planSetId: 'set', planIds: ['a', 'b'] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
