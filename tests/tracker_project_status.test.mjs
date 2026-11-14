import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';

test('installed tracker marks execution in progress but leaves Done until PR merge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tracker-project-status-'));
  const sourceRoot = resolve('.');
  const fields = [
    { id: 'workflow', name: 'Workflow Status', type: 'ProjectV2SingleSelectField', options: ['Planned', 'In Progress', 'Blocked', 'Done'].map((name) => ({ id: `workflow-${name}`, name })) },
    { id: 'status', name: 'Status', type: 'ProjectV2SingleSelectField', options: ['Todo', 'In Progress', 'Done'].map((name) => ({ id: `status-${name}`, name })) },
  ];
  const values = new Map([['workflow', 'Planned'], ['status', 'Todo']]);
  const edits = [];
  const run = async (command, args) => {
    if (command === 'gh' && args[0] === 'project' && args[1] === 'view') return JSON.stringify({ id: 'project-id' });
    if (command === 'gh' && args[0] === 'project' && args[1] === 'field-list') return JSON.stringify({ totalCount: fields.length, fields });
    if (command === 'gh' && args[0] === 'api') return JSON.stringify({ data: { repository: { issue_0: { state: 'OPEN', projectItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'item-id', project: { id: 'project-id' }, fieldValues: { pageInfo: { hasNextPage: false }, nodes: fields.map((field) => ({ name: values.get(field.id), field: { id: field.id } })) } }] } } } } });
    if (command === 'gh' && args[0] === 'project' && args[1] === 'item-edit') {
      const fieldId = args[args.indexOf('--field-id') + 1], optionId = args[args.indexOf('--single-select-option-id') + 1];
      const field = fields.find((item) => item.id === fieldId);
      values.set(fieldId, field.options.find((option) => option.id === optionId).name);
      edits.push([fieldId, values.get(fieldId)]);
      return '';
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    await protectLocalInstallArtifacts(root, sourceRoot);
    await updateProject({ sourceRoot, targetRoot: root, initialize: true });
    await updateProject({ sourceRoot, targetRoot: root });
    await mkdir(join(root, '.codex'), { recursive: true });
    await mkdir(join(root, '.io/runtime'), { recursive: true });
    await (await import('node:fs/promises')).mkdir(join(root, '.harness'), { recursive: true });
    await writeFile(join(root, '.harness/harness.yaml'), 'tracker:\n  mode: github\n  github:\n    repository: owner/repo\n    project_owner: owner\n    project_number: 1\n    status_field: Workflow Status\nbeads:\n  enabled: false\n');
    await writeFile(join(root, 'consumer-change.txt'), 'preserve');
    const lifecycleUrl = pathToFileURL(join(root, '.harness/src/tracker/lifecycle.mjs')).href;
    const { inspectTrackerSync, readTrackerStatus, syncTrackerStatus } = await import(lifecycleUrl);
    const started = await syncTrackerStatus({ workspace_root: root, ticket_ref: 'owner/repo#1', status: 'in-progress', run });
    assert.equal(started.status, 'pass', JSON.stringify(started));
    assert.deepEqual(edits, [['workflow', 'In Progress'], ['status', 'In Progress']]);
    const completed = await syncTrackerStatus({ workspace_root: root, ticket_ref: 'owner/repo#1', status: 'completed', run });
    assert.equal(completed.status, 'pass', JSON.stringify(completed));
    assert.deepEqual(edits, [['workflow', 'In Progress'], ['status', 'In Progress'], ['workflow', 'Done']], 'completion updates only canonical Workflow Status before PR merge');
    const current = await readTrackerStatus({ workspace_root: root, ticket_ref: 'owner/repo#1', run });
    assert.equal(current.canonical_status, 'completed');
    assert.equal(current.project_status, 'In Progress');
    assert.equal(current.issue_state, 'OPEN');
    assert.equal((await inspectTrackerSync({ workspace_root: root, ticket_refs: ['owner/repo#1'], run })).status, 'pass');
    const gitStatus = execFileSync('git', ['-C', root, 'status', '--short', '-uall'], { encoding: 'utf8' });
    assert.match(gitStatus, /consumer-change\.txt/);
    assert.doesNotMatch(gitStatus, /\.harness\/src\//);
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '.harness/src/tracker/lifecycle.mjs']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
