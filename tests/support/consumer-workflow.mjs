// A consumer project with a prepared workflow worktree, driven the way the orchestrator drives each stage:
// prepare, start, bind, the stage writes its documents, finish. Shared by the tests of the pre-spec flow.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateProject } from '../../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../../.harness/src/installer/local-exclude.mjs';

export const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
export const SETUP = `agents:
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
// The tier each requirements, tactical design and tactical implementation stage declares in its own GUIDE.
export const STAGE_TIERS = {
  'stakeholder-analysis': 'implementation', 'subdomain-candidates': 'implementation', 'event-storming': 'implementation', 'subdomain-classification': 'implementation', 'bounded-context': 'high_performance', 'ubiquitous-language': 'implementation', 'requirements-fix': 'high_performance',
  'domain-model': 'high_performance', 'aggregate-design': 'high_performance', 'domain-service': 'implementation', 'application-service': 'implementation', 'integration-design': 'high_performance', 'context-boundary': 'high_performance',
  'tactical-technology': 'low_performance', 'tactical-ui': 'low_performance', 'tactical-api': 'low_performance', 'tactical-data': 'low_performance', 'to-ticket': 'high_performance', 'tracker-publish': 'high_performance', 'tactical-code': 'implementation',
};
// The agent profile each tactical implementation stage runs under; every other stage runs as a plain workflow stage.
const STAGE_PROFILES = { 'to-ticket': 'to_ticket', 'tracker-publish': 'tracker_publisher', 'tactical-code': 'tactical_implementation_agent' };
export const MODELS = { implementation: 'codex-implementation', high_performance: 'codex-high', low_performance: 'codex-light' };
// A stakeholder-analysis.md that passes the runner's check: the requester is a participant and the requested feature is
// recorded as the requester's settled requirement, quoted from the request.
export const stakeholderAnalysisDocument = (request, feature = request) => `# Stakeholder 분석\n\n> ${request}\n\n## 3. 참여자\n\n| ID | 구분 | 역할 | 실행 | 선택 근거 |\n|---|---|---|---|---|\n| REQUESTER | 요청자 | 요청자 | 요청 원문 | 요청에 적은 기능은 요청자가 정한 요구사항이다 |\n| LENS-DOMAIN | 전문가 관점 | 도메인 전문가 | 실행 | 기본 관점 |\n\n### 요청 기능\n\n| 요청 기능 | 요청 문구 | 제안자 | 결정 | 출처 | 내용 질문 |\n|---|---|---|---|---|---|\n| ${feature} | "${feature}" | REQUESTER | 확정 | 요청 원문 | - |\n`;
export const gitIn = (root) => (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

export async function consumerWorkflow(t, request) {
  const directory = await mkdtemp(join(tmpdir(), 'requirements-stage-'));
  const primary = join(directory, 'main');
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
  git('add', 'app.txt', 'docs', 'CONTEXT.md', 'CONTEXT-MAP.md');
  git('commit', '-qm', 'baseline');
  const invoke = (cwd, script, args = [], input) => {
    const result = spawnSync(process.execPath, [join(cwd, '.codex/scripts', script), ...args], { cwd, encoding: 'utf8', input });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const tree = invoke(primary, 'harness-compose-workspace.mjs', ['--root', primary, '--execution-id', 'compose-requirements', '--plan-set-id', 'community', '--request', request, '--orchestrator-provider', 'codex', '--orchestrator-session-id', randomUUID()]);
  const workspace = tree.workspace;
  const treeGit = gitIn(workspace);
  const planSetId = tree.plan_set_id;
  const specDirectory = `docs/specs/${planSetId}`;
  const specPath = (file) => execFileSync(process.execPath, [join(workspace, '.codex/scripts/harness-spec-path.mjs'), workspace, file], { cwd: workspace, encoding: 'utf8' }).trim();

  // The orchestrator's steps before the stage does its own work: prepare, start and bind.
  async function beginStage(stage, { extraArgs = [] } = {}) {
    const prepared = invoke(workspace, 'harness-prepare-input.mjs', ['--verbose', '--stage-id', stage, ...extraArgs]);
    assert.equal(prepared.input.skill, stage);
    assert.equal(prepared.input.scope, request);
    assert.equal(prepared.input.context.stage_id, stage);
    assert.equal(prepared.input.context.plan_set_id, stage.startsWith('tactical-') ? planSetId : undefined, 'only tactical implementation stages receive their canonical plan-set identity');
    const base = ['--root', workspace, '--worktree-ref', tree.worktree_ref, '--execution-id', prepared.input.execution_id];
    const started = invoke(workspace, 'harness-native-stage.mjs', ['start', ...base]);
    assert.equal(started.agent_profile, STAGE_PROFILES[stage] || (stage.startsWith('tactical-') ? 'tactical_designer' : 'workflow_stage'));
    assert.equal(started.guide, join(workspace, `.codex/internal-skills/${stage}/GUIDE.md`));
    assert.equal(started.binding.model_tier, STAGE_TIERS[stage]);
    assert.equal(started.binding.model, MODELS[STAGE_TIERS[stage]]);
    const schema = JSON.parse(await readFile(started.schema_path, 'utf8'));
    assert.ok(schema.properties.result.properties.questions, 'the stage can return its user questions');
    invoke(workspace, 'harness-native-stage.mjs', ['bind', ...base, '--agent-id', `${stage}-agent`]);
    return { stage, prepared, started, base };
  }

  // The stage writes its documents and its output file.
  async function submitStage({ stage, started }, { files = {}, status = 'completed', code = 'OK', summary = '완료', artifacts = [], questions = [], commit_request = null, resultExtra = {} }) {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(workspace, path, '..'), { recursive: true });
      await writeFile(join(workspace, path), content);
    }
    const result = { schema_version: 1, skill: stage, status, code, summary, artifacts: artifacts.map(({ path, kind }) => ({ base: 'workspace', path, kind, sha256: '0'.repeat(64) })), questions, review_request: null, owner_stage: null, dependency_gap: null, ...resultExtra, ...(commit_request ? { commit_request } : stage === 'tactical-code' ? { commit_request: null } : {}) };
    await writeFile(started.output_path, JSON.stringify({ schema_version: 1, skill: stage, status, code, result }));
  }

  // finish as the runner answers it, without asserting, for the tests that expect a rejection.
  const finishStage = ({ base }) => spawnSync(process.execPath, [join(workspace, '.codex/scripts/harness-native-stage.mjs'), 'finish', ...base], { cwd: workspace, encoding: 'utf8' });

  // One stage the way the orchestrator drives it: prepare, start, bind, the stage writes its documents, finish.
  async function runStage(stage, { files = {}, status = 'completed', code = 'OK', summary = '완료', artifacts = [], questions = [], extraArgs = [], expectCommit = true, commit_request = null, resultExtra = {} }) {
    const begun = await beginStage(stage, { extraArgs });
    const { prepared, started, base } = begun;
    await submitStage(begun, { files, status, code, summary, artifacts, questions, commit_request, resultExtra });
    const before = treeGit('rev-parse', 'HEAD').trim();
    const finished = invoke(workspace, 'harness-native-stage.mjs', ['finish', ...base]);
    assert.equal(finished.status, status);
    assert.equal(finished.code, code);
    const head = treeGit('rev-parse', 'HEAD').trim();
    if (expectCommit) {
      assert.notEqual(head, before, `${stage} committed its documents`);
      assert.equal(treeGit('log', '-1', '--format=%s').trim(), commit_request?.message || `${stage}: ${planSetId}`);
    } else assert.equal(head, before, `${stage} committed nothing`);
    return { prepared, started, finished, files: expectCommit ? treeGit('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort() : [] };
  }
  return { primary, workspace, tree, treeGit, invoke, runStage, beginStage, submitStage, finishStage, planSetId, specDirectory, specPath, request };
}
