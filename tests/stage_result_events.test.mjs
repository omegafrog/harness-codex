import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { publishStageResultEvent, waitForStageResult } from '../.harness/src/workflow/stage-result-events.mjs';
import { validateSkillReturn } from '../.harness/src/workflow/skill-execution.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const inputPath = (id) => `.io/plans/correct/${id}/input.json`;
const resultPath = (id) => `runtime/executions/${id}/result.json`;

async function fixture(t, id, { orchestrator_session_id = null, separateControlSession = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'stage-events-'));
  const primary = join(base, 'repo'), root = join(base, 'stage-worktree');
  await mkdir(primary);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: primary });
  execFileSync('git', ['config', 'user.name', 'Stage test'], { cwd: primary });
  execFileSync('git', ['config', 'user.email', 'stage-test@example.test'], { cwd: primary });
  await writeFile(join(primary, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '.'], { cwd: primary });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: primary });
  execFileSync('git', ['worktree', 'add', '-qb', `stage-${id}`, root, 'HEAD'], { cwd: primary });
  await protectLocalInstallArtifacts(root, source);
  await updateProject({ sourceRoot: source, targetRoot: root, initialize: true });
  await updateProject({ sourceRoot: source, targetRoot: root });
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  const gitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: root, encoding: 'utf8' }).trim();
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
  const taskSession = join(root, '.io'), session = separateControlSession ? join(primary, '.io') : taskSession, worktree_ref = join(taskSession, 'worktree.json');
  await mkdir(taskSession, { recursive: true }); await mkdir(session, { recursive: true });
  await writeFile(worktree_ref, JSON.stringify({ schema_version: 1, worktree_id: '123e4567-e89b-42d3-a456-426614174000', state: 'active', workspace: root, common, return_root: primary, session_directory: taskSession, branch, git_dir: gitDir, plan_set_id: 'plans' }));
  const input = { schema_version: 1, execution_id: id, skill: 'correct', workspace_root: root, session_directory: taskSession, scope: 'verify stage result delivery', input_refs: [], context: { stage_id: 'correct', worktree_ref, ...(separateControlSession ? { control_session_directory: session } : {}), ...(orchestrator_session_id ? { orchestrator_session_id, orchestrator_provider: 'codex' } : {}) } };
  await mkdir(join(root, inputPath(id), '..'), { recursive: true });
  await writeFile(join(root, inputPath(id)), JSON.stringify(input));
  await mkdir(join(session, 'runtime/orchestrator'), { recursive: true });
  await writeFile(join(session, 'runtime/orchestrator/state.json'), JSON.stringify({ schema_version: 1, workflow_ref: null, status: 'running', current_stage: 'correct', stages: { correct: { status: 'running', execution_id: id, model: 'test', reasoning_effort: 'low' } } }));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { root, primary, session, taskSession, worktree_ref, input };
}

function envelope(id, status = 'completed', code = 'OK', questionCount = 1) {
  const result = { schema_version: 1, execution_id: id, skill: 'correct', status, code, summary: `${status} result`, artifacts: [], questions: [], review_request: null };
  if (status === 'action_required') {
    result.questions = Array.from({ length: questionCount }, (_, index) => ({ question_id: `${id}:${index + 1}`, title: `Choose path ${index + 1}`, options: [{ id: 'a', label: 'A', consequence: `A path ${index + 1}` }, { id: 'b', label: 'B', consequence: `B path ${index + 1}` }], recommended_option_id: 'a', rationale: 'Recommended' }));
  }
  return { schema_version: 1, execution_id: id, skill: 'correct', status, code, result_ref: `runtime/executions/${id}/result.json`, result };
}

async function saveResult(fx, id, value) {
  const path = join(fx.taskSession, resultPath(id));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value.result));
}

test('background E2E publishes only a verified receipt and cleanup for the approved commit', async (t) => {
  const id = 'e2e-event', fx = await fixture(t, id, { orchestrator_session_id: 'conversation-e2e' });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.root, encoding: 'utf8' }).trim();
  const writeArtifact = async (path, value) => {
    const text = JSON.stringify(value);
    await mkdir(join(fx.taskSession, path, '..'), { recursive: true });
    await writeFile(join(fx.taskSession, path), text);
    return createHash('sha256').update(text).digest('hex');
  };
  const requestPath = 'runtime/e2e/requests/test.json';
  const requestHash = await writeArtifact(requestPath, { target_commit: commit, profile_id: 'test-e2e', scenarios: ['E2E-01'], timeout_ms: 1000, approval_answer: '승인', manifest_sha256: 'a'.repeat(64) });
  fx.input.skill = 'e2e-test'; fx.input.context.stage_id = 'e2e-test';
  fx.input.input_refs = [{ base: 'session', path: requestPath, kind: 'approved_e2e_request', sha256: requestHash }];
  await rm(join(fx.root, inputPath(id)));
  const e2eInputPath = `.io/plans/e2e-test/${id}/input.json`;
  await mkdir(join(fx.root, e2eInputPath, '..'), { recursive: true });
  await writeFile(join(fx.root, e2eInputPath), JSON.stringify(fx.input));
  const statePath = join(fx.session, 'runtime/orchestrator/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.current_stage = 'e2e-test'; state.stages['e2e-test'] = state.stages.correct; delete state.stages.correct;
  await writeFile(statePath, JSON.stringify(state));
  const receiptPath = 'runtime/execution/test-e2e-1/receipt.json', cleanupPath = 'runtime/e2e/test/cleanup.json';
  let receiptHash = await writeArtifact(receiptPath, { status: 'failed', head: commit, profile_id: 'test-e2e' });
  const cleanupHash = await writeArtifact(cleanupPath, { status: 'passed' });
  const result = { schema_version: 1, execution_id: id, skill: 'e2e-test', status: 'completed', code: 'OK', summary: 'done', artifacts: [{ base: 'session', path: receiptPath, kind: 'e2e_receipt', sha256: receiptHash }, { base: 'session', path: cleanupPath, kind: 'e2e_cleanup', sha256: cleanupHash }], questions: [], review_request: null };
  const out = { schema_version: 1, execution_id: id, skill: 'e2e-test', status: 'completed', code: 'OK', result_ref: resultPath(id), result };
  await saveResult(fx, id, out);
  await assert.rejects(validateSkillReturn({ root: fx.root, input: fx.input, envelope: out }), /does not prove/);
  receiptHash = await writeArtifact(receiptPath, { status: 'passed', exit_code: 0, head: commit, profile_id: 'test-e2e', config_hashes: { 'docs/agents/execution.json': 'a'.repeat(64) } });
  result.artifacts[0].sha256 = receiptHash;
  await saveResult(fx, id, out);
  const bin = join(fx.primary, 'e2e-bin'); await mkdir(bin);
  const wakeLog = join(fx.primary, 'e2e-wake.jsonl'), wake = join(bin, 'wake.cjs');
  await writeFile(wake, `const rl=require('node:readline').createInterface({input:process.stdin}),fs=require('node:fs');rl.on('line',line=>{const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}));if(m.id===2){fs.appendFileSync(${JSON.stringify(wakeLog)},JSON.stringify(m.params)+'\\n');console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{structuredContent:{state:'queued'}}}));}});`);
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({enabled:true,transport:{type:'stdio',command:process.execPath,args:[${JSON.stringify(wake)}],cwd:${JSON.stringify(bin)}}}));\n`);
  execFileSync('chmod', ['+x', join(bin, 'codex')]);
  const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  const event = await publishStageResultEvent({ root: fx.root, input: fx.input, envelope: out });
  assert.equal(event.status, 'completed');
  assert.equal(event.result_ref, resultPath(id));
  assert.equal(event.delivery.reason, 'wake_queued');
  await publishStageResultEvent({ root: fx.root, input: fx.input, envelope: out });
  const calls = (await readFile(wakeLog, 'utf8')).trim().split('\n');
  assert.equal(calls.length, 1);
  const wakeCall = JSON.parse(calls[0]);
  assert.equal(wakeCall.arguments.thread, 'conversation-e2e');
  assert.match(wakeCall.arguments.message_template, /e2e-event: completed\/OK/);
  assert.equal((await waitForStageResult({ root: fx.root, worktree_ref: fx.worktree_ref, execution_id: id })).status, 'completed');
});

test('publishes completed and complete action_required batches, and suppresses duplicates', async (t) => {
  for (const [id, status, code, questionCount] of [['done', 'completed', 'OK', 0], ['question', 'action_required', 'USER_DECISION_REQUIRED', 1], ['manyquestions', 'action_required', 'USER_DECISION_REQUIRED', 6]]) {
    const fx = await fixture(t, id);
    if (id === 'done') {
      const lock = join(fx.session, 'runtime/orchestrator/stage-results/.done.lock');
      await mkdir(lock, { recursive: true });
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, boot: 'stale-boot', start: 'stale-start', at: Date.now() }));
    }
    const result = envelope(id, status, code, questionCount);
    await saveResult(fx, id, result);
    const first = await publishStageResultEvent({ root: fx.root, input: fx.input, envelope: result, hostDelivery: false });
    const second = await publishStageResultEvent({ root: fx.root, input: fx.input, envelope: result, hostDelivery: false });
    assert.equal(first.status, status);
    assert.equal(first.questions.length, questionCount);
    assert.equal(first.questions_complete, true);
    if (questionCount) assert.equal(first.questions[0].options[0].consequence, 'A path 1');
    assert.equal(second.execution_id, id);
    const state = JSON.parse(await readFile(join(fx.session, 'runtime/orchestrator/state.json'), 'utf8'));
    assert.equal(state.stages.correct.status, status === 'action_required' ? 'waiting' : 'completed');
  }
});

test('installed runner records each implementation result at its canonical checkpoint path', async (t) => {
  const id = 'implementation-checkpoint', fx = await fixture(t, id);
  await rm(join(fx.root, inputPath(id)));
  fx.input.skill = 'implement-wrapper';
  Object.assign(fx.input.context, { stage_id: 'implement-wrapper', plan_id: 'community', checkpoint_path: join(fx.taskSession, 'runtime/plans/community/checkpoint.md') });
  const installedInput = `.io/plans/implement-wrapper/${id}/input.json`;
  await mkdir(join(fx.root, installedInput, '..'), { recursive: true });
  await writeFile(join(fx.root, installedInput), JSON.stringify(fx.input));
  const statePath = join(fx.session, 'runtime/orchestrator/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.current_stage = 'implement-wrapper'; state.stages['implement-wrapper'] = state.stages.correct; delete state.stages.correct;
  await writeFile(statePath, JSON.stringify(state));
  const result = envelope(id); result.skill = 'implement-wrapper'; result.result.skill = 'implement-wrapper';
  await saveResult(fx, id, result);
  const installed = await import(pathToFileURL(join(fx.root, '.harness/src/workflow/stage-result-events.mjs')));
  const installedPublish = installed.publishStageResultEvent;
  await installedPublish({ root: fx.root, input: fx.input, envelope: result, hostDelivery: false });
  const checkpoint = await readFile(fx.input.context.checkpoint_path, 'utf8');
  assert.match(checkpoint, /plan_id: "community"/);
  assert.match(checkpoint, /implementation-checkpoint/);
  assert.match(checkpoint, /tests: \{"status":"unknown"/);
  const journalPath = join(fx.taskSession, 'runtime/plans/community/events.jsonl');
  const journal = await readFile(journalPath, 'utf8');
  await installedPublish({ root: fx.root, input: fx.input, envelope: result, hostDelivery: false });
  assert.equal(await readFile(journalPath, 'utf8'), journal);
  const newer = JSON.parse(await readFile(statePath, 'utf8'));
  newer.stages['implement-wrapper'].execution_id = 'newer';
  await writeFile(statePath, JSON.stringify(newer));
  await assert.rejects(installedPublish({ root: fx.root, input: fx.input, envelope: result, hostDelivery: false }), /Stage execution changed/);
  assert.equal(await readFile(journalPath, 'utf8'), journal);
  newer.stages['implement-wrapper'].execution_id = id;
  await writeFile(statePath, JSON.stringify(newer));
  await rm(journalPath);
  await rm(join(fx.session, `runtime/orchestrator/stage-results/${id}.json`));
  const failed = await installed.waitForStageResult({ root: fx.root, worktree_ref: fx.worktree_ref, execution_id: id });
  assert.equal(failed.status, 'failed');
  assert.match(failed.summary, /Cannot persist the implementation checkpoint/);
  assert.equal(await readFile(fx.input.context.checkpoint_path, 'utf8'), checkpoint);
  const outside = join(fx.primary, 'wrong-checkpoint.md');
  fx.input.context.checkpoint_path = outside;
  await writeFile(join(fx.root, installedInput), JSON.stringify(fx.input));
  await rm(join(fx.session, `runtime/orchestrator/stage-results/${id}.json`));
  const rejected = await installed.waitForStageResult({ root: fx.root, worktree_ref: fx.worktree_ref, execution_id: id });
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.summary, /does not match the runner-owned plan path/);
  await assert.rejects(readFile(outside), { code: 'ENOENT' });
  await writeFile(join(fx.root, 'user-note.txt'), 'preserve\n');
  const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: fx.root, encoding: 'utf8' });
  assert.match(status, /\?\? user-note\.txt/);
  assert.doesNotMatch(status, /\.io\/runtime\/plans/);
});

test('review handoff creates the same runner-owned checkpoint', async (t) => {
  const id = 'implementation-review', fx = await fixture(t, id);
  await rm(join(fx.root, inputPath(id)));
  fx.input.skill = 'implement-wrapper';
  Object.assign(fx.input.context, { stage_id: 'implement-wrapper', plan_id: 'community', checkpoint_path: join(fx.taskSession, 'runtime/plans/community/checkpoint.md') });
  const installedInput = `.io/plans/implement-wrapper/${id}/input.json`;
  await mkdir(join(fx.root, installedInput, '..'), { recursive: true });
  await writeFile(join(fx.root, installedInput), JSON.stringify(fx.input));
  const statePath = join(fx.session, 'runtime/orchestrator/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.current_stage = 'implement-wrapper'; state.stages['implement-wrapper'] = state.stages.correct; delete state.stages.correct;
  await writeFile(statePath, JSON.stringify(state));
  const result = envelope(id, 'action_required', 'REVIEW_REQUIRED', 0); result.skill = 'implement-wrapper'; result.result.skill = 'implement-wrapper';
  await saveResult(fx, id, result);
  const { PlanCheckpointStore } = await import(pathToFileURL(join(fx.root, '.harness/src/wrapper/checkpoint.mjs')));
  const checkpointStore = new PlanCheckpointStore({ root: fx.root, planId: 'community' });
  await checkpointStore.write({ review_fixed_point: 'a'.repeat(40), tests: { status: 'passed', e2e_failures: [{ id: 'old-failure', evidence_path: 'runtime/e2e/old/failure.json' }] }, lifecycle_evidence: { fixed_point: 'a'.repeat(40), stage_results: [{ execution_id: 'prior', status: 'blocked', code: 'INPUT_MISSING', result_ref: 'runtime/executions/prior/result.json' }] } });
  await checkpointStore.close();
  const installedPublish = (await import(pathToFileURL(join(fx.root, '.harness/src/workflow/stage-result-events.mjs')))).publishStageResultEvent;
  const event = await installedPublish({ root: fx.root, input: fx.input, envelope: result, hostDelivery: false });
  assert.equal(event.code, 'REVIEW_REQUIRED');
  const checkpoint = await readFile(fx.input.context.checkpoint_path, 'utf8');
  assert.match(checkpoint, /orchestration_state: "handoff-required"/);
  assert.match(checkpoint, /stage-action_required-REVIEW_REQUIRED/);
  const restored = await new PlanCheckpointStore({ root: fx.root, planId: 'community' }).read();
  assert.equal(restored.review_fixed_point, 'a'.repeat(40));
  assert.equal(restored.lifecycle_evidence.fixed_point, 'a'.repeat(40));
  assert.deepEqual(restored.lifecycle_evidence.stage_results.map((item) => item.execution_id), ['prior', id]);
  assert.deepEqual(restored.tests.e2e_failures, [{ id: 'old-failure', evidence_path: 'runtime/e2e/old/failure.json' }]);
});

test('records malformed returns and cancellation as explicit terminal events; rejects stale execution IDs', async (t) => {
  const malformed = await fixture(t, 'malformed');
  const bad = envelope('malformed'); bad.result.execution_id = 'other';
  const event = await publishStageResultEvent({ root: malformed.root, input: malformed.input, envelope: bad, hostDelivery: false });
  assert.equal(event.status, 'failed');
  assert.equal(event.code, 'EXECUTION_ERROR');
  const cancelled = await fixture(t, 'cancelled');
  const cancelEvent = await publishStageResultEvent({ root: cancelled.root, input: cancelled.input, error: Object.assign(new Error('cancelled'), { name: 'AbortError' }), hostDelivery: false });
  assert.equal(cancelEvent.status, 'cancelled');
  const stale = await fixture(t, 'old');
  const statePath = join(stale.session, 'runtime/orchestrator/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')); state.stages.correct.execution_id = 'newer';
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(publishStageResultEvent({ root: stale.root, input: stale.input, envelope: envelope('old'), hostDelivery: false }), /Stage execution changed/);
});

test('uses state.json and reconciles a result already saved before listener startup', async (t) => {
  const fx = await fixture(t, 'startup', { separateControlSession: true });
  const saved = envelope('startup');
  await saveResult(fx, 'startup', saved);
  const received = await waitForStageResult({ root: fx.root, worktree_ref: fx.worktree_ref, execution_id: 'startup' });
  assert.equal(received.status, 'completed');
  const event = JSON.parse(await readFile(join(fx.session, 'runtime/orchestrator/stage-results/startup.json'), 'utf8'));
  assert.equal(event.delivery.status, 'pending');
  assert.ok(event.delivery.observed_at);
  await assert.rejects(readFile(join(fx.taskSession, 'runtime/orchestrator/stage-results/startup.json')), { code: 'ENOENT' });
});

test('uses workflow.json when the persisted input has workflow_ref, even if state.json is stale', async (t) => {
  const fx = await fixture(t, 'workflow-state', { separateControlSession: true });
  fx.input.context.workflow_ref = 'test-workflow';
  await writeFile(join(fx.root, inputPath('workflow-state')), JSON.stringify(fx.input));
  const state = { schema_version: 1, workflow_ref: 'test-workflow', status: 'running', current_stage: 'correct', stages: { correct: { status: 'running', execution_id: 'workflow-state' } } };
  await writeFile(join(fx.session, 'runtime/orchestrator/workflow.json'), JSON.stringify({ schema_version: 1, stages: [{ id: 'correct' }], state }));
  await writeFile(join(fx.session, 'runtime/orchestrator/state.json'), JSON.stringify({ schema_version: 1, current_stage: 'wrong', stages: { wrong: { status: 'completed', execution_id: 'stale' } } }));
  await saveResult(fx, 'workflow-state', envelope('workflow-state'));
  const received = await waitForStageResult({ root: fx.root, worktree_ref: fx.worktree_ref, execution_id: 'workflow-state' });
  assert.equal(received.status, 'completed');
  const workflow = JSON.parse(await readFile(join(fx.session, 'runtime/orchestrator/workflow.json'), 'utf8'));
  assert.equal(workflow.state.stages.correct.status, 'completed');
  assert.equal(JSON.parse(await readFile(join(fx.session, 'runtime/orchestrator/state.json'), 'utf8')).current_stage, 'wrong');
});

test('rejects a result-less event that claims completed or action_required', async (t) => {
  const fx = await fixture(t, 'forged');
  const path = join(fx.session, 'runtime/orchestrator/stage-results/forged.json');
  await mkdir(join(path, '..'), { recursive: true });
  const request_id = createHash('sha256').update(`${fx.worktree_ref}:forged`).digest('hex');
  await writeFile(path, JSON.stringify({ schema_version: 1, worktree_ref: fx.worktree_ref, execution_id: 'forged', status: 'completed', code: 'OK', summary: 'forged', questions: [], result_ref: null, delivery: { status: 'pending', request_id } }));
  await assert.rejects(waitForStageResult({ root: fx.root, worktree_ref: fx.worktree_ref, execution_id: 'forged' }), /Result-less event/);
});

test('reconciles a runner crash from stopped process identities when no result was saved', async (t) => {
  const fx = await fixture(t, 'crashed');
  const statePath = join(fx.session, 'runtime/orchestrator/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const dead = { pid: 99999999, boot: 'old-boot', start: 'old-start' };
  state.stages.correct.owner = dead; state.stages.correct.child = { ...dead, pid: 99999998 };
  await writeFile(statePath, JSON.stringify(state));
  const event = await waitForStageResult({ root: fx.root, worktree_ref: fx.worktree_ref, execution_id: 'crashed' });
  assert.equal(event.status, 'failed');
  assert.equal(event.code, 'EXECUTION_ERROR');
  assert.match(event.summary, /stopped before saving/);
});

test('installed consumer queues the recorded result through Wake without duplicates', async (t) => {
  const fx = await fixture(t, 'host', { orchestrator_session_id: 'conversation-1' });
  const installedPublish = (await import(pathToFileURL(join(fx.root, '.harness/src/workflow/stage-result-events.mjs')))).publishStageResultEvent;
  const bin = join(fx.primary, 'bin'); await mkdir(bin);
  const log = join(fx.primary, 'resume-args.jsonl');
  const wakeTmp = join(fx.primary, 'wake-tmp.json');
  const server = join(bin, 'wake.cjs');
  await writeFile(server, `const readline = require('node:readline'); const fs = require('node:fs'); readline.createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); if(m.id===1) { fs.writeFileSync(${JSON.stringify(wakeTmp)},JSON.stringify({tmpdir:process.env.TMPDIR,exists:fs.existsSync(process.env.TMPDIR)})); console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{}})); } if(m.id===2) { fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m.params)+'\\n'); console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{structuredContent:{state:'queued'}}})); } });`);
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({enabled:true,transport:{type:'stdio',command:process.execPath,args:[${JSON.stringify(server)}],cwd:${JSON.stringify(bin)}}}));\n`);
  execFileSync('chmod', ['+x', join(bin, 'codex')]);
  const priorPath = process.env.PATH, priorThread = process.env.CODEX_THREAD_ID, priorExecution = process.env.HARNESS_SKILL_EXECUTION_ID, priorCodexHome = process.env.CODEX_HOME;
  t.after(() => { process.env.PATH = priorPath; if (priorThread === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = priorThread; if (priorExecution === undefined) delete process.env.HARNESS_SKILL_EXECUTION_ID; else process.env.HARNESS_SKILL_EXECUTION_ID = priorExecution; if (priorCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodexHome; });
  const saved = envelope('host'); await saveResult(fx, 'host', saved);
  // Without a runnable provider CLI the event stays undelivered and is retried later.
  const noCodex = join(fx.primary, 'no-codex-bin'); await mkdir(noCodex);
  await symlink(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(noCodex, 'git'));
  process.env.PATH = noCodex;
  const missing = await installedPublish({ root: fx.root, input: fx.input, envelope: saved });
  assert.equal(missing.delivery.status, 'unsupported');
  assert.equal(missing.delivery.reason, 'wake_unavailable');
  const plugin = join(fx.primary, 'codex-home/plugins/cache/local/codex-wake/1.0');
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, 'mcp.json'), JSON.stringify({ mcpServers: { 'codex-wake': { type: 'stdio', command: process.execPath, args: [server], cwd: '.' } } }));
  await writeFile(join(bin, 'codex'), '#!/usr/bin/env node\nif (process.argv[2] === "plugin") console.log(JSON.stringify({installed:[{name:"codex-wake",marketplaceName:"local",version:"1.0",installed:true,enabled:true}]})); else process.exit(1);\n');
  process.env.CODEX_HOME = join(fx.primary, 'codex-home');
  process.env.PATH = `${bin}:${priorPath}`;
  process.env.CODEX_THREAD_ID = 'stage-thread';
  process.env.HARNESS_SKILL_EXECUTION_ID = 'stage-execution';
  const sent = await installedPublish({ root: fx.root, input: fx.input, envelope: saved });
  assert.equal(sent.delivery.status, 'sent');
  assert.deepEqual(JSON.parse(await readFile(wakeTmp, 'utf8')), { tmpdir: join(fx.session, 'tmp'), exists: true });
  assert.equal(await (await import('node:fs/promises')).stat(join(fx.session, 'tmp')).then((info) => info.isDirectory()), true);
  await Promise.all([installedPublish({ root: fx.root, input: fx.input, envelope: saved }), installedPublish({ root: fx.root, input: fx.input, envelope: saved })]);
  for (let i = 0; i < 50 && !(await readFile(log, 'utf8').catch(() => '')); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'queue_thread');
  assert.equal(calls[0].arguments.thread, 'conversation-1');
  assert.equal(calls[0].arguments.resume, true);
  assert.match(calls[0].arguments.message_template, /runtime\/executions\/host\/result.json/);
  assert.match(calls[0].arguments.message_template, /Preserve any user stop or pause request/);
  const direct = await fixture(t, 'direct', { orchestrator_session_id: 'conversation-1' });
  const directResult = envelope('direct');
  await saveResult(direct, 'direct', directResult);
  const installedDirect = await import(pathToFileURL(join(direct.root, '.harness/src/workflow/stage-result-events.mjs')));
  assert.equal((await installedDirect.waitForStageResult({ root: direct.root, worktree_ref: direct.worktree_ref, execution_id: 'direct' })).status, 'completed');
  const observed = await installedDirect.publishStageResultEvent({ root: direct.root, input: direct.input, envelope: directResult });
  assert.ok(observed.delivery.observed_at);
  assert.equal(observed.delivery.status, 'pending');
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1, 'direct observation must not enqueue another Wake turn, including a late runner publication');
  const eventPath = join(fx.session, 'runtime/orchestrator/stage-results/host.json');
  const uncertain = JSON.parse(await readFile(eventPath, 'utf8'));
  uncertain.delivery.status = 'sending';
  await writeFile(eventPath, JSON.stringify(uncertain));
  assert.equal((await installedPublish({ root: fx.root, input: fx.input, envelope: saved })).delivery.status, 'sending');
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
  const interrupted = await fixture(t, 'interrupted', { orchestrator_session_id: 'conversation-1' });
  const interruptedResult = envelope('interrupted');
  await saveResult(interrupted, 'interrupted', interruptedResult);
  await writeFile(server, `const readline = require('node:readline'); readline.createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); if(m.id===1) console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{}})); if(m.id===2) process.exit(0); });`);
  const unknown = await installedPublish({ root: interrupted.root, input: interrupted.input, envelope: interruptedResult });
  assert.equal(unknown.delivery.status, 'uncertain');
  assert.equal((await installedPublish({ root: interrupted.root, input: interrupted.input, envelope: interruptedResult })).delivery.status, 'uncertain');
  await writeFile(join(fx.root, 'user-change.txt'), 'preserve');
  const status = execFileSync('git', ['status', '--short'], { cwd: fx.root, encoding: 'utf8' });
  assert.match(status, /user-change\.txt/);
  assert.doesNotMatch(status, /\.harness\/src\/workflow\/stage-result-events/);
  const { orchestratorResumeCommand } = await import('../.harness/src/workflow/stage-result-events.mjs');
  // The resumed orchestrator turn keeps the workflow model binding, not the user's CLI default.
  assert.deepEqual(orchestratorResumeCommand({ provider: 'codex', sessionId: 's', root: '/w', message: 'm', binding: { provider: 'codex', model: 'gpt-6-luna', reasoning_effort: 'medium' } }).args, ['exec', 'resume', '--model', 'gpt-6-luna', '-c', 'model_reasoning_effort="medium"', 's', 'm']);
  assert.deepEqual(orchestratorResumeCommand({ provider: 'codex', sessionId: 's', root: '/w', message: 'm', sandbox: 'danger-full-access' }).args, ['exec', 'resume', '-c', 'sandbox_mode="danger-full-access"', 's', 'm']);
  assert.deepEqual(orchestratorResumeCommand({ provider: 'codex', sessionId: 's', root: '/w', message: 'm', lastMessagePath: '/w/.io/runtime/orchestrator/last-turn.txt' }).args, ['exec', 'resume', '-o', '/w/.io/runtime/orchestrator/last-turn.txt', 's', 'm']);
  // The sandbox comes from the user's last orchestrator turn; runner-driven delivery turns are ignored.
  const { orchestratorSandbox } = await import('../.harness/src/workflow/providers/codex.mjs');
  const home = join(fx.primary, 'codex-home'), sessionId = '01a1ba5e-b967-7c30-8e90-97af4ffd9b02';
  await mkdir(join(home, 'sessions/2026/11/08'), { recursive: true });
  const turn = (mode, text) => [{ type: 'turn_context', payload: { sandbox_policy: { type: mode } } }, { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '<environment_context>x' }] } }, { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text }] } }];
  await writeFile(join(home, `sessions/2026/11/08/rollout-2026-11-08T17-55-32-${sessionId}.jsonl`), [...turn('danger-full-access', '$orchestrator 계속 진행해'), ...turn('workspace-write', 'Harness stage result for execution spec-me-1: completed/OK.')].map((entry) => JSON.stringify(entry)).join('\n'));
  assert.equal(await orchestratorSandbox(sessionId, { CODEX_HOME: home }), 'danger-full-access');
  assert.match(calls[0].arguments.message_template, /Harness stage result for execution host: completed\/OK/);
  const hostReferences = spawnSync('git', ['grep', '-n', '-i', 'ghostex', '--', '.harness', '.codex', ':!.codex/harness-lock.json'], { cwd: source, encoding: 'utf8' });
  assert.equal(hostReferences.stdout, '', 'Harness must not depend on a host app');
});

test('listener wakes when result.json arrives after it starts watching', async (t) => {
  const fx = await fixture(t, 'late', { separateControlSession: true });
  const child = spawn(process.execPath, [join(fx.root, '.codex/scripts/harness-stage-listen.mjs'), '--root', fx.root, '--worktree-ref', fx.worktree_ref, '--execution-id', 'late'], { cwd: fx.root });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  t.after(() => { clearTimeout(timeout); child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const resultFile = join(fx.session, resultPath('late'));
  await mkdir(join(resultFile, '..'), { recursive: true });
  await writeFile(resultFile, '{"partial":');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await saveResult(fx, 'late', envelope('late'));
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0, stderr);
  assert.equal(JSON.parse(stdout).status, 'completed');
  await readFile(join(fx.session, 'runtime/orchestrator/stage-results/late.json'));
  await assert.rejects(readFile(join(fx.taskSession, 'runtime/orchestrator/stage-results/late.json')), { code: 'ENOENT' });
});

test('the session prompting the orchestrator inside the worktree becomes the result delivery target', async (t) => {
  const fx = await fixture(t, 'rebind', { orchestrator_session_id: 'conversation-1' });
  const { bindOrchestratorSession } = await import('../.harness/src/workflow/startup-state.mjs');
  const worktreeSession = '01a1b9df-ba77-7d72-a16b-4cdf2e52426f';
  await bindOrchestratorSession({ root: fx.root, provider: 'codex', sessionId: worktreeSession });
  const record = JSON.parse(await readFile(fx.worktree_ref, 'utf8'));
  assert.deepEqual({ provider: record.agent_sessions.orchestrator.provider, session_id: record.agent_sessions.orchestrator.session_id }, { provider: 'codex', session_id: worktreeSession });
  // A repeated prompt from the same session leaves the record untouched.
  const before = record.agent_sessions.orchestrator.updated_at;
  await bindOrchestratorSession({ root: fx.root, provider: 'codex', sessionId: worktreeSession });
  assert.equal(JSON.parse(await readFile(fx.worktree_ref, 'utf8')).agent_sessions.orchestrator.updated_at, before);
  // Outside a Harness worktree nothing is recorded.
  assert.equal(await bindOrchestratorSession({ root: fx.primary, provider: 'codex', sessionId: worktreeSession }), null);
});

test('the startup hook tells a resumed orchestrator session when Harness was updated', async (t) => {
  const fx = await fixture(t, 'notice', { orchestrator_session_id: 'conversation-1' });
  const { harnessUpdateNotice } = await import('../.harness/src/workflow/startup-state.mjs');
  const { writeFile: write } = await import('node:fs/promises');
  assert.equal(await harnessUpdateNotice({ root: fx.root, sessionId: 'conversation-1' }), null, 'first prompt only records the installed version');
  assert.equal(await harnessUpdateNotice({ root: fx.root, sessionId: 'conversation-1' }), null, 'unchanged install stays silent');
  await write(join(fx.root, '.codex/harness-lock.json'), `${await readFile(join(fx.root, '.codex/harness-lock.json'), 'utf8')}\n`);
  const notice = await harnessUpdateNotice({ root: fx.root, sessionId: 'conversation-1' });
  assert.match(notice, /Harness was updated since this conversation last ran .* re-read the relevant GUIDE or reference/);
  assert.equal(await harnessUpdateNotice({ root: fx.root, sessionId: 'conversation-1' }), null, 'told once per update');
  assert.equal(await harnessUpdateNotice({ root: fx.root, sessionId: 'another-conversation' }), null, 'a new conversation has nothing outdated');
});
