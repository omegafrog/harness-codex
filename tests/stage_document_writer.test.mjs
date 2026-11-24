import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { consumerWorkflow, stakeholderAnalysisDocument } from './support/consumer-workflow.mjs';
import { authorsOwnDocuments, assertStageDocumentWriterCompleted, authenticateWriterCommand, bindStageDocumentWriter, finishedWriterBatch, prepareWriterBrief, receiveWriterComposition, rollbackStageDocumentWrite, stageDocumentBatch } from '../.harness/src/workflow/stage-documents.mjs';

const json = (value) => JSON.stringify(value) + '\n';
const write = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
};
const sourceHook = new URL('../.harness/scripts/harness-write-guard.mjs', import.meta.url);

async function fixture(t) {
  const parent = join(process.cwd(), '.io/runtime/stage-document-writer-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('a document stage publishes its own drafts after the gates without a writer, and a rejected draft leaves the canonical document untouched', async (t) => {
  const flow = await consumerWorkflow(t, '지도를 확인합니다');
  const { started, base, prepared } = await flow.beginStage('stakeholder-analysis');
  const id = prepared.input.execution_id;
  const stage = flow.specDirectory + '/stakeholder-analysis.md';
  const draft = join(started.document_draft_root, stage);
  const run = (action, args = []) => spawnSync(process.execPath, [join(flow.workspace, '.harness/scripts/harness-native-stage.mjs'), action, ...base, ...args], { cwd: flow.workspace, encoding: 'utf8' });
  await write(draft, '요청자가 지도 확인을 요청함.\n');
  await flow.submitStage({ stage: 'stakeholder-analysis', started }, {
    artifacts: [{ path: stage, kind: 'stakeholder_analysis' }],
    resultExtra: { artifact_contents: [{ name: 'analysis-note.md', kind: 'analysis_note', content: '# 분석\n\n지도 확인이 목적입니다.\n' }] },
  });
  const head = flow.treeGit('rev-parse', 'HEAD');
  const rejected = run('finish');
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).status, 'gate_error', 'the gate reads the author draft');
  await assert.rejects(readFile(join(flow.workspace, stage), 'utf8'), { code: 'ENOENT' });
  assert.equal(flow.treeGit('rev-parse', 'HEAD'), head);

  await rm(draft);
  await write(draft, stakeholderAnalysisDocument(flow.request));
  const finished = run('finish');
  assert.equal(finished.status, 0, finished.stderr || finished.stdout);
  const result = JSON.parse(finished.stdout);
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(join(flow.workspace, stage), 'utf8'), stakeholderAnalysisDocument(flow.request));
  assert.equal(await readFile(join(flow.workspace, '.io/runtime/executions', id, 'artifacts/analysis-note.md'), 'utf8'), '# 분석\n\n지도 확인이 목적입니다.\n');
  assert.equal(flow.treeGit('rev-list', '--count', `${head.trim()}..HEAD`).trim(), '1');
  assert.equal(flow.treeGit('status', '--short'), '');
  const receipt = JSON.parse(await readFile(join(flow.workspace, '.io/runtime/executions', id, 'document-drafts/written.json'), 'utf8'));
  assert.equal(receipt.agent_id, `${id}-agent`, 'the receipt names the worker that authored the documents');
  assert.equal(run('bind-writer', ['--agent-id', '/root/anyone']).status, 2, 'there is no writer batch to bind');
});

test('Claude writer requires its own tool admission and native start and stop records', async (t) => {
  const root = await fixture(t);
  const id = 'report-execution';
  const writer = 'claude-writer';
  const sessionId = 'claude-parent';
  await write(join(root, '.harness/harness.yaml'), 'agents:\n  claude-code:\n    low_performance_model: haiku\n    low_performance_reasoning_effort: low\n');
  await mkdir(join(root, '.io'));
  const batch = await stageDocumentBatch({ root, input: { skill: 'frontend-design', execution_id: id }, planSetId: 'plan',
    envelope: { result: { artifact_contents: [{ name: 'report.md', kind: 'report', content: '문장 하나의 근거' }] } }, binding: { provider: 'claude-code', model: 'opus' }, allowInline: true });
  assert.equal(batch.binding.model, 'haiku');
  const bound = await bindStageDocumentWriter({ root, id, agentId: writer, workerId: 'designer', parentSessionId: sessionId });
  const [file] = JSON.parse(await readFile(await prepareWriterBrief(root, batch), 'utf8')).files;
  await write(file.output, '작성자가 완성한 문장\n');
  const command = `node .harness/scripts/harness-native-stage.mjs write-documents --execution-id ${id} --agent-id '${writer}'`;
  const hook = (agentId) => {
    const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root, agent_id: agentId, agent_type: 'stage_document_writer', session_id: sessionId };
    const result = spawnSync(process.execPath, [sourceHook.pathname], { cwd: root, input: json(event), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput;
  };
  assert.equal(hook('designer').permissionDecision, 'deny');
  await assert.rejects(authenticateWriterCommand({ root, id, agentId: writer, env: {} }), /requires authorization/);
  const proof = /^HARNESS_STAGE_WRITER_PROOF='([^']+)'/.exec(hook(writer).updatedInput.command)[1];
  await authenticateWriterCommand({ root, id, agentId: writer, env: { HARNESS_STAGE_WRITER_PROOF: proof } });
  await receiveWriterComposition({ root, id, agentId: writer });
  const composed = await finishedWriterBatch(root, batch);
  await assert.rejects(assertStageDocumentWriterCompleted(root, composed), /no native completion evidence/);
  const log = join(root, '.io/runtime/executions', id, 'subagents.jsonl');
  for (const event of ['SubagentStart', 'SubagentStop']) {
    await appendFile(log, json({ event, agent_type: 'stage_document_writer', agent_id: writer, session_id: bound.parent_session_id, recorded_at: new Date().toISOString() }));
  }
  await assertStageDocumentWriterCompleted(root, composed);
});

test('an interrupted publication restores stage-owned edits without overwriting a later edit', async (t) => {
  const root = await fixture(t);
  const id = 'interrupted';
  const batchDir = join(root, '.io/runtime/executions', id, 'document-drafts');
  const path = 'docs/implementation/plan/api.md';
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const before = '기존 계약\n';
  const after = '작성된 계약\n';
  await write(join(root, path), after);
  await write(join(batchDir, 'lock'), json({ pid: 2147483647 }));
  await write(join(batchDir, 'rollback.json'), json({ entries: [{ base: 'workspace', path, before: Buffer.from(before).toString('base64'), before_sha256: hash(before), after_sha256: hash(after), mode: 0o644 }] }));
  await write(join(root, path), '사용자 수정\n');
  await assert.rejects(rollbackStageDocumentWrite(root, id), /another edit/);
  assert.equal(await readFile(join(root, path), 'utf8'), '사용자 수정\n');
  await write(join(root, path), after);
  await rollbackStageDocumentWrite(root, id);
  assert.equal(await readFile(join(root, path), 'utf8'), before);
  await assert.rejects(readFile(join(batchDir, 'lock')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(batchDir, 'rollback.json')), { code: 'ENOENT' });
});

test('only the stages whose documents are reviewed before they finish keep an independent writer', () => {
  for (const skill of ['to-ticket', 'sync-contracts']) assert.equal(authorsOwnDocuments(skill), false, skill);
  for (const skill of ['stakeholder-analysis', 'event-storming', 'domain-model', 'tactical-api', 'tactical-data']) assert.equal(authorsOwnDocuments(skill), true, skill);
});
