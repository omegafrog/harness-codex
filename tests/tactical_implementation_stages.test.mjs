import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { RETIRED_ASSET_PATHS, RETIRED_SKILL_NAMES } from '../.harness/src/installer/legacy-assets.mjs';
import { loadNamedWorkflow } from '../.harness/src/workflow/loader.mjs';
import { PRE_SPEC_STAGES, TACTICAL_DESIGN_STAGES, TACTICAL_IMPLEMENTATION_STAGES, tacticalImplementationOrderViolation, WORKTREE_STAGE } from '../.harness/src/workflow/worktree-stages.mjs';
import { consumerWorkflow, SETUP, sourceRoot } from './support/consumer-workflow.mjs';

test('tactical implementation is ordered after completed tactical design and remains outside pre-spec restarts', async () => {
  assert.deepEqual(TACTICAL_IMPLEMENTATION_STAGES, ['tactical-technology', 'tactical-ui', 'tactical-api', 'tactical-data', 'to-ticket', 'tracker-publish', 'tactical-code']);
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
  assert.match(tacticalImplementationOrderViolation(api, 'to-ticket'), /cannot start before tactical-data/);
  const data = { ...api, 'tactical-data': { status: 'completed', code: 'OK' } };
  assert.equal(tacticalImplementationOrderViolation(data, 'to-ticket'), null, 'the ticket split follows the settled decisions');
  assert.match(tacticalImplementationOrderViolation(data, 'tracker-publish'), /cannot start before to-ticket/);
  assert.match(tacticalImplementationOrderViolation(data, 'tactical-code'), /cannot start before to-ticket/);
  const split = { ...data, 'to-ticket': { status: 'completed', code: 'OK' } };
  assert.equal(tacticalImplementationOrderViolation(split, 'tracker-publish'), null);
  assert.match(tacticalImplementationOrderViolation(split, 'tactical-code'), /cannot start before tracker-publish/, 'no code before the plan set is published');
  assert.match(tacticalImplementationOrderViolation({ ...split, 'tracker-publish': { status: 'waiting', code: 'USER_DECISION_REQUIRED' } }, 'tactical-code'), /cannot start before tracker-publish/);
  assert.equal(tacticalImplementationOrderViolation({ ...split, 'tracker-publish': { status: 'completed', code: 'OK' } }, 'tactical-code'), null);
  assert.ok((await import('../.harness/src/workflow/stage-commit.mjs')).restartDocuments('tactical-code', 'demo').every((path) => !/^(src|test|app)\//.test(path)));

  const workflow = await loadNamedWorkflow('tactical-to-code', { root: sourceRoot });
  assert.deepEqual(workflow.stages.map(({ id }) => id), [...TACTICAL_IMPLEMENTATION_STAGES]);
  assert.ok(workflow.stages.every((stage, index) => stage.needs.length === (index ? 1 : 0)));
  assert.ok(workflow.stages.some(({ id }) => id === 'tactical-ui'), 'the flow has an explicit UI applicability/handoff stage');
  // The ticket stages are the existing ones: the plan-and-publish scope declares the same roles and tiers, and neither
  // workflow asks for a Spec review.
  const planning = await loadNamedWorkflow('to-ticket', { root: sourceRoot });
  for (const id of ['to-ticket', 'tracker-publish']) {
    const [a, b] = [workflow, planning].map((item) => item.stages.find((stage) => stage.id === id));
    assert.deepEqual([a.skill, a.role, a.model_tier], [b.skill, b.role, b.model_tier], `${id} is declared identically`);
  }
  for (const item of [workflow, planning]) assert.ok(!Object.values(item.hooks).flat().includes('spec_reviews'), `${item.id} needs no Spec review`);
  assert.ok(workflow.hooks.before_complete.includes('plan_review') && workflow.hooks.before_complete.includes('required_outcome'));
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
  assert.equal(await readFile(join(root, '.codex/workflows/spec-me.yaml'), 'utf8').catch(() => null), null, 'fresh install has no spec-me workflow');
  await writeFile(join(root, '.harness/harness.yaml'), SETUP);

  const assets = [
    '.codex/workflows/tactical-to-code.yaml',
    ...['tactical-technology', 'tactical-ui', 'tactical-api', 'tactical-data', 'to-ticket', 'plan-review', 'tracker-publish', 'tactical-code'].map((name) => `.codex/internal-skills/${name}/GUIDE.md`),
    '.codex/internal-skills/to-ticket/references/split.md',
    '.codex/agents/tactical_designer.toml',
    '.codex/agents/tactical_implementation_agent.toml',
    '.codex/agents/to_ticket.toml',
    '.codex/agents/tracker_publisher.toml',
    '.codex/agents/plan_reviewer.toml',
    '.harness/src/workflow/worktree-stages.mjs',
    '.harness/src/workflow/stage-input.mjs',
    '.harness/src/workflow/tactical-tickets.mjs',
    '.harness/src/workflow/plan-review.mjs',
    '.harness/src/tracker/publication.mjs',
    '.codex/scripts/harness-native-stage.mjs',
    '.codex/scripts/harness-context.mjs',
  ];
  const lock = JSON.parse(await readFile(join(root, '.codex/harness-lock.json'), 'utf8'));
  for (const path of assets) {
    assert.ok(lock.files[path], `lock records ${path}`);
    assert.match(git('check-ignore', '-v', path), /info\/exclude/, `${path} ignored`);
  }
  const doctor = await runDoctor({ root, sourceRoot });
  assert.deepEqual(doctor.diagnostics.filter(({ code, severity }) => severity === 'error' && ['execution_asset_missing', 'workflow_invalid'].includes(code)), []);
  assert.equal(doctor.diagnostics.some(({ path }) => path?.endsWith('/spec-me.yaml')), false, 'Doctor no longer sees spec-me as an installed workflow');
  assert.deepEqual(doctor.diagnostics.filter(({ severity, code }) => severity === 'error' && ['tracker_publisher_stage_missing', 'tracker_publisher_sandbox', 'dangerous_sandbox_scope'].includes(code)), [], 'both workflows declare the dedicated publisher stage');
  const installedStages = await import(pathToFileURL(join(root, '.harness/src/workflow/worktree-stages.mjs')));
  assert.deepEqual([...installedStages.TACTICAL_IMPLEMENTATION_STAGES], [...TACTICAL_IMPLEMENTATION_STAGES]);
  assert.match(installedStages.tacticalImplementationOrderViolation({}, 'tactical-code'), /requires completed\/OK tactical design stage/);
  assert.match(installedStages.tacticalImplementationOrderViolation({}, 'tracker-publish'), /requires completed\/OK tactical design stage/);

  await mkdir(join(root, 'docs/implementation/demo'), { recursive: true });
  await writeFile(join(root, 'docs/implementation/demo/technology.md'), 'confirmed project decision\n');
  const status = git('status', '--short', '--untracked-files=all');
  assert.match(status, /^M app\.txt$/m);
  assert.match(status, /\?\? docs\/implementation\/demo\/technology\.md/);
  assert.doesNotMatch(status, /\.codex\/|\.harness\/|\.agents\/|\.claude\/|\.io\//);

  const retiredPaths = ['.codex/workflows/spec-me.yaml', '.codex/internal-skills/spec-me/GUIDE.md', '.codex/agents/spec_document_writer.toml', '.claude/agents/spec_document_writer.md'];
  for (const path of retiredPaths) {
    assert.equal(await readFile(join(root, path), 'utf8').catch(() => null), null, `fresh install excludes ${path}`);
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), `legacy ${path}\n`);
  }
  const updated = await updateProject({ sourceRoot, targetRoot: root, force: true });
  for (const path of retiredPaths) {
    assert.equal(await readFile(join(root, path), 'utf8').catch(() => null), null, `update retires ${path}`);
    assert.ok(updated.retired.includes(path));
    assert.equal(await readFile(join(updated.backup_directory, path), 'utf8'), `legacy ${path}\n`, `update backs up ${path}`);
  }
  for (const path of assets) assert.match(git('check-ignore', '-v', path), /info\/exclude/, `${path} remains ignored after update`);
});

test('update removes every retired spec-me asset from an installed consumer and leaves only project-owned documents visible', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'spec-me-retirement-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const sha = (content) => createHash('sha256').update(content).digest('hex');
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'app.txt'), 'original\n');
  git('add', 'app.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
  await writeFile(join(root, 'app.txt'), 'application edit\n');
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  await writeFile(join(root, '.harness/harness.yaml'), SETUP);

  // What nothing reads any more is neither installed nor required; what a live stage still links stays installed.
  const retiredSkills = [...RETIRED_SKILL_NAMES];
  assert.deepEqual(retiredSkills.sort(), ['architecture-review', 'architecture-spec', 'spec-me']);
  for (const path of RETIRED_ASSET_PATHS) assert.equal(await readFile(join(root, path), 'utf8').catch(() => null), null, `fresh install excludes ${path}`);
  for (const name of retiredSkills) assert.equal(await readFile(join(sourceRoot, '.codex/internal-skills', name, 'GUIDE.md'), 'utf8').catch(() => null), null, `source no longer has ${name}`);
  const kept = ['product-spec', 'spec-review', 'technology-selection', 'to-ticket', 'plan-review', 'tracker-publish'].map((name) => `.codex/internal-skills/${name}/GUIDE.md`);
  for (const path of kept) assert.ok((await readFile(join(root, path), 'utf8')).length > 0, `${path} stays installed`);
  assert.equal((await readFile(join(root, '.codex/internal-skills/requirements-fix/GUIDE.md'), 'utf8')).includes('spec-me/GUIDE.md'), false, 'a live stage guide links no retired guide');
  assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some(({ severity, code }) => severity === 'error' && ['execution_asset_missing', 'workflow_invalid', 'broken_reference'].includes(code)), false);

  // An earlier release installed these as managed, locked files; one copy was edited by the user, one never was in the lock.
  const previous = {
    '.codex/internal-skills/spec-me/GUIDE.md': 'previous spec-me guide',
    '.codex/internal-skills/spec-me/references/adversarial-spec-review.md': 'previous spec review driver',
    '.codex/internal-skills/spec-me/references/architecture-decision.md': 'previous decision order',
    '.codex/internal-skills/spec-me/references/decision-knowledge.md': 'previous decision knowledge',
    '.codex/internal-skills/architecture-spec/GUIDE.md': 'previous architecture guide',
    '.codex/internal-skills/architecture-spec/references/template.md': 'previous architecture template',
    '.codex/internal-skills/architecture-spec/references/topics.md': 'previous architecture topics',
    '.codex/internal-skills/architecture-review/GUIDE.md': 'previous architecture review guide',
    '.codex/agents/architecture_review_lead.toml': 'previous review lead',
    '.claude/agents/architecture_review_lead.md': 'previous review lead for Claude',
    '.agents/skills/spec-me/SKILL.md': 'previous public spec-me skill',
    '.claude/skills/spec-me/SKILL.md': 'previous public spec-me skill for Claude',
  };
  const lockPath = join(root, '.codex/harness-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  for (const [path, content] of Object.entries(previous)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
    lock.files[path] = { installed_sha256: sha(content), upstream_sha256: sha(content), source_path: path.startsWith('.claude/agents/') ? '.codex/agents/architecture_review_lead.toml' : path };
  }
  const edited = '.codex/internal-skills/architecture-spec/references/template.md';
  lock.files[edited].installed_sha256 = sha('the template as released');
  lock.files[edited].upstream_sha256 = lock.files[edited].installed_sha256;
  const notes = '.codex/internal-skills/spec-me/notes.md';
  await writeFile(join(root, notes), 'a note the user keeps next to the old guide\n');
  await writeFile(lockPath, JSON.stringify(lock));
  const projectDocuments = {
    'docs/agents/EXEC.md': 'project execution notes\n',
    'docs/contracts/product.md': 'project product contract\n',
    'docs/specs/demo/product-spec.md': '# existing approved Product Spec\n',
    'docs/specs/demo/architecture-spec.md': '# existing approved Architecture Spec\n',
  };
  for (const [path, content] of Object.entries(projectDocuments)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }

  const updated = await updateProject({ sourceRoot, targetRoot: root });
  for (const [path, content] of Object.entries(previous)) {
    assert.ok(updated.retired.includes(path), `${path} is retired by the update`);
    assert.equal(await readFile(join(root, path), 'utf8').catch(() => null), null, `${path} is removed`);
    assert.equal(await readFile(join(updated.backup_directory, path), 'utf8'), content, `${path} is backed up first`);
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).files[path], undefined, `${path} leaves the lock`);
  }
  assert.equal(await readFile(join(root, notes), 'utf8'), 'a note the user keeps next to the old guide\n', 'a file the lock never owned is kept');
  for (const [path, content] of Object.entries(projectDocuments)) assert.equal(await readFile(join(root, path), 'utf8'), content, `${path} is untouched`);
  for (const path of kept) assert.ok((await readFile(join(root, path), 'utf8')).length > 0, `${path} survives the update`);
  const status = git('status', '--short', '--untracked-files=all');
  assert.match(status, /^M app\.txt$/m);
  assert.match(status, /\?\? \.codex\/internal-skills\/spec-me\/notes\.md/, 'the user-owned note stays visible to Git');
  for (const path of Object.keys(projectDocuments)) assert.match(status, new RegExp(`\\?\\? ${path.replaceAll('.', '\\.')}`), `${path} stays visible`);
  assert.doesNotMatch(status, /\.agents\/|\.claude\/|\.harness\/|\.io\/|installer-backups/);
  for (const path of Object.keys(previous)) assert.doesNotMatch(status, new RegExp(path.replaceAll('.', '\\.')), `${path} is not left behind as a change`);
  const doctor = await runDoctor({ root, sourceRoot });
  assert.deepEqual(doctor.diagnostics.filter(({ severity, code }) => severity === 'error' && ['execution_asset_missing', 'workflow_invalid', 'broken_reference'].includes(code)), []);
  assert.equal(doctor.diagnostics.some(({ path }) => /spec-me|architecture-spec|architecture-review|architecture_review_lead/.test(path || '') && !path.endsWith('notes.md')), false, 'Doctor neither requires nor reports the retired assets');
  assert.deepEqual((await updateProject({ sourceRoot, targetRoot: root })).retired, [], 'a second update has nothing left to retire');
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

test('installed decisions are committed alone and the ticket stages wait for them', async (t) => {
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

  // The decisions alone do not start code: the ticket split and the user-approved publication come first. The ticket-by-ticket
  // run of tactical-code (profile, binding, one commit per ticket) is covered by tactical_ticket_flow.test.mjs.
  const prepare = (...args) => spawnSync(process.execPath, [join(flow.workspace, '.codex/scripts/harness-prepare-input.mjs'), '--verbose', ...args], { cwd: flow.workspace, encoding: 'utf8' });
  assert.match(prepare('--stage-id', 'tactical-code', '--plan', 'any-ticket').stderr, /tactical-code cannot start before to-ticket/);
  assert.match(prepare('--stage-id', 'tracker-publish', '--publication-approved', 'true', '--approval-answer', '발행하세요').stderr, /tracker-publish cannot start before to-ticket/);
  assert.equal(flow.treeGit('status', '--porcelain', '--untracked-files=all').trim(), '');
});
