import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';

// tracker-publish activates the published plan set so implementation can start: drafts become Issues, children
// become sub-issues of the parent, and each Issue gets its Beads mirror with the plan dependencies. A rerun only
// completes what is missing, and the result passes the same tracker check implementation uses.
test('installed tracker activation converts drafts, links sub-issues and creates dependent Beads mirrors once', async () => {
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
    const prepared = await preparePublicationDrafts({ root, planSetId: 'example' });
    await writeFile(join(root, '.codex/harness.yaml'), JSON.stringify({ tracker: { mode: 'github', github: { repository: 'owner/repo', project_owner: 'owner', project_number: 8, status_field: 'Workflow Status' } } }));
    await mkdir(join(root, '.beads'), { recursive: true });

    // A fake GitHub Project, repository and Beads store that change as the commands run.
    const items = [];
    for (const [index, draft] of prepared.entries()) items.push({ id: `item-${index}`, status: 'Planned', content: { __typename: 'DraftIssue', title: draft.plan_id, body: (await readFile(join(root, '.io', draft.body_path), 'utf8')).replace(/\n+$/, '') } });
    const issues = new Map(); // number -> { id, subIssues: Set }
    const beads = []; const calls = { convert: 0, subIssue: 0, beadsCreate: 0, dep: [] };
    const fields = { totalCount: 1, fields: [{ id: 'status', name: 'Workflow Status', type: 'ProjectV2SingleSelectField', options: ['Planned', 'In Progress', 'Blocked', 'Done'].map((name) => ({ id: name, name })) }] };
    const run = async (command, args) => {
      if (command === 'gh') {
        if (args[0] === 'project' && args[1] === 'view') return JSON.stringify({ id: 'project' });
        if (args[0] === 'project' && args[1] === 'field-list') return JSON.stringify(fields);
        if (args[0] === 'repo') return JSON.stringify({ id: 'repo-id' });
        const query = args.find((arg) => arg.startsWith('query='))?.slice(6) || '';
        if (query.includes('convertProjectV2DraftIssueItemToIssue')) {
          calls.convert++;
          const item = items.find((entry) => entry.id === JSON.parse(query.match(/itemId:("[^"]+")/)[1]));
          const number = 100 + items.indexOf(item);
          item.content = { ...item.content, __typename: 'Issue', number, url: `https://github.com/owner/repo/issues/${number}` };
          issues.set(number, { id: `issue-${number}`, subIssues: new Set() });
          return JSON.stringify({ data: { convertProjectV2DraftIssueItemToIssue: { item: { id: item.id } } } });
        }
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
        if (query.includes('issue_0:issue')) {
          const repository = Object.fromEntries([...query.matchAll(/issue_(\d+):issue\(number:(\d+)\)/g)].map(([, index, number]) => [`issue_${index}`, { state: 'OPEN', projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: `item-${number}`, project: { id: 'project' }, fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: items.find((item) => item.content.number === Number(number)).status, field: { id: 'status' } }] } }] } }]));
          return JSON.stringify({ data: { repository } });
        }
        if (query.includes('items(first:100')) return JSON.stringify({ data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: items.map((item) => ({ id: item.id, content: item.content, fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: item.status, field: { id: 'status' } }] } })) } } } });
        throw new Error(`Unexpected gh query: ${query.slice(0, 80)}`);
      }
      if (command === 'bd') {
        const value = (flag) => args[args.indexOf(flag) + 1];
        if (args[0] === 'list') return JSON.stringify(beads.filter((bead) => !args.includes('--external-ref') || bead.external_ref === value('--external-ref')));
        if (args[0] === 'create') { calls.beadsCreate++; const bead = { id: `b-${beads.length + 1}`, status: value('--status'), external_ref: value('--external-ref'), metadata: JSON.parse(value('--metadata')), parent: args.includes('--parent') ? value('--parent') : null, dependencies: [] }; beads.push(bead); return `${bead.id}\n`; }
        if (args[0] === 'show') return JSON.stringify([beads.find((bead) => bead.id === args[1])]);
        if (args[0] === 'dep') { calls.dep.push(args.slice(2)); beads.find((bead) => bead.id === args[2]).dependencies.push({ id: args[3] }); return ''; }
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    };

    await assert.rejects(verifyActivatedPublication({ root, planSetId: 'example', run }), /not activated as Issues yet/);
    const result = await activatePublication({ root, planSetId: 'example', run });
    assert.equal(result.status, 'activated');
    assert.deepEqual(result.issues.map((issue) => issue.number), [100, 101, 102]);
    assert.equal(calls.convert, 3);
    assert.deepEqual([...issues.get(100).subIssues].sort(), ['issue-101', 'issue-102']);
    const byPlan = Object.fromEntries(beads.map((bead) => [bead.metadata.harness_plan_id, bead]));
    assert.equal(byPlan['example:parent'].parent, null);
    assert.equal(byPlan['example:auth'].parent, byPlan['example:parent'].id);
    assert.deepEqual(calls.dep, [[byPlan['example:posts'].id, byPlan['example:auth'].id]], 'posts waits for auth, from the plan index');
    assert.ok(beads.every((bead) => bead.status === 'open' && bead.metadata.harness_tracker_version === 1));
    await verifyActivatedPublication({ root, planSetId: 'example', run });

    // A rerun converts, links and creates nothing more.
    await activatePublication({ root, planSetId: 'example', run });
    assert.equal(calls.convert, 3);
    assert.equal(calls.subIssue, 2);
    assert.equal(calls.beadsCreate, 3);
    assert.equal(calls.dep.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
