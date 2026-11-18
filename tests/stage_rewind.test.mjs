import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRE_SPEC_STAGES, REWIND_STAGES, TACTICAL_DESIGN_STAGES, isCurrentStage, nextRequiredPreSpecStage, preSpecOrderViolation, tacticalImplementationOrderViolation } from '../.harness/src/workflow/worktree-stages.mjs';
import { dependencyOwnerErrors } from '../.harness/src/workflow/stage-reopen.mjs';
import { consumerWorkflow, SETUP, sourceRoot } from './support/consumer-workflow.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';

const REQUEST = '커뮤니티 로그아웃과 현재 세션 조회 기능을 구현한다';
const done = { status: 'completed', code: 'OK', result_ref: 'runtime/executions/x/result.json' };
const stale = (owner, blocked, order) => ({ owner_stage: owner, blocked_stage: blocked, reopened_for: 'blocked-1', rerun_order: order, marked_at: '2026-01-01T00:00:00.000Z' });

test('a stale result is not current and the order guards re-run stale stages in order', () => {
  assert.equal(isCurrentStage(done), true);
  assert.equal(isCurrentStage({ ...done, stale: stale('aggregate-design', 'context-boundary', []) }), false);
  assert.equal(isCurrentStage({ status: 'blocked', code: 'DEPENDENCY_INCOMPLETE' }), false);
  assert.deepEqual(REWIND_STAGES.slice(-6), ['context-boundary', 'tactical-technology', 'tactical-ui', 'tactical-api', 'tactical-data', 'to-ticket']);

  // Tactical design: aggregate-design was reopened for context-boundary; domain-service..integration-design completed before.
  const mark = stale('aggregate-design', 'context-boundary', ['aggregate-design', 'domain-service', 'application-service', 'integration-design', 'context-boundary']);
  const stages = Object.fromEntries(PRE_SPEC_STAGES.map((id) => [id, { ...done }]));
  stages['domain-service'] = { ...done, stale: mark }; stages['application-service'] = { ...done, stale: mark }; stages['integration-design'] = { ...done, stale: mark };
  stages['context-boundary'] = { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', result_ref: 'r', stale: mark };
  // A stage that already recorded a result normally resumes freely; a stale one does not.
  assert.equal(nextRequiredPreSpecStage(stages, 'domain-service'), null, 'the first stale stage follows a current one');
  assert.equal(nextRequiredPreSpecStage(stages, 'application-service'), 'domain-service');
  assert.match(preSpecOrderViolation(stages, 'application-service'), /application-service cannot start before domain-service: domain-service is stale, because aggregate-design was reopened for context-boundary\. Re-run the stale stages in order/);
  assert.equal(nextRequiredPreSpecStage(stages, 'context-boundary'), 'domain-service');
  stages['domain-service'] = { ...done };
  assert.equal(nextRequiredPreSpecStage(stages, 'application-service'), null);
  assert.equal(nextRequiredPreSpecStage(stages, 'integration-design'), 'application-service');

  // Tactical implementation: tickets cannot start on a stale upstream.
  const flow = { ...Object.fromEntries(PRE_SPEC_STAGES.map((id) => [id, { ...done }])), 'tactical-technology': { ...done }, 'tactical-ui': { ...done }, 'tactical-api': { ...done }, 'tactical-data': { ...done, stale: stale('tactical-api', 'to-ticket', ['tactical-api', 'tactical-data', 'to-ticket']) } };
  assert.match(tacticalImplementationOrderViolation(flow, 'to-ticket'), /to-ticket cannot start before tactical-data: its result is stale because tactical-api was reopened for to-ticket/);
  assert.match(tacticalImplementationOrderViolation({ ...flow, 'to-ticket': { ...done } }, 'tracker-publish'), /tracker-publish cannot start before tactical-data/);
  flow['tactical-data'] = { ...done };
  assert.equal(tacticalImplementationOrderViolation(flow, 'to-ticket'), null);
});

test('a blocked dependency result must name an earlier owner and the gap', () => {
  const check = (skill, result, status = 'blocked', code = 'DEPENDENCY_INCOMPLETE') => dependencyOwnerErrors({ skill, raw: { status, code, result } });
  assert.deepEqual(check('tactical-data', { owner_stage: 'application-service', dependency_gap: '로그아웃 operation이 없다' }), null);
  assert.equal(check('tactical-data', { owner_stage: null, dependency_gap: null })[0].path, '$.result.owner_stage');
  assert.equal(check('tactical-data', { dependency_gap: 'x' })[0].missing, true);
  assert.equal(check('tactical-data', { owner_stage: 'tactical-data', dependency_gap: 'x' })[0].path, '$.result.owner_stage', 'a stage cannot own its own gap');
  assert.equal(check('tactical-data', { owner_stage: 'to-ticket', dependency_gap: 'x' })[0].path, '$.result.owner_stage', 'a later stage cannot own it');
  assert.equal(check('to-ticket', { owner_stage: 'application-service', dependency_gap: 'x' })[0].path, '$.code', 'to-ticket never rewinds');
  assert.equal(check('application-service', { owner_stage: 'aggregate-design', dependency_gap: '' })[0].path, '$.result.dependency_gap');
  assert.equal(check('tactical-ui', { owner_stage: null, dependency_gap: null }), null, 'tactical-ui hands off to the frontend design brief');
  assert.equal(check('implement-wrapper', { owner_stage: null }), null);
  assert.equal(check('to-ticket', {}, 'completed', 'OK'), null);
  assert.equal(check('to-ticket', {}, 'blocked', 'INPUT_MISSING'), null);
  assert.equal(check('tactical-data', {}, 'blocked', 'INPUT_MISSING'), null);
});

test('installed consumer: a blocked design decision stage reopens its owner forward and re-runs the stale stages in order', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, planSetId, treeGit, runStage, beginStage, submitStage, finishStage, invoke, tree } = flow;
  await writeFile(join(workspace, '.harness/harness.yaml'), SETUP);
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  const prepare = (...args) => spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--verbose', ...args], { cwd: workspace, encoding: 'utf8' });
  const refused = (result, pattern) => { assert.notEqual(result.status, 0, result.stdout); assert.match(result.stderr, pattern, result.stderr); return JSON.parse(result.stderr.trim().split('\n').pop()); };
  // The tactical design flow is already done (the fixture stands in for its six stages); the decisions run for real.
  const seeded = await state();
  for (const stage of TACTICAL_DESIGN_STAGES) seeded.stages[stage] = { status: 'completed', code: 'OK', result_ref: `runtime/executions/${stage}/result.json` };
  await writeFile(statePath, JSON.stringify(seeded, null, 2) + '\n');
  const designPath = `docs/specs/${planSetId}/tactical-design.md`;
  await mkdir(join(workspace, designPath, '..'), { recursive: true });
  await writeFile(join(workspace, designPath), '# 전술 설계\n\n## 4. Application Service\n\n| use case | 설명 |\n|---|---|\n| 로그인 | 세션을 연다 |\n');
  treeGit('add', 'docs'); treeGit('commit', '-qm', 'tactical design fixture');
  const impl = `docs/implementation/${planSetId}`;
  const api = `${impl}/api.md`, data = `${impl}/data.md`;
  await runStage('tactical-technology', { files: { [`${impl}/technology.md`]: 'node --test\n' } });
  await runStage('tactical-ui', { expectCommit: false });
  await runStage('tactical-api', { files: { [api]: '`POST /login`\n`POST /logout`\n`GET /session`\n' }, summary: 'API 계약' });

  // tactical-data finds that logout and the session query have no application-service operation.
  const ticket = await beginStage('tactical-data');
  const blockedId = ticket.prepared.input.execution_id;
  const gap = '로그아웃과 현재 세션 조회 API에 대응하는 operation·호출·transaction 경계가 application-service 설계에 없다';
  await submitStage(ticket, { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: '설계 빈틈', resultExtra: { owner_stage: null, dependency_gap: null } });
  const missingOwner = finishStage(ticket);
  assert.equal(missingOwner.status, 1, missingOwner.stdout);
  assert.deepEqual(JSON.parse(missingOwner.stdout).errors.map((error) => error.path), ['$.result.owner_stage'], 'a block without its owner is returned to the subagent');
  await submitStage(ticket, { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: '설계 빈틈', resultExtra: { owner_stage: 'tactical-api', dependency_gap: gap } });
  const blocked = invoke(workspace, 'harness-native-stage.mjs', ['finish', ...ticket.base]);
  assert.equal(blocked.code, 'DEPENDENCY_INCOMPLETE');
  assert.equal(blocked.result.owner_stage, 'tactical-api');
  assert.match(blocked.next, new RegExp(`launch --stage-id tactical-api --reopen-for ${blockedId}`));
  assert.match(blocked.next, /Do not ask the user/);
  assert.equal((await state()).stages['tactical-data'].stale, undefined, 'nothing is marked until the owner is reopened');

  // Refusals, each with an actionable explanation; none records anything.
  assert.match(refused(prepare('--stage-id', 'tactical-ui', '--reopen-for', blockedId), /names tactical-api as the owner, not tactical-ui/).next[0], new RegExp(`--stage-id tactical-api --reopen-for ${blockedId}`));
  refused(prepare('--stage-id', 'tactical-technology', '--reopen-for', blockedId), /names tactical-api as the owner/);
  refused(prepare('--stage-id', 'tactical-api', '--reopen-for', blockedId, '--feedback', 'x'), /must be requested with --stage-id only/);
  refused(prepare('--stage-id', 'tactical-api', '--reopen-for', 'no-such-execution'), /no stage has execution no-such-execution/);
  refused(prepare('--stage-id', 'tactical-data', '--reopen-for', blockedId), /does not come after tactical-data/);
  refused(prepare('--stage-id', 'tracker-publish', '--reopen-for', blockedId), /cannot be reopened/);
  assert.equal(refused(prepare('--stage-id', 'tactical-api', '--reopen-for', 'bad id'), /invalid blocked execution id/).code, 'REOPEN_REFUSED');
  refused(prepare('--stage-id', 'tactical-api', '--restart-requirements', 'true'), /Restart target must be a requirements or tactical design stage/);
  assert.ok(Object.values((await state()).stages).every((entry) => !entry.stale), 'refusals mark nothing');

  // Reopen the owner: nothing is rolled back, the downstream stages become stale.
  const headBefore = treeGit('rev-parse', 'HEAD').trim();
  const apiBefore = await readFile(join(workspace, api), 'utf8');
  const reopened = await beginStage('tactical-api', { extraArgs: ['--reopen-for', blockedId] });
  assert.equal(treeGit('rev-parse', 'HEAD').trim(), headBefore, 'no commit is rewound');
  assert.equal(await readFile(join(workspace, api), 'utf8'), apiBefore, 'the document is not rolled back');
  assert.equal(treeGit('status', '--porcelain', '--untracked-files=all').trim(), '', 'the worktree is untouched');
  const marked = await state();
  assert.equal(marked.stages['tactical-api'].status, 'running');
  assert.equal(marked.stages['tactical-api'].stale, undefined, 'the owner itself is not stale');
  assert.equal(marked.stages['tactical-technology'].stale, undefined);
  assert.equal(marked.stages['tactical-ui'].stale, undefined);
  assert.deepEqual({ ...marked.stages['tactical-data'].stale, marked_at: undefined }, { owner_stage: 'tactical-api', blocked_stage: 'tactical-data', reopened_for: blockedId, rerun_order: ['tactical-api', 'tactical-data'], marked_at: undefined });
  const input = reopened.prepared.input;
  assert.deepEqual(input.context.reopen, { reason: 'dependency_gap', owner_stage: 'tactical-api', blocked_stage: 'tactical-data', blocked_execution_id: blockedId, rerun_order: ['tactical-api', 'tactical-data'] });
  assert.ok(input.input_refs.some((ref) => ref.kind === 'dependency_gap_result' && ref.path.includes(blockedId)));
  assert.ok(input.input_refs.some((ref) => ref.kind === 'previous_execution_result'));
  const feedback = JSON.parse(await readFile(join(tree.worktree_ref, '..', `runtime/executions/${input.execution_id}/feedback.json`), 'utf8').catch(() => readFile(join(workspace, `.io/runtime/executions/${input.execution_id}/feedback.json`), 'utf8'))).feedback;
  assert.ok(feedback.includes(gap) && /edit|Edit/.test(feedback) && /do not start from scratch/.test(feedback));
  // The owner is still running: the order guard keeps the stale stages closed.
  refused(prepare('--stage-id', 'tactical-data'), /tactical-data cannot start before tactical-api/);
  refused(prepare('--stage-id', 'to-ticket'), /to-ticket cannot start before tactical-api/);

  // The owner edits forward and completes.
  await submitStage(reopened, { files: { [api]: `${apiBefore}\`DELETE /session\` 로그아웃 (application-service: LogoutUseCase)\n` }, summary: '로그아웃·세션 조회 계약 보강' });
  const ownerDone = invoke(workspace, 'harness-native-stage.mjs', ['finish', ...reopened.base]);
  assert.equal(ownerDone.status, 'completed');
  assert.match(ownerDone.next, /Stale stages remain: re-run them in order, next .*--stage-id tactical-data/);
  assert.match(ownerDone.next, /Do not ask the user/);
  assert.match(treeGit('show', '--', api), /DELETE \/session/, 'the owner commit holds the forward edit');
  // The old block can no longer be used to reopen again, and the downstream stages stay in order.
  refused(prepare('--stage-id', 'tactical-api', '--reopen-for', blockedId), /not its latest blocked/);
  refused(prepare('--stage-id', 'to-ticket'), /to-ticket cannot start before tactical-data/);
  refused(prepare('--stage-id', 'tracker-publish', '--publication-approved', 'true', '--approval-answer', 'ok'), /tracker-publish cannot start before tactical-data/);
  assert.ok((await state()).stages['tactical-data'].stale, 'the downstream result stays stale until it is re-run');

  // tactical-data, the blocked stage, is re-run last with a note that its upstream changed, from its own blocked result.
  const rerun = await beginStage('tactical-data');
  assert.equal(rerun.prepared.input.context.previous_result_note !== undefined, true);
  const rerunFeedback = JSON.parse(await readFile(join(workspace, `.io/runtime/executions/${rerun.prepared.input.execution_id}/feedback.json`), 'utf8')).feedback;
  assert.match(rerunFeedback, /Upstream changed: tactical-api was reopened for tactical-data/);
  assert.equal((await state()).stages['tactical-data'].stale, undefined, 'a new execution clears the stale mark');
  await submitStage(rerun, { files: { [data]: '`sessions` table\n`session_tokens` index\n' }, summary: '데이터 갱신' });
  assert.equal(invoke(workspace, 'harness-native-stage.mjs', ['finish', ...rerun.base]).status, 'completed');

  assert.ok(Object.values(await state().then((value) => value.stages)).every((entry) => !entry.stale), 'no stage is stale once every one was re-run');
});

test('update restores the rewind module of an installed consumer, Doctor requires it and Git ignores it', async (t) => {
  const { primary } = await consumerWorkflow(t, REQUEST);
  const module = '.harness/src/workflow/stage-reopen.mjs';
  const git = (...args) => spawnSync('git', ['-C', primary, ...args], { encoding: 'utf8' }).stdout;
  assert.equal(await readFile(join(primary, module), 'utf8'), await readFile(join(sourceRoot, module), 'utf8'), 'a fresh install has the module');
  await unlink(join(primary, module));
  const lockPath = join(primary, '.codex/harness-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  delete lock.files[module];
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  assert.ok((await runDoctor({ root: primary, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path === join(primary, module)), 'Doctor requires the module');
  assert.ok(!existsSync(join(primary, module)));
  await updateProject({ sourceRoot, targetRoot: primary });
  assert.equal(await readFile(join(primary, module), 'utf8'), await readFile(join(sourceRoot, module), 'utf8'), 'update installs the module');
  assert.ok(JSON.parse(await readFile(lockPath, 'utf8')).files[module], 'update records it');
  assert.equal((await runDoctor({ root: primary, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  assert.match(git('check-ignore', '-v', module), /info\/exclude/);
  assert.equal(git('status', '--short', '--untracked-files=all').trim(), '', 'Harness-owned files stay out of Git status');
  const installed = await readFile(join(primary, '.agents/skills/orchestrator/references/dispatch.md'), 'utf8');
  assert.match(installed, /--reopen-for/, 'the installed orchestrator guidance carries the rewind rule');
});

test('installed consumer: every refusal after a blocked DEPENDENCY_INCOMPLETE points to the rewind, legacy results relaunch the blocked stage', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, planSetId, treeGit, runStage, beginStage, submitStage, invoke } = flow;
  await writeFile(join(workspace, '.harness/harness.yaml'), SETUP);
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  const prepare = (...args) => spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--verbose', ...args], { cwd: workspace, encoding: 'utf8' });
  const refused = (result) => { assert.notEqual(result.status, 0, result.stdout); return JSON.parse(result.stderr.trim().split('\n').pop()); };
  const seeded = await state();
  for (const stage of TACTICAL_DESIGN_STAGES) seeded.stages[stage] = { status: 'completed', code: 'OK', result_ref: `runtime/executions/${stage}/result.json` };
  await writeFile(statePath, JSON.stringify(seeded, null, 2) + '\n');
  const designPath = `docs/specs/${planSetId}/tactical-design.md`;
  await mkdir(join(workspace, designPath, '..'), { recursive: true });
  await writeFile(join(workspace, designPath), '# 전술 설계\n');
  treeGit('add', 'docs'); treeGit('commit', '-qm', 'tactical design fixture');
  const impl = `docs/implementation/${planSetId}`;
  await runStage('tactical-technology', { files: { [`${impl}/technology.md`]: 'node --test\n' } });
  await runStage('tactical-ui', { expectCommit: false });
  await runStage('tactical-api', { files: { [`${impl}/api.md`]: '`POST /login`\n' }, summary: 'API' });

  const ticket = await beginStage('tactical-data');
  const blockedId = ticket.prepared.input.execution_id;
  await submitStage(ticket, { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: '설계 빈틈: application-service에 operation이 없다', resultExtra: { owner_stage: 'application-service', dependency_gap: '로그아웃 operation이 없다' } });
  assert.equal(invoke(workspace, 'harness-native-stage.mjs', ['finish', ...ticket.base]).code, 'DEPENDENCY_INCOMPLETE');

  const reopenNext = `launch --stage-id application-service --reopen-for ${blockedId}`;
  const attempts = () => [
    prepare('--stage-id', 'application-service', '--user-revision', 'true', '--feedback', 'x'),
    prepare('--stage-id', 'application-service', '--restart-requirements', 'true'),
    prepare('--stage-id', 'domain-service'),
  ].map(refused);
  const check = (errors, expected) => {
    for (const error of errors) {
      assert.equal(error.user_decision, undefined, JSON.stringify(error));
      assert.equal(error.next.length, 1, JSON.stringify(error));
      assert.ok(error.next[0].includes(expected), `${error.code}: ${error.next[0]}`);
    }
  };
  const withOwner = attempts();
  assert.ok(withOwner.some((error) => error.code === 'PREVIOUS_RESULT_MISSING' || error.code === 'PREVIOUS_UNRESOLVED'));
  assert.ok(withOwner.some((error) => error.code === 'RESTART_REFUSED'));
  check(withOwner, reopenNext);

  // A result recorded before owner_stage existed: the owner is only named in the summary.
  const entry = (await state()).stages['tactical-data'];
  const resultPath = join(workspace, '.io', entry.result_ref);
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  delete result.owner_stage; delete result.dependency_gap;
  await writeFile(resultPath, JSON.stringify(result));
  const legacy = attempts();
  check(legacy, "launch --stage-id tactical-data --feedback 'Re-check the blocker and return owner_stage and dependency_gap");

  // The relaunch of the blocked stage is accepted and its schema carries owner_stage / dependency_gap.
  const relaunched = await beginStage('tactical-data', { extraArgs: ['--feedback', 'Re-check the blocker and return owner_stage and dependency_gap naming the earlier stage that must change.'] });
  assert.equal(relaunched.prepared.input.context.previous_result_note !== undefined, true);
  const schema = JSON.parse(await readFile(relaunched.started.schema_path, 'utf8'));
  assert.ok(schema.properties.result.properties.owner_stage && schema.properties.result.properties.dependency_gap);
  await submitStage(relaunched, { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: '다시 확인', resultExtra: { owner_stage: null, dependency_gap: null } });
  assert.deepEqual(JSON.parse(flow.finishStage(relaunched).stdout).errors.map((error) => error.path), ['$.result.owner_stage'], 'the relaunch must name the owner');
  await submitStage(relaunched, { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: '다시 확인', resultExtra: { owner_stage: 'application-service', dependency_gap: '로그아웃 operation이 없다' } });
  const again = invoke(workspace, 'harness-native-stage.mjs', ['finish', ...relaunched.base]);
  assert.match(again.next, new RegExp(`launch --stage-id application-service --reopen-for ${relaunched.prepared.input.execution_id}`));
  check(attempts(), `launch --stage-id application-service --reopen-for ${relaunched.prepared.input.execution_id}`);
});

test('installed consumer: a stage blocked by ENVIRONMENT_UNAVAILABLE is retried with --feedback; refusals on other paths point to that relaunch', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, beginStage, submitStage, invoke } = flow;
  await writeFile(join(workspace, '.harness/harness.yaml'), SETUP);
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  const prepare = (...args) => spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--verbose', ...args], { cwd: workspace, encoding: 'utf8' });
  const refused = (result) => { assert.notEqual(result.status, 0, result.stdout); return JSON.parse(result.stderr.trim().split('\n').pop()); };
  const seeded = await state();
  for (const stage of [...PRE_SPEC_STAGES.slice(0, PRE_SPEC_STAGES.indexOf('application-service'))]) seeded.stages[stage] = { status: 'completed', code: 'OK', result_ref: `runtime/executions/${stage}/result.json` };
  await writeFile(statePath, JSON.stringify(seeded, null, 2) + '\n');

  const first = await beginStage('application-service');
  await submitStage(first, { status: 'blocked', code: 'ENVIRONMENT_UNAVAILABLE', summary: 'workspace preflight: tracker_status_unresolved', expectCommit: false });
  const blocked = invoke(workspace, 'harness-native-stage.mjs', ['finish', ...first.base]);
  assert.equal(blocked.code, 'ENVIRONMENT_UNAVAILABLE');
  assert.match(blocked.next, /launch --stage-id application-service --feedback /);
  assert.doesNotMatch(blocked.next, /Report the unblock condition/);
  assert.equal((await state()).stages['application-service'].code, 'ENVIRONMENT_UNAVAILABLE');

  const relaunchNext = 'launch --stage-id application-service --feedback';
  const attempts = [
    prepare('--stage-id', 'application-service', '--user-revision', 'true', '--feedback', 'x'),
    prepare('--stage-id', 'application-service', '--restart-requirements', 'true'),
    prepare('--stage-id', 'integration-design'),
    prepare('--stage-id', 'to-ticket', '--user-revision', 'true', '--feedback', 'scope narrowed'),
    prepare('--stage-id', 'to-ticket', '--restart', 'true'),
    prepare('--stage-id', 'tactical-api', '--user-revision', 'true', '--feedback', 'scope narrowed'),
  ].map(refused);
  for (const error of attempts) {
    assert.equal(error.user_decision, undefined, JSON.stringify(error));
    assert.equal(error.next.length, 1, JSON.stringify(error));
    assert.ok(error.next[0].includes(relaunchNext), `${error.code}: ${error.next[0]}`);
    assert.doesNotMatch(error.next[0], /--user-revision|--restart/);
  }
  assert.ok(attempts.some((error) => error.code === 'STAGE_ORDER'), JSON.stringify(attempts.map((error) => error.code)));

  // The relaunch is accepted, carries the user's instruction, and the stage runs again.
  const instruction = '로그아웃과 현재 세션 조회는 범위에서 제외한다';
  const relaunched = await beginStage('application-service', { extraArgs: ['--feedback', instruction] });
  assert.equal(relaunched.prepared.input.context.previous_result_note !== undefined, true);
  const feedback = JSON.parse(await readFile(join(workspace, `.io/runtime/executions/${relaunched.prepared.input.execution_id}/feedback.json`), 'utf8')).feedback;
  assert.ok(feedback.includes(instruction));
  assert.equal((await state()).stages['application-service'].status, 'running');
});

test('installed consumer: a stale or unfinished to-ticket record from before a rewind does not block the reopen, a current completed one does', async (t) => {
  const flow = await consumerWorkflow(t, REQUEST);
  const { workspace, planSetId, treeGit, runStage, beginStage, submitStage, invoke } = flow;
  await writeFile(join(workspace, '.harness/harness.yaml'), SETUP);
  const statePath = join(workspace, '.io/runtime/orchestrator/state.json');
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  const prepare = (...args) => spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-prepare-input.mjs'), '--verbose', ...args], { cwd: workspace, encoding: 'utf8' });
  const seeded = await state();
  for (const stage of TACTICAL_DESIGN_STAGES) seeded.stages[stage] = { status: 'completed', code: 'OK', result_ref: `runtime/executions/${stage}/result.json` };
  await writeFile(statePath, JSON.stringify(seeded, null, 2) + '\n');
  const designPath = `docs/specs/${planSetId}/tactical-design.md`;
  await mkdir(join(workspace, designPath, '..'), { recursive: true });
  await writeFile(join(workspace, designPath), '# 전술 설계\n');
  treeGit('add', 'docs'); treeGit('commit', '-qm', 'tactical design fixture');
  const impl = `docs/implementation/${planSetId}`;
  await runStage('tactical-technology', { files: { [`${impl}/technology.md`]: 'node --test\n' } });
  await runStage('tactical-ui', { expectCommit: false });
  await runStage('tactical-api', { files: { [`${impl}/api.md`]: '`POST /login`\n' }, summary: 'API' });
  const ticket = await beginStage('tactical-data');
  const blockedId = ticket.prepared.input.execution_id;
  await submitStage(ticket, { status: 'blocked', code: 'DEPENDENCY_INCOMPLETE', summary: '설계 빈틈', resultExtra: { owner_stage: 'tactical-api', dependency_gap: 'logout API가 없다' } });
  assert.equal(invoke(workspace, 'harness-native-stage.mjs', ['finish', ...ticket.base]).code, 'DEPENDENCY_INCOMPLETE');

  const seed = async (stages) => {
    const current = await state();
    for (const id of ['to-ticket', 'tracker-publish']) delete current.stages[id];
    Object.assign(current.stages, stages);
    await writeFile(statePath, JSON.stringify(current, null, 2) + '\n');
  };
  const stale = { owner_stage: 'application-service', blocked_stage: 'tactical-data', reopened_for: 'old', rerun_order: [], marked_at: '2026-01-01T00:00:00.000Z' };
  const refusedStarted = (result) => { assert.notEqual(result.status, 0, result.stdout); assert.match(result.stderr, /to-ticket has already started|tracker-publish has already started/); };
  const reopen = () => prepare('--stage-id', 'tactical-api', '--reopen-for', blockedId);

  // A current completed to-ticket, and any started tracker-publish, still refuse.
  await seed({ 'to-ticket': { status: 'completed', code: 'OK', result_ref: 'runtime/executions/to-ticket/result.json' } });
  refusedStarted(reopen());
  await seed({ 'tracker-publish': { status: 'blocked', code: 'INPUT_MISSING' }, 'to-ticket': { status: 'blocked', code: 'INPUT_MISSING', stale } });
  refusedStarted(reopen());

  // A stale blocked to-ticket left from before a rewind is ignored: the reopen is accepted.
  await seed({ 'to-ticket': { status: 'blocked', code: 'INPUT_MISSING', stale, result_ref: 'runtime/executions/to-ticket/result.json' } });
  const accepted = await beginStage('tactical-api', { extraArgs: ['--reopen-for', blockedId] });
  assert.equal(accepted.prepared.input.context.reopen.owner_stage, 'tactical-api');
});
