import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { loadNamedWorkflow } from '../.harness/src/workflow/loader.mjs';
import { PRE_SPEC_STAGES, TACTICAL_DESIGN_STAGES, TACTICAL_IMPLEMENTATION_STAGES, tacticalImplementationOrderViolation, WORKTREE_STAGE } from '../.harness/src/workflow/worktree-stages.mjs';
import { consumerWorkflow, SETUP, sourceRoot } from './support/consumer-workflow.mjs';

test('tactical implementation is ordered after completed tactical design and remains outside pre-spec restarts', async () => {
  assert.deepEqual(TACTICAL_IMPLEMENTATION_STAGES, ['tactical-technology', 'tactical-ui', 'tactical-api', 'tactical-data', 'tactical-code']);
  assert.ok(TACTICAL_IMPLEMENTATION_STAGES.every((stage) => Object.values(WORKTREE_STAGE).includes(stage)));
  assert.ok(TACTICAL_IMPLEMENTATION_STAGES.every((stage) => !PRE_SPEC_STAGES.includes(stage)));
  assert.match(tacticalImplementationOrderViolation({}, 'tactical-technology'), /requires completed\/OK tactical design stage domain-model/);
  const designed = Object.fromEntries(TACTICAL_DESIGN_STAGES.map((stage) => [stage, { status: 'completed', code: 'OK' }]));
  assert.equal(tacticalImplementationOrderViolation(designed, 'tactical-technology'), null);
  assert.match(tacticalImplementationOrderViolation(designed, 'tactical-code'), /cannot start before tactical-technology/);
  const technical = { ...designed, 'tactical-technology': { status: 'completed', code: 'OK' } };
  assert.match(tacticalImplementationOrderViolation(technical, 'tactical-api'), /cannot start before tactical-ui/);
  const ui = { ...technical, 'tactical-ui': { status: 'completed', code: 'OK' } };
  assert.match(tacticalImplementationOrderViolation(ui, 'tactical-code'), /cannot start before tactical-api/);
  const api = { ...ui, 'tactical-api': { status: 'completed', code: 'OK' } };
  assert.match(tacticalImplementationOrderViolation(api, 'tactical-code'), /cannot start before tactical-data/);
  assert.equal(tacticalImplementationOrderViolation({ ...api, 'tactical-data': { status: 'completed', code: 'OK' } }, 'tactical-code'), null);
  assert.ok((await import('../.harness/src/workflow/stage-commit.mjs')).restartDocuments('tactical-code', 'demo').every((path) => !/^(src|test|app)\//.test(path)));

  const workflow = await loadNamedWorkflow('tactical-to-code', { root: sourceRoot });
  assert.deepEqual(workflow.stages.map(({ id }) => id), [...TACTICAL_IMPLEMENTATION_STAGES]);
  assert.ok(workflow.stages.every((stage, index) => stage.needs.length === (index ? 1 : 0)));
  assert.ok(workflow.stages.some(({ id }) => id === 'tactical-ui'), 'the flow has an explicit UI applicability/handoff stage');
  assert.equal(workflow.stages.some(({ skill }) => skill === 'frontend-design'), false, 'frontend design stays its own workflow');
  const guide = await readFile(join(sourceRoot, '.codex/internal-skills/skill-execution/references/workflow-map.md'), 'utf8');
  assert.match(guide, /별도 `tactical-to-code` workflow/);
  assert.match(guide, /`tactical-ui` handoff/);
});

test('fresh install and update distribute the flow, Doctor inventories it, and installed assets stay ignored', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tactical-to-code-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'app.txt'), 'original\n');
  git('add', 'app.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
  await writeFile(join(root, 'app.txt'), 'application edit\n');
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  await writeFile(join(root, '.harness/harness.yaml'), SETUP);

  const assets = [
    '.codex/workflows/tactical-to-code.yaml',
    ...['tactical-technology', 'tactical-ui', 'tactical-api', 'tactical-data', 'tactical-code'].map((name) => `.codex/internal-skills/${name}/GUIDE.md`),
    '.codex/agents/tactical_designer.toml',
    '.codex/agents/tactical_implementation_agent.toml',
    '.harness/src/workflow/worktree-stages.mjs',
    '.harness/src/workflow/stage-input.mjs',
    '.codex/scripts/harness-native-stage.mjs',
  ];
  const lock = JSON.parse(await readFile(join(root, '.codex/harness-lock.json'), 'utf8'));
  for (const path of assets) {
    assert.ok(lock.files[path], `lock records ${path}`);
    assert.match(git('check-ignore', '-v', path), /info\/exclude/, `${path} ignored`);
  }
  const doctor = await runDoctor({ root, sourceRoot });
  assert.deepEqual(doctor.diagnostics.filter(({ code, severity }) => severity === 'error' && ['execution_asset_missing', 'workflow_invalid'].includes(code)), []);
  const installedStages = await import(pathToFileURL(join(root, '.harness/src/workflow/worktree-stages.mjs')));
  assert.deepEqual([...installedStages.TACTICAL_IMPLEMENTATION_STAGES], [...TACTICAL_IMPLEMENTATION_STAGES]);
  assert.match(installedStages.tacticalImplementationOrderViolation({}, 'tactical-code'), /requires completed\/OK tactical design stage/);

  await mkdir(join(root, 'docs/implementation/demo'), { recursive: true });
  await writeFile(join(root, 'docs/implementation/demo/technology.md'), 'confirmed project decision\n');
  const status = git('status', '--short', '--untracked-files=all');
  assert.match(status, /^M app\.txt$/m);
  assert.match(status, /\?\? docs\/implementation\/demo\/technology\.md/);
  assert.doesNotMatch(status, /\.codex\/|\.harness\/|\.agents\/|\.claude\/|\.io\//);

  await updateProject({ sourceRoot, targetRoot: root, force: true });
  for (const path of assets) assert.match(git('check-ignore', '-v', path), /info\/exclude/, `${path} remains ignored after update`);
});

test('installed prepare command enforces the tactical implementation order', async (t) => {
  const flow = await consumerWorkflow(t, '요청 기능을 기존 tactical design에 따라 구현한다');
  const statePath = join(flow.workspace, '.io/runtime/orchestrator/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const stage of TACTICAL_DESIGN_STAGES) state.stages[stage] = { status: 'completed', code: 'OK', result_ref: `runtime/executions/${stage}/result.json` };
  state.current_stage = 'workflow-compose';
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
  const prepare = (stage) => execFileSync(process.execPath, [join(flow.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--verbose', '--stage-id', stage], { cwd: flow.workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  assert.throws(() => prepare('tactical-code'), (error) => /tactical-code cannot start before tactical-technology/.test(error.stderr));
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).stages['tactical-code'], undefined, 'out-of-order preparation records no stage result');
  const first = JSON.parse(prepare('tactical-technology'));
  assert.equal(first.input.context.stage_id, 'tactical-technology');
  const staleState = JSON.parse(await readFile(statePath, 'utf8'));
  staleState.stages['context-boundary'].status = 'blocked';
  staleState.stages['context-boundary'].code = 'DEPENDENCY_INCOMPLETE';
  await writeFile(statePath, JSON.stringify(staleState, null, 2) + '\n');
  assert.throws(() => execFileSync(process.execPath, [join(flow.workspace, '.codex/scripts/harness-native-stage.mjs'), 'start', '--root', flow.workspace, '--worktree-ref', flow.tree.worktree_ref, '--execution-id', first.input.execution_id], { cwd: flow.workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), (error) => /tactical-technology requires completed\/OK tactical design stage context-boundary/.test(error.stderr));
  assert.notEqual(JSON.parse(await readFile(statePath, 'utf8')).stages['tactical-technology']?.status, 'running', 'start rechecks tactical design and claims nothing after an upstream revision');
});

test('installed dispatch selects the tactical code profile and commits only requested application files', async (t) => {
  const flow = await consumerWorkflow(t, 'server-only maintenance; UI와 API를 제외하고 저장할 상태가 없다');
  const statePath = join(flow.workspace, '.io/runtime/orchestrator/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const stage of TACTICAL_DESIGN_STAGES) state.stages[stage] = { status: 'completed', code: 'OK', result_ref: `runtime/executions/${stage}/result.json` };
  state.current_stage = 'workflow-compose';
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');

  const decisions = [
    ['tactical-technology', 'technology.md', '기존 Node runtime과 package scripts를 유지한다.\n'],
    ['tactical-ui', 'ui-handoff.md', '사용자 요청이 server-only이므로 UI는 적용되지 않는다.\n'],
    ['tactical-api', 'api.md', '사용자 요청에서 API를 제외했으므로 추가 API 계약은 없다.\n'],
    ['tactical-data', 'data.md', '이 요청은 저장 상태가 없다.\n'],
  ];
  let technologyCommit;
  for (const [stage, name, content] of decisions) {
    const path = `docs/implementation/${flow.planSetId}/${name}`;
    const result = await flow.runStage(stage, {
      files: { [path]: content, ...(stage === 'tactical-technology' ? { 'docs/agents/EXEC.md': '검증 명령: npm test\n' } : {}) },
      expectCommit: true,
    });
    if (stage === 'tactical-technology') technologyCommit = result.files;
  }
  assert.ok(technologyCommit.includes('docs/agents/EXEC.md'), 'the technology stage commits optional execution guidance alongside its own decision');

  const source = 'export const answer = () => 42;\n';
  const unit = "import assert from 'node:assert/strict';\nimport { answer } from '../src/answer.mjs';\nassert.equal(answer(), 42);\n";
  const code = await flow.runStage('tactical-code', {
    files: { 'src/answer.mjs': source, 'test/answer.test.mjs': unit },
    commit_request: { message: `tactical-code: ${flow.planSetId}`, paths: ['src/answer.mjs', 'test/answer.test.mjs'] },
    expectCommit: true,
  });
  assert.equal(code.started.agent_profile, 'tactical_implementation_agent');
  assert.equal(code.started.binding.model_tier, 'implementation');
  assert.equal(code.started.binding.model, 'codex-implementation');
  assert.deepEqual(code.files, ['src/answer.mjs', 'test/answer.test.mjs']);
  assert.equal(await readFile(join(flow.workspace, 'src/answer.mjs'), 'utf8'), source);
  assert.equal(await readFile(join(flow.workspace, 'test/answer.test.mjs'), 'utf8'), unit);
  assert.equal(flow.treeGit('status', '--porcelain', '--untracked-files=all').trim(), '');
});
