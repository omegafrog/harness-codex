import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectTrackerSync, listPlanTickets, readPlanSetTicketStatuses } from '../.harness/src/tracker/lifecycle.mjs';

const repository = 'omegafrog/harness-test';
const refs = [`${repository}#1`, `${repository}#2`];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tracker-mirror-'));
  await mkdir(join(root, '.codex'), { recursive: true });
  await (await import('node:fs/promises')).mkdir(join(root, '.harness'), { recursive: true });
  await writeFile(join(root, '.harness/harness.yaml'), `tracker:\n  mode: github\n  github:\n    repository: ${repository}\n    project_owner: omegafrog\n    project_number: 1\n    status_field: Workflow Status\n`);
  const calls = [];
  const run = async (command, args) => {
    if (command === 'gh' && args[0] === 'project' && args[1] === 'view') return JSON.stringify({ id: 'project-id' });
    if (command === 'gh' && args[0] === 'project' && args[1] === 'field-list') return JSON.stringify({ totalCount: 1, fields: [{ id: 'field-id', name: 'Workflow Status', type: 'ProjectV2SingleSelectField', options: ['Planned', 'In Progress', 'Blocked', 'Done'].map((name) => ({ id: name, name })) }] });
    if (command === 'gh' && args[0] === 'api') {
      const query = args.find((arg) => arg.startsWith('query='));
      if (query.includes('node(id:')) return JSON.stringify({ data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [[1, 'calculator'], [2, 'e2e']].map(([number, plan_id]) => ({ content: { __typename: 'Issue', number, url: `https://github.com/${repository}/issues/${number}`, body: `<!-- harness-plan ${JSON.stringify({ plan_set_id: 'set', plan_id })} -->` } })) } } } });
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
    assert.deepEqual(await readPlanSetTicketStatuses({ workspace_root: root, plan_set_id: 'set', plan_ids: ['calculator', 'e2e', 'unmapped'], run }), [
      { plan_id: 'calculator', ticket_ref: refs[0], status: 'planned' }, { plan_id: 'e2e', ticket_ref: refs[1], status: 'planned' }, { plan_id: 'unmapped', ticket_ref: null, status: null },
    ]);
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
