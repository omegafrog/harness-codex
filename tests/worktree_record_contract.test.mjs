import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorktreeRecord } from '../src/workflow/worktrees.mjs';
import { recordExecutionState } from '../src/workflow/execution-state.mjs';
import { WORKTREE_STAGE } from '../src/workflow/worktree-stages.mjs';

const record = {
  schema_version: 1,
  worktree_id: 'a77aaa03-329c-4d59-b4c5-269746a893f2',
  workspace: '/project/worktree',
  common: '/project/.git',
  return_root: '/project',
  session_directory: '/project/worktree/.io',
  branch: 'harness/worktree/example',
  state: 'active',
};
const parse = (value) => parseWorktreeRecord(JSON.stringify(value));

test('stage enum defines allowed skill values', () => {
  assert.equal(WORKTREE_STAGE.WORKFLOW_COMPOSE, 'workflow-compose');
  assert.equal(WORKTREE_STAGE.SPEC_ME, 'spec-me');
  assert.throws(() => parse({ ...record, current_stage: 'unknown' }), /Invalid worktree current_stage/);
});

test('worktree record accepts lifecycle states and defaults source workspace', () => {
  for (const state of ['allocating', 'active', 'archived', 'removed', 'cleanup-failed']) {
    assert.equal(parse({ ...record, state }).source_workspace, record.return_root);
  }
  assert.equal(parse({ ...record, plan_set_id: 'calculator-web-app' }).plan_set_id, 'calculator-web-app');
  assert.throws(() => parse({ ...record, state: 'created' }), /Invalid worktree/);
  assert.throws(() => parse({ ...record, plan_set_id: '../outside' }), /Invalid plan_set_id/);
  assert.throws(() => parse({ ...record, workspace: 'relative' }), /Invalid worktree/);
  assert.equal(parse({ ...record, current_stage: 'workflow-compose' }).current_stage, 'workflow-compose');
  assert.throws(() => parse({ ...record, current_stage: '../spec' }), /Invalid worktree current_stage/);
});

test('worktree record validates agent session identifiers', () => {
  const agent_sessions = { 'stage:spec': { session_id: record.worktree_id, execution_id: 'spec-1' } };
  assert.deepEqual(parse({ ...record, agent_sessions }).agent_sessions, agent_sessions);
  assert.throws(() => parse({ ...record, agent_sessions: { 'stage:spec': { session_id: 'bad', execution_id: 'spec-1' } } }), /Invalid worktree agent session/);
});

test('workflow composition records the initial stage in the workflow file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-contract-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const session = join(root, '.io');
    const directory = join(session, 'runtime', 'orchestrator');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'workflow.json');
    await writeFile(path, JSON.stringify({ schema_version: 1, workflow_id: 'example', scope: 'Example', stages: [{ id: 'spec', skill: 'spec-me' }] }));
    const input = { skill: 'workflow-compose', execution_id: 'compose-1', session_directory: session, context: { stage_id: 'workflow-compose' } };
    await recordExecutionState({ root, input, binding: { model: 'example', reasoning_effort: 'low' }, status: 'completed', code: 'OK' });
    const workflow = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(workflow.state.status, 'created');
    assert.equal(workflow.state.current_stage, 'spec');
    await assert.rejects(readFile(join(directory, 'state.json')), { code: 'ENOENT' });
    const bad = { ...input, skill: 'spec-me', execution_id: 'bad-1', context: { stage_id: 'unknown', workflow_ref: 'runtime/orchestrator/workflow.json' } };
    await assert.rejects(recordExecutionState({ root, input: bad, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' }), /Current stage is not in the workflow/);
    const child = { ...bad, execution_id: 'child-1', context: { ...bad.context, stage_id: 'child-1', parent_stage_id: 'spec' } };
    await recordExecutionState({ root, input: child, binding: { model: 'example', reasoning_effort: 'low' }, status: 'running' });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).state.current_stage, 'spec');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
