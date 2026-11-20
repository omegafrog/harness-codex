import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectTrackerSync, listPlanTickets, readPlanSetTicketStatuses } from '../.harness/src/tracker/lifecycle.mjs';
import { sessionOutputPath } from '../.harness/src/workflow/session-output.mjs';

const repository = 'omegafrog/harness-test';
const refs = [`${repository}#1`, `${repository}#2`];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tracker-mirror-'));
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, '.codex'), { recursive: true });
  await mkdir(join(root, '.io'), { recursive: true });
  await (await import('node:fs/promises')).mkdir(join(root, '.harness'), { recursive: true });
  await writeFile(join(root, '.harness/harness.yaml'), `tracker:\n  mode: github\n  github:\n    repository: ${repository}\n    project_owner: omegafrog\n    project_number: 1\n    status_field: Workflow Status\n`);
  await mkdir(join(root, 'docs/plans/set'), { recursive: true });
  for (const id of ['calculator', 'e2e', 'unmapped']) await writeFile(join(root, `docs/plans/set/${id}.md`), `---\nstatus: planned\n---\n# ${id}\n`);
  await writeFile(join(root, '.io/worktree.json'), JSON.stringify({ plan_set_id: 'set' }));
  await writeFile(sessionOutputPath(root, 'runtime/to-ticket/set-issues.json'), JSON.stringify({ repository, tickets: [{ plan_id: 'calculator', ticket_ref: refs[0] }, { plan_id: 'e2e', ticket_ref: refs[1] }] }));
  const calls = [];
  const run = async (command, args) => {
    if (command === 'gh' && args[0] === 'project' && args[1] === 'view') return JSON.stringify({ id: 'project-id' });
    if (command === 'gh' && args[0] === 'project' && args[1] === 'field-list') return JSON.stringify({ totalCount: 1, fields: [{ id: 'field-id', name: 'Workflow Status', type: 'ProjectV2SingleSelectField', options: ['Planned', 'In Progress', 'Blocked', 'Done'].map((name) => ({ id: name, name })) }] });
    if (command === 'gh' && args[0] === 'api') {
      if (args[1] === '--paginate') return JSON.stringify([[[1, 'calculator'], [2, 'e2e']].map(([number, plan_id]) => ({
        number, html_url: `https://github.com/${repository}/issues/${number}`,
        body: `<!-- harness-plan ${JSON.stringify({ plan_set_id: 'set', plan_id })} -->`,
      }))]);
      const query = args.find((arg) => arg.startsWith('query='));

      const issues = [...query.matchAll(/issue_(\d+):issue\(number:(\d+)\)/g)];
      const tickets = Object.fromEntries(issues.map(([, index, number]) => [`issue_${index}`, {
        state: 'OPEN',
        projectItems: { pageInfo: { hasNextPage: false }, nodes: [{
          id: `item-${number}`, project: { id: 'project-id' },
          fieldValues: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'Planned', field: { id: 'field-id' } }] },
        }] },
      }]));
      return JSON.stringify({ data: { repository: tickets } });
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { root, calls, run };
}

test('GitHub tracker checks explicit references without an external mirror', async () => {
  const { root, run } = await fixture();
  try {
    const result = await inspectTrackerSync({ workspace_root: root, ticket_refs: refs, run });
    assert.equal(result.status, 'pass', JSON.stringify(result));
    assert.deepEqual(result.tickets.map((ticket) => ticket.ref), refs);
    assert.equal(result.mirror_status, 'available');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tickets are checked against the plan a stage implements', async () => {
  const { root, run } = await fixture();
  try {
    const mismatch = await inspectTrackerSync({ workspace_root: root, ticket_refs: [refs[1]], expected_plan_id: 'set:calculator', run });
    assert.equal(mismatch.status, 'fail');
    const match = await inspectTrackerSync({ workspace_root: root, ticket_refs: [refs[0]], expected_plan_id: 'set:calculator', run });
    assert.equal(match.status, 'pass', JSON.stringify(match));
    assert.deepEqual(await listPlanTickets({ workspace_root: root, plan_set_id: 'set', run }), [
      { plan_id: 'calculator', ticket_ref: refs[0] }, { plan_id: 'e2e', ticket_ref: refs[1] },
    ]);
    assert.deepEqual((await readPlanSetTicketStatuses({ workspace_root: root, plan_set_id: 'set', plan_ids: ['calculator', 'e2e', 'unmapped'], run })).map(({ plan_id, status }) => ({ plan_id, status })), [
      { plan_id: 'calculator', status: 'planned' }, { plan_id: 'e2e', status: 'planned' }, { plan_id: 'unmapped', status: 'planned' },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local plan status remains authoritative when GitHub status lookup is unavailable', async () => {
  const { root, run } = await fixture();
  try {
    const local = await readPlanSetTicketStatuses({ workspace_root: root, plan_set_id: 'set', plan_ids: ['calculator'], run: async () => { throw new Error('rate limit'); } });
    assert.equal(local[0].status, 'planned');
    const checked = await inspectTrackerSync({ workspace_root: root, expected_plan_id: 'set:calculator', ticket_refs: [refs[0]], run: async () => { throw new Error('rate limit'); } });
    assert.equal(checked.status, 'pass', JSON.stringify(checked));
    assert.equal(checked.local_status, 'planned');
    assert.equal(checked.mirror_status, 'unavailable');
    assert.match(checked.warnings[0], /rate limit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('plan-scoped local tracker checks only the selected plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tracker-plan-scope-'));
  try {
    await mkdir(join(root, '.harness'), { recursive: true });
    await mkdir(join(root, 'docs/plans/set'), { recursive: true });
    await writeFile(join(root, '.harness/harness.yaml'), 'tracker:\n  mode: local-markdown\n');
    for (const id of ['P01', 'P02', 'P03']) await writeFile(join(root, `docs/plans/set/${id}.md`), `---\nstatus: planned\n---\n# ${id}\n`);
    const scoped = await inspectTrackerSync({ workspace_root: root, expected_plan_id: 'set:P02' });
    assert.equal(scoped.status, 'pass', JSON.stringify(scoped));
    assert.deepEqual(scoped.tickets.map((ticket) => ticket.ref), ['docs/plans/set/P02.md']);
    const wrong = await inspectTrackerSync({ workspace_root: root, ticket_refs: ['docs/plans/set/P03.md'], expected_plan_id: 'set:P02' });
    assert.equal(wrong.status, 'fail');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('leftover unreviewed plan drafts do not fail the tracker preflight of other stages', async () => {
  const { root, run } = await fixture();
  try {
    // A to-ticket draft that was never reviewed or published: its publication bodies cannot exist yet.
    await mkdir(join(root, 'docs/plans/set'), { recursive: true });
    await mkdir(join(root, '.io/runtime/to-ticket/drafts'), { recursive: true });
    await writeFile(join(root, 'docs/plans/set/plans.md'), '# plans\n');
    await writeFile(join(root, 'docs/plans/set/draft-only.md'), '# draft\n');
    await writeFile(join(root, '.io/runtime/to-ticket/drafts/parent.md'), '# parent\n');
    const sync = await inspectTrackerSync({ workspace_root: root, expected_plan_id: 'set:calculator', run });
    assert.equal(sync.status, 'pass', JSON.stringify(sync));
    // Already published tickets stay checked.
    assert.deepEqual(sync.tickets.map((ticket) => ticket.ref), [refs[0]]);
    assert.deepEqual((await listPlanTickets({ workspace_root: root, plan_set_id: 'set', run })).map((ticket) => ticket.plan_id), ['calculator', 'e2e']);
    // Publication bodies are still required where publication happens.
    const { preparePublicationDrafts } = await import('../.harness/src/tracker/publication.mjs');
    await assert.rejects(preparePublicationDrafts({ root, planSetId: 'set' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
