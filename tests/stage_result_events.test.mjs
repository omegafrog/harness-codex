import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { publishStageResultEvent, waitForStageResult } from '../.harness/src/workflow/stage-result-events.mjs';

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
  assert.equal(JSON.parse(await readFile(join(fx.session, 'runtime/orchestrator/stage-results/startup.json'), 'utf8')).delivery.status, 'unsupported');
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

test('delivery resumes the recorded orchestrator session through its provider CLI once, without a host app', async (t) => {
  const fx = await fixture(t, 'host', { orchestrator_session_id: 'conversation-1' });
  const bin = join(fx.primary, 'bin'); await mkdir(bin);
  const log = join(fx.primary, 'resume-args.jsonl');
  // Fake provider CLI: records how the runner resumed the orchestrator.
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), session: process.env.HARNESS_SESSION_DIR, thread: process.env.CODEX_THREAD_ID || null, execution: process.env.HARNESS_SKILL_EXECUTION_ID || null }) + '\\n');\n`);
  execFileSync('chmod', ['+x', join(bin, 'codex')]);
  const priorPath = process.env.PATH, priorThread = process.env.CODEX_THREAD_ID, priorExecution = process.env.HARNESS_SKILL_EXECUTION_ID;
  t.after(() => { process.env.PATH = priorPath; if (priorThread === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = priorThread; if (priorExecution === undefined) delete process.env.HARNESS_SKILL_EXECUTION_ID; else process.env.HARNESS_SKILL_EXECUTION_ID = priorExecution; });
  const saved = envelope('host'); await saveResult(fx, 'host', saved);
  // Without a runnable provider CLI the event stays undelivered and is retried later.
  const noCodex = join(fx.primary, 'no-codex-bin'); await mkdir(noCodex);
  await symlink(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(noCodex, 'git'));
  process.env.PATH = noCodex;
  const missing = await publishStageResultEvent({ root: fx.root, input: fx.input, envelope: saved });
  assert.equal(missing.delivery.status, 'unsupported');
  assert.equal(missing.delivery.reason, 'orchestrator_cli_unavailable');
  process.env.PATH = `${bin}:${priorPath}`;
  process.env.CODEX_THREAD_ID = 'stage-thread';
  process.env.HARNESS_SKILL_EXECUTION_ID = 'stage-execution';
  const sent = await publishStageResultEvent({ root: fx.root, input: fx.input, envelope: saved });
  assert.equal(sent.delivery.status, 'sent');
  await Promise.all([publishStageResultEvent({ root: fx.root, input: fx.input, envelope: saved }), publishStageResultEvent({ root: fx.root, input: fx.input, envelope: saved })]);
  for (let i = 0; i < 50 && !(await readFile(log, 'utf8').catch(() => '')); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ['exec', 'resume', 'conversation-1']);
  assert.match(calls[0].args[3], /Harness stage result for execution host: completed\/OK/);
  assert.equal(calls[0].cwd, fx.root);
  assert.equal(calls[0].session, fx.session);
  assert.equal(calls[0].thread, null, 'the stage thread must not leak into the orchestrator resume');
  assert.equal(calls[0].execution, null);
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
