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
  const edits = [], calls = [];
  const run = async (command, args) => {
    calls.push(args.slice(0, 2).join(' '));
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
    await writeFile(join(root, '.harness/harness.yaml'), 'tracker:\n  mode: github\n  github:\n    repository: owner/repo\n    project_owner: owner\n    project_number: 1\n    status_field: Workflow Status\n');
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
    assert.equal(calls.filter((call) => call === 'project view').length, 1);
    assert.equal(calls.filter((call) => call === 'project field-list').length, 1);
    values.set('workflow', 'Blocked');
    assert.equal((await readTrackerStatus({ workspace_root: root, ticket_ref: 'owner/repo#1', run })).canonical_status, 'blocked');
    assert.equal(calls.filter((call) => call === 'project field-list').length, 1);
    fields[0].id = 'workflow-recreated';
    values.set(fields[0].id, 'Planned');
    assert.equal((await readTrackerStatus({ workspace_root: root, ticket_ref: 'owner/repo#1', run })).status, 'fail');
    assert.equal((await readTrackerStatus({ workspace_root: root, ticket_ref: 'owner/repo#1', run })).canonical_status, 'planned');
    assert.equal(calls.filter((call) => call === 'project field-list').length, 2);

    const ref = 'owner/repo#1';
    const blockedRead = async () => { throw new Error('Project read rate limited'); };
    const unobserved = await inspectTrackerSync({ workspace_root: root, ticket_refs: [ref], run: blockedRead });
    assert.equal(unobserved.status, 'unverified');
    assert.match(unobserved.warnings[0], /Project read rate limited/);
    assert.deepEqual(unobserved.ticket_refs, [ref]);
    const mismatch = await inspectTrackerSync({ workspace_root: root, ticket_refs: [ref], expected_status: 'completed', run });
    assert.equal(mismatch.status, 'unverified');
    assert.equal(mismatch.reason, 'project_status_mismatch');
    assert.match(mismatch.warnings[0], /expected completed, observed planned/);
    const failedWrite = await syncTrackerStatus({ workspace_root: root, ticket_ref: ref, status: 'completed', run: async (command, args) => {
      if (args[0] === 'project' && args[1] === 'item-edit') throw new Error('Project write denied');
      return run(command, args);
    } });
    assert.equal(failedWrite.status, 'fail');
    assert.equal(failedWrite.tracker_updated, false);
    assert.match(failedWrite.violations[0], /Project write denied/);

    const bin = join(root, '.io/bin');
    await mkdir(bin);
    await writeFile(join(bin, 'gh'), '#!/bin/sh\necho "Project status cannot be read" >&2\nexit 1\n', { mode: 0o700 });
    const gateUrl = pathToFileURL(join(root, '.harness/src/gates/lifecycle.mjs')).href;
    const completionUrl = pathToFileURL(join(root, '.harness/src/workflow/completion.mjs')).href;
    const gateCode = `
      await import(${JSON.stringify(completionUrl)});
      const { LifecycleGateRegistry } = await import(${JSON.stringify(gateUrl)});
      const registry = new LifecycleGateRegistry();
      registry.registerHook('before_complete', ['tracker_sync']);
      const state = { workspace_root: ${JSON.stringify(root)}, tracker_sync: { ticket_refs: ['owner/repo#1'] } };
      const verdict = await registry.run('before_complete', state, { eventWriter: { append() {} } });
      console.log(JSON.stringify(verdict));
    `;
    const gate = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', gateCode], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    }));
    assert.equal(gate.status, 'pass', 'the configured optional project does not block unrelated completion checks');
    assert.equal(gate.reason, 'checks_passed_with_unverified_evidence');
    assert.equal(gate.checks[0].status, 'unverified');
    assert.match(gate.checks[0].details.warnings[0], /Project status cannot be read/);

    const gitStatus = execFileSync('git', ['-C', root, 'status', '--short', '-uall'], { encoding: 'utf8' });
    assert.match(gitStatus, /consumer-change\.txt/);
    assert.doesNotMatch(gitStatus, /\.harness\/src\/|\.io\//);
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '.harness/src/tracker/lifecycle.mjs']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
