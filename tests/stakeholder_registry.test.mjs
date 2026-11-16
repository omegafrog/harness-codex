import './support/trusted-codex-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';
import { formatCard, parseCard, readRegistry } from '../.harness/src/stakeholders/cards.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const SETUP = `agents:
  provider: codex
  codex:
    high_performance_model: codex-high
    high_performance_reasoning_effort: high
    implementation_model: codex-implementation
    implementation_reasoning_effort: medium
    execution_model: codex-execution
    execution_reasoning_effort: low
    low_performance_model: codex-light
    low_performance_reasoning_effort: minimal
tracker:
  mode: local-markdown
  local_markdown:
    directory: docs/plans
`;

const cli = (root, args, cwd = root) => spawnSync(process.execPath, [join(root, '.codex/scripts/harness-stakeholder.mjs'), ...args], { cwd, encoding: 'utf8' });
const ok = (result) => { assert.equal(result.status, 0, result.stderr || result.stdout); return result; };
const gitIn = (root) => (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

test('cards round-trip through Markdown frontmatter, including quotes, colons and non-ASCII text', () => {
  const card = { id: 'SH-07', kind: 'person', role: '모더레이터: "신고" # 처리', goals: ['악성 글을 지운다', 'a: b', '- 대시로 시작'], pain_points: ['탭\t과 따옴표 "'], authority: '거부권' };
  const parsed = parseCard(formatCard(card, '메모는 본문에 남는다'), { fileName: 'SH-07.md' });
  assert.equal(parsed.card.role, card.role);
  assert.deepEqual(parsed.card.goals, card.goals);
  assert.deepEqual(parsed.card.pain_points, card.pain_points);
  assert.equal(parsed.card.authority, '거부권');
  assert.equal(parsed.card.kind, 'person');
  assert.equal(parsed.notes, '메모는 본문에 남는다');
  // Unknown fields are stored as UNKNOWN or empty lists and never reach the persona as claims.
  const sparse = parseCard(formatCard({ id: 'SH-08', role: '방문자', goals: ['글을 읽는다'] }));
  assert.equal(sparse.card.authority, 'UNKNOWN');
  assert.deepEqual(sparse.card.knowledge_boundary, []);
  assert.throws(() => formatCard({ id: 'SH-09', role: '방문자', goals: [] }), /goals needs at least one entry/);
  assert.throws(() => formatCard({ id: 'SH-9', role: '방문자', goals: ['x'] }), /id must look like SH-01/);
  assert.throws(() => formatCard({ id: 'SH-10', kind: 'robot', role: '방문자', goals: ['x'] }), /kind must be one of/);
});

test('the card CLI adds, edits, lists, validates and removes project-owned cards', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stakeholder-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const tool = join(sourceRoot, '.codex/scripts/harness-stakeholder.mjs');
  const run = (...args) => spawnSync(process.execPath, [tool, ...args, '--root', root], { encoding: 'utf8' });

  const added = ok(run('add', '--role', '모더레이터', '--goal', '악성 글을 빨리 지운다', '--goal', '신고를 놓치지 않는다', '--pain-point', '신고가 흩어져 있다', '--authority', '글 삭제 권한', '--knowledge-boundary', '결제 흐름'));
  assert.match(added.stdout, /docs\/domain\/stakeholders\/SH-01\.md/);
  assert.match(added.stdout, /커밋/);
  const second = ok(run('add', '--kind', 'constraint-source', '--role', '개인정보 보호 규정', '--goal', '개인정보를 목적 밖에 쓰지 않는다', '--constraint', '탈퇴 시 개인정보를 지운다', '--evidence', '요청 원문'));
  assert.match(second.stdout, /SH-02\.md/);
  assert.match(await readFile(join(root, 'docs/domain/stakeholders/SH-01.md'), 'utf8'), /^---\nid: SH-01\nkind: person\nrole: "모더레이터"/);

  const listed = JSON.parse(ok(run('list', '--json')).stdout);
  assert.deepEqual(listed.problems, []);
  assert.deepEqual(listed.cards.map((card) => [card.id, card.kind, card.role]), [['SH-01', 'person', '모더레이터'], ['SH-02', 'constraint-source', '개인정보 보호 규정']]);
  assert.deepEqual(listed.cards[0].goals, ['악성 글을 빨리 지운다', '신고를 놓치지 않는다']);
  assert.equal(listed.cards[0].authority, '글 삭제 권한');
  assert.deepEqual(listed.cards[0].vocabulary, []);
  assert.equal(listed.cards[1].authority, 'UNKNOWN');
  assert.match(ok(run('list')).stdout, /SH-01\tperson\t모더레이터\t악성 글을 빨리 지운다 \/ 신고를 놓치지 않는다/);

  // Only the fields given on the command line change; a repeated list flag replaces that whole list.
  ok(run('edit', 'SH-01', '--role', '커뮤니티 모더레이터', '--goal', '신고 처리 시간을 줄인다'));
  const edited = (await readRegistry(root)).cards[0].card;
  assert.equal(edited.role, '커뮤니티 모더레이터');
  assert.deepEqual(edited.goals, ['신고 처리 시간을 줄인다']);
  assert.deepEqual(edited.pain_points, ['신고가 흩어져 있다']);
  assert.equal(edited.authority, '글 삭제 권한');
  assert.match(ok(run('validate')).stdout, /카드 2개가 올바릅니다/);

  // A request without the required fields, an unknown card or an unknown option writes nothing.
  const missingGoal = run('add', '--role', '방문자');
  assert.equal(missingGoal.status, 2);
  assert.match(missingGoal.stderr, /goals needs at least one entry/);
  assert.equal(existsSync(join(root, 'docs/domain/stakeholders/SH-03.md')), false);
  assert.equal(run('add').status, 2, 'add needs a terminal or field flags');
  assert.match(run('edit', 'SH-09', '--role', 'x').stderr, /No stakeholder card SH-09/);
  assert.equal(run('add', '--role', '방문자', '--goal', '글을 읽는다', '--bogus', 'x').status, 2);

  // Invalid files are reported with the reason instead of being hidden, and the registry still lists the valid ones.
  const directory = join(root, 'docs/domain/stakeholders');
  await writeFile(join(directory, 'SH-03.md'), '---\nid: SH-03\nkind: person\ngoals:\n  - "목표"\n---\n');
  await writeFile(join(directory, 'SH-04.md'), formatCard({ id: 'SH-05', role: '이름 불일치', goals: ['x'] }));
  await writeFile(join(directory, 'SH-06.md'), '# frontmatter 없음\n');
  await writeFile(join(directory, 'README.md'), '# 카드 안내는 카드가 아니다\n');
  const validation = run('validate', '--json');
  assert.equal(validation.status, 1);
  const report = JSON.parse(validation.stdout);
  assert.deepEqual(report.cards.map((card) => card.id), ['SH-01', 'SH-02']);
  assert.deepEqual(report.problems.map((problem) => problem.path), ['docs/domain/stakeholders/SH-03.md', 'docs/domain/stakeholders/SH-04.md', 'docs/domain/stakeholders/SH-06.md']);
  assert.match(report.problems[0].message, /role is required/);
  assert.match(report.problems[1].message, /File name must match id: SH-05\.md/);
  assert.match(report.problems[2].message, /--- frontmatter/);
  const plain = run('validate');
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /형식 오류: docs\/domain\/stakeholders\/SH-03\.md: role is required/);
  assert.equal(run('list').status, 1, 'list reports invalid cards too');

  // A card that no longer parses can still be removed.
  assert.match(ok(run('remove', 'SH-03')).stdout, /삭제했습니다: docs\/domain\/stakeholders\/SH-03\.md/);
  assert.equal(existsSync(join(directory, 'SH-03.md')), false);
  assert.match(run('remove', 'SH-03').stderr, /No stakeholder card SH-03/);
  assert.equal(run('remove', '../../etc/passwd').status, 2);
  // The tool writes files only: it never stages or commits them for the project.
  assert.equal(gitIn(root)('diff', '--cached', '--name-only').trim(), '');
});

test('installed consumers get the stakeholder tools and stage guides, and Git keeps cards visible while Harness files stay ignored', async (t) => {
  await mkdir(resolve(sourceRoot, '.io'), { recursive: true });
  const root = await mkdtemp(resolve(sourceRoot, '.io/stakeholder-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = gitIn(root);
  execFileSync('git', ['init', '-q', root]);
  await writeFile(join(root, 'app.txt'), 'original application\n');
  git('add', 'app.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
  await writeFile(join(root, 'app.txt'), 'ongoing application change\n');
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  await writeFile(join(root, '.harness/harness.yaml'), SETUP);

  const managed = [
    '.codex/scripts/harness-stakeholder.mjs',
    '.harness/src/stakeholders/cards.mjs',
    '.codex/internal-skills/stakeholder-analysis/GUIDE.md',
    '.codex/internal-skills/stakeholder-analysis/references/output-template.md',
    '.codex/internal-skills/stakeholder-analysis/references/lenses/domain.md',
    '.codex/internal-skills/stakeholder-analysis/references/lenses/security.md',
    '.codex/internal-skills/stakeholder-persona/GUIDE.md',
    '.codex/agents/stakeholder_persona.toml',
    '.claude/agents/stakeholder_persona.md',
  ];
  const lock = JSON.parse(await readFile(join(root, '.codex/harness-lock.json'), 'utf8'));
  for (const path of managed) {
    assert.ok(existsSync(join(root, path)), `installed: ${path}`);
    assert.ok(lock.files[path], `lock inventory: ${path}`);
    assert.match(git('check-ignore', '-v', path), /info\/exclude/, `ignored: ${path}`);
  }
  assert.equal(await readFile(join(root, '.codex/scripts/harness-stakeholder.mjs'), 'utf8'), await readFile(join(sourceRoot, '.codex/scripts/harness-stakeholder.mjs'), 'utf8'));
  const profile = await readFile(join(root, '.claude/agents/stakeholder_persona.md'), 'utf8');
  assert.match(profile, /^name: stakeholder_persona$/m);
  assert.match(profile, /^permissionMode: plan$/m);
  assert.match(profile, /^tools: Read, Grep, Glob, WebSearch, WebFetch$/m);
  assert.match(profile, /stakeholder-persona\/GUIDE\.md/);
  assert.match(await readFile(join(root, '.codex/agents/stakeholder_persona.toml'), 'utf8'), /^sandbox_mode = "read-only"$/m);
  const { FRESH_AGENT_TYPES } = await import(pathToFileURL(join(root, '.codex/scripts/harness-fresh-agent.mjs')));
  assert.ok(FRESH_AGENT_TYPES.includes('stakeholder_persona'));

  // The installed tools resolve their tiers from the installed GUIDEs.
  const binding = (skill) => JSON.parse(execFileSync(process.execPath, [join(root, '.codex/scripts/harness-skill-execution.mjs'), 'binding', '--root', root, '--skill', skill], { cwd: root, encoding: 'utf8' }));
  assert.deepEqual(binding('stakeholder-persona'), { skill: 'stakeholder-persona', provider: 'codex', model_tier: 'low_performance', model: 'codex-light', reasoning_effort: 'minimal' });
  assert.equal(binding('stakeholder-analysis').model_tier, 'implementation');

  // The user registers a card with the installed CLI from the project root.
  assert.deepEqual(JSON.parse(ok(cli(root, ['list', '--json'])).stdout), { cards: [], problems: [] });
  const added = ok(cli(root, ['add', '--role', '모더레이터', '--goal', '악성 글을 지운다']));
  assert.match(added.stdout, /docs\/domain\/stakeholders\/SH-01\.md/);
  const status = git('status', '--short', '--untracked-files=all');
  assert.match(status, /\?\? docs\/domain\/stakeholders\/SH-01\.md/, 'the card is project-owned and visible to Git');
  assert.match(status, /^ M app\.txt$/m, 'application changes stay visible and untouched');
  // .harness/contracts.mjs is the one Harness file the project commits (the contracts checker), so it is not a managed-file leak.
  assert.doesNotMatch(status.replace('?? .harness/contracts.mjs\n', ''), /\.codex\/|\.harness\/|\.claude\/|\.agents\/|\.io\//, 'Harness-managed files stay out of commits');
  assert.throws(() => git('check-ignore', '-q', 'docs/domain/stakeholders/SH-01.md'), 'cards are not ignored');
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'ongoing application change\n');

  // Doctor accepts valid cards and reports a broken one without touching it.
  let doctor = await runDoctor({ root, sourceRoot });
  assert.equal(doctor.diagnostics.some((item) => item.code === 'stakeholder_card_invalid' || item.code === 'execution_asset_missing'), false);
  const broken = join(root, 'docs/domain/stakeholders/SH-02.md');
  const brokenText = '---\nid: SH-02\nkind: person\ngoals:\n  - "목표"\n---\n';
  await writeFile(broken, brokenText);
  doctor = await runDoctor({ root, sourceRoot });
  const invalid = doctor.diagnostics.filter((item) => item.code === 'stakeholder_card_invalid');
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].severity, 'warning');
  assert.equal(invalid[0].path, broken);
  assert.match(invalid[0].message, /role is required/);
  assert.equal(await readFile(broken, 'utf8'), brokenText);
  assert.match(git('status', '--short', '--untracked-files=all'), /\?\? docs\/domain\/stakeholders\/SH-02\.md/);
  ok(cli(root, ['remove', 'SH-02']));

  // A missing managed tool is an execution-asset error, and update restores it without touching the project's cards.
  const tool = join(root, '.codex/scripts/harness-stakeholder.mjs');
  const lens = join(root, '.codex/internal-skills/stakeholder-analysis/references/lenses/security.md');
  const cardText = await readFile(join(root, 'docs/domain/stakeholders/SH-01.md'), 'utf8');
  await unlink(tool);
  await writeFile(lens, 'locally edited lens\n');
  doctor = await runDoctor({ root, sourceRoot });
  assert.ok(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path === tool));
  await updateProject({ sourceRoot, targetRoot: root });
  assert.equal(await readFile(tool, 'utf8'), await readFile(join(sourceRoot, '.codex/scripts/harness-stakeholder.mjs'), 'utf8'));
  assert.equal(await readFile(lens, 'utf8'), await readFile(join(sourceRoot, '.codex/internal-skills/stakeholder-analysis/references/lenses/security.md'), 'utf8'));
  assert.equal(await readFile(join(root, 'docs/domain/stakeholders/SH-01.md'), 'utf8'), cardText);
  for (const path of managed) assert.match(git('check-ignore', '-v', path), /info\/exclude/, `still ignored after update: ${path}`);
  assert.equal((await runDoctor({ root, sourceRoot })).diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  assert.match(git('status', '--short', '--untracked-files=all'), /\?\? docs\/domain\/stakeholders\/SH-01\.md/);
});

test('stakeholder-analysis runs as a workflow stage that spec-me accepts as its previous stage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'stakeholder-stage-'));
  const primary = join(directory, 'main');
  const sessionId = randomUUID();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(primary);
  const git = gitIn(primary);
  execFileSync('git', ['init', '-q', '-b', 'main', primary]);
  git('config', 'user.name', 'Stage test'); git('config', 'user.email', 'test@example.test');
  await protectLocalInstallArtifacts(primary, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: primary, initialize: true });
  await writeFile(join(primary, '.harness/harness.yaml'), SETUP);
  await writeFile(join(primary, '.codex/context-budget.json'), '{"schema_version":1,"context_window_tokens":10000,"max_plan_tokens":6000,"handoff_reserve_tokens":2000}\n');
  for (const path of ['docs/agents/EXEC.md', 'docs/agents/execution.json', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/contracts/product.md', 'docs/contracts/architecture.md', 'docs/contracts/manifest.json', 'docs/contracts/architecture.html']) {
    await mkdir(join(primary, path, '..'), { recursive: true }); await writeFile(join(primary, path), '');
  }
  await writeFile(join(primary, 'app.txt'), 'baseline\n');
  git('add', 'app.txt', 'docs', 'CONTEXT.md', 'CONTEXT-MAP.md', '.harness/contracts.mjs');
  git('commit', '-qm', 'baseline');

  const invoke = (cwd, script, args = [], input) => {
    const result = spawnSync(process.execPath, [join(cwd, '.codex/scripts', script), ...args], { cwd, encoding: 'utf8', input });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const request = '게시글 삭제 기능을 추가해줘';
  const tree = invoke(primary, 'harness-compose-workspace.mjs', ['--root', primary, '--execution-id', 'compose-stakeholder', '--plan-set-id', 'community', '--request', request, '--orchestrator-provider', 'codex', '--orchestrator-session-id', sessionId]);
  const workspace = tree.workspace;
  const treeGit = gitIn(workspace);

  // Preparing the stage needs no workflow manifest: the stage id is the skill id, and the request is its scope.
  const prepared = invoke(workspace, 'harness-prepare-input.mjs', ['--stage-id', 'stakeholder-analysis']);
  assert.equal(prepared.input.skill, 'stakeholder-analysis');
  assert.equal(prepared.input.scope, request);
  assert.equal(prepared.input.context.stage_id, 'stakeholder-analysis');
  assert.equal(prepared.input.context.plan_set_id, undefined, 'the stored input derives the plan set from worktree.json');
  const executionId = prepared.input.execution_id;
  const base = ['--root', workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', executionId];
  const started = invoke(workspace, 'harness-native-stage.mjs', ['start', ...base]);
  assert.equal(started.agent_profile, 'workflow_stage');
  assert.equal(started.binding.model_tier, 'implementation');
  assert.equal(started.binding.model, 'codex-implementation');
  assert.equal(started.guide, join(workspace, '.codex/internal-skills/stakeholder-analysis/GUIDE.md'));
  const schema = JSON.parse(await readFile(started.schema_path, 'utf8'));
  assert.ok(schema.properties.result.properties.questions, 'the stage can return its user questions');
  invoke(workspace, 'harness-native-stage.mjs', ['bind', ...base, '--agent-id', 'facilitator-1']);

  // The stage writes its document at the plan set path and completes; the runner commits that document only.
  const planSetId = tree.plan_set_id;
  const artifactPath = execFileSync(process.execPath, [join(workspace, '.codex/scripts/harness-spec-path.mjs'), workspace, 'stakeholder-analysis.md'], { cwd: workspace, encoding: 'utf8' }).trim();
  assert.equal(artifactPath, `docs/specs/${planSetId}/stakeholder-analysis.md`);
  await mkdir(join(workspace, 'docs/specs', planSetId), { recursive: true });
  await mkdir(join(workspace, 'docs/domain/stakeholders'), { recursive: true });
  await writeFile(join(workspace, artifactPath), `# Stakeholder 분석\n\n> ${request}\n`);
  await writeFile(join(workspace, 'docs/domain/stakeholders/SH-01.md'), formatCard({ id: 'SH-01', role: '작성자', goals: ['내 글을 지운다'] }));
  const completed = { schema_version: 1, skill: 'stakeholder-analysis', status: 'completed', code: 'OK', result: { schema_version: 1, skill: 'stakeholder-analysis', status: 'completed', code: 'OK', summary: 'CAND 1건 채택', artifacts: [{ base: 'workspace', path: artifactPath, kind: 'stakeholder_analysis', sha256: '0'.repeat(64) }], questions: [], review_request: null } };
  await writeFile(started.output_path, JSON.stringify(completed));
  const finished = invoke(workspace, 'harness-native-stage.mjs', ['finish', ...base]);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.code, 'OK');
  assert.deepEqual(treeGit('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [artifactPath]);
  assert.equal(treeGit('log', '-1', '--format=%s').trim(), `stakeholder-analysis: ${planSetId}`);
  assert.match(treeGit('status', '--short', '--untracked-files=all'), /\?\? docs\/domain\/stakeholders\/SH-01\.md/, 'the runner leaves the project-owned card alone');

  // spec-me follows the completed stage and receives the document as an input reference.
  const next = invoke(workspace, 'harness-prepare-input.mjs', ['--stage-id', 'spec-me']);
  assert.equal(next.input.skill, 'spec-me');
  assert.equal(next.input.context.transition.from_stage, 'stakeholder-analysis');
  assert.equal(next.input.context.transition.code, 'OK');
  assert.ok(next.input.input_refs.some((reference) => reference.base === 'workspace' && reference.path === artifactPath && reference.kind === 'stakeholder_analysis'));
  assert.ok(existsSync(join(workspace, artifactPath)));
});
