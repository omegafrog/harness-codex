import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectTrackerSync } from '../.harness/src/tracker/lifecycle.mjs';

const repository = 'omegafrog/harness-test';
const refs = [`${repository}#1`, `${repository}#2`];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tracker-mirror-'));
  await mkdir(join(root, '.codex'), { recursive: true });
  await mkdir(join(root, '.beads'));
  await writeFile(join(root, '.codex/harness.yaml'), `tracker:\n  mode: github\n  github:\n    repository: ${repository}\n    project_owner: omegafrog\n    project_number: 1\n    status_field: Workflow Status\n`);
  const calls = [];
  const run = async (command, args) => {
    if (command === 'bd' && args.includes('--metadata-field')) return JSON.stringify([1, 2].map((number) => ({ id: `harness-${number}`, status: 'open', external_ref: `https://github.com/${repository}/issues/${number}`, metadata: { harness_tracker_version: 1, harness_phase: 'planning', harness_classification: 'committed' } })));
    if (command === 'bd' && args.includes('--external-ref')) {
      const externalRef = args[args.indexOf('--external-ref') + 1];
      const match = externalRef.match(/issues\/(\d+)$/);
      return JSON.stringify([{ id: `harness-${match[1]}`, status: 'open', external_ref: externalRef, metadata: { harness_tracker_version: 1, harness_phase: 'planning', harness_classification: 'committed' } }]);
    }
    if (command === 'gh' && args[0] === 'project' && args[1] === 'view') return JSON.stringify({ id: 'project-id' });
    if (command === 'gh' && args[0] === 'project' && args[1] === 'field-list') return JSON.stringify({ totalCount: 1, fields: [{ id: 'field-id', name: 'Workflow Status', type: 'ProjectV2SingleSelectField', options: ['Planned', 'In Progress', 'Blocked', 'Done'].map((name) => ({ id: name, name })) }] });
    if (command === 'gh' && args[0] === 'api') {
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

for (const [name, ticket_refs, expectedBeadsCalls] of [['explicit references', refs, 2], ['managed Beads discovery', null, 3]]) {
  test(`GitHub tracker sync resolves Beads URL refs for ${name}`, async () => {
    const { root, calls, run } = await fixture();
    try {
      const result = await inspectTrackerSync({ workspace_root: root, ticket_refs, run: async (command, args, cwd) => {
        const output = await run(command, args, cwd);
        calls.push([command, args]);
        return output;
      } });
      assert.equal(result.status, 'pass', JSON.stringify(result));
      assert.deepEqual(result.tickets.map((ticket) => ticket.ref), refs);
      assert.deepEqual(result.tickets.map((ticket) => ticket.bead_id), ['harness-1', 'harness-2']);
      assert.equal(calls.filter(([command]) => command === 'bd').length, expectedBeadsCalls);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

// In a workflow worktree the check reads only that plan set's mirrors; the primary workspace still checks them all.
test('tracker check in a worktree covers only the worktree plan set', async () => {
  const { root, run } = await fixture();
  try {
    await mkdir(join(root, '.io'), { recursive: true });
    await writeFile(join(root, '.io/worktree.json'), JSON.stringify({ plan_set_id: 'set-a' }));
    const seen = [];
    const result = await inspectTrackerSync({ workspace_root: root, run: async (command, args, cwd) => {
      if (command === 'bd' && args.includes('--metadata-field')) {
        return JSON.stringify([[1, 'set-a'], [2, 'set-a'], [3, 'set-b']].map(([number, set]) => ({ id: `harness-${number}`, status: 'open', external_ref: `https://github.com/${repository}/issues/${number}`, metadata: { harness_tracker_version: 1, harness_phase: 'planning', harness_classification: 'committed', harness_plan_id: `${set}:plan-${number}` } })));
      }
      seen.push(args.join(' '));
      return run(command, args, cwd);
    } });
    assert.equal(result.status, 'pass', JSON.stringify(result));
    assert.deepEqual(result.tickets.map((ticket) => ticket.ref), refs);
    assert.ok(!seen.some((call) => call.includes('issues/3')), 'the other plan set is not read');
  } finally { await rm(root, { recursive: true, force: true }); }
});
