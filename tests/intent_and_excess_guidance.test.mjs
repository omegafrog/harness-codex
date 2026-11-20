import { internalSkillAssetPath } from '../.harness/src/workflow/skill-declaration.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sessionDirectory } from '../.harness/src/workflow/session-output.mjs';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { transformSourceContent } from '../.harness/src/installer/transforms.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('fresh and updated consumers receive scope guidance and the gate while project changes stay visible', async () => {
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const parent = resolve(sessionDirectory(sourceRoot), 'runtime/intent-scope-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(`${parent}/consumer-`);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  await writeFile(resolve(root, 'app.txt'), 'original application\n');
  git('add', 'app.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
  await writeFile(resolve(root, 'app.txt'), 'ongoing application change\n');
  const projectFiles = {
    '.harness/agents/EXEC.md': 'project execution instructions\n',
    '.harness/agents/execution.json': '{"profiles":{}}\n',
    '.harness/agents/implementation-guidance.md': 'project implementation preferences\n',
    '.harness/agents/testing-guidance.md': 'project testing preferences\n',
    'docs/contracts/product.md': 'project product contract\n',
  };
  for (const [path, content] of Object.entries(projectFiles)) {
    await mkdir(resolve(root, path, '..'), { recursive: true });
    await writeFile(resolve(root, path), content);
  }
  const managedPaths = [
    ...['requirements-fix', 'to-ticket', 'plan-review', 'tactical-code', 'code-review']
      .map((skill) => internalSkillAssetPath(skill)),
    '.harness/skills/quality/spec-review/references/review-criteria.md',
    '.harness/src/workflow/spec-review.mjs',
    '.harness/src/workflow/plan-review.mjs',
    '.harness/src/workflow/skill-execution.mjs',
    '.harness/src/workflow/stage-checkpoint.mjs',
    '.harness/scripts/harness-spec-review.mjs',
    '.harness/scripts/harness-native-stage.mjs',
    ...['.agents', '.claude'].flatMap((provider) => ['SKILL.md', 'references/coordination.md', 'references/dispatch.md', 'references/input.md', 'references/workflow-map.md']
      .map((path) => `${provider}/skills/orchestrator/${path}`)),
  ];
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  const { runDoctor } = await import(pathToFileURL(resolve(root, '.harness/src/doctor/doctor.mjs')));
  const spec = 'INT-A\n- 목적: 작성물 관리\n- 충분한 수준: 본인 작성물만 삭제한다(AC-1).\n- 출처: 요청 해석(에이전트 추정, request.md)\nBR-1: 글 삭제 시 모든 댓글도 삭제한다.\n- 의도: INT-A 참조\n- 충분한 수준: 삭제한 글의 댓글은 조회되지 않는다(AC-1).\n- 출처: request.md\n';
  for (const phase of ['fresh', 'updated']) {
    const lock = JSON.parse(await readFile(resolve(root, '.codex/harness-lock.json'), 'utf8'));
    for (const path of managedPaths) {
      assert.ok(lock.files[path], `${phase} inventory: ${path}`);
      const expected = transformSourceContent(await readFile(resolve(sourceRoot, lock.files[path].source_path || path), 'utf8'), lock.files[path].source_transform);
      assert.equal(await readFile(resolve(root, path), 'utf8'), expected, `${phase}: ${path}`);
      assert.match(git('check-ignore', '-v', path), /info\/exclude/);
    }
    const { intentIssues } = await import(`${pathToFileURL(resolve(root, '.harness/src/workflow/spec-review.mjs'))}?${phase}`);
    assert.deepEqual(intentIssues(spec), []);
    assert.match(intentIssues(spec.replace('- 의도: INT-A 참조\n', ''))[0], /BR-1/);
    const inline = '- **INT-A** — 목적(에이전트 제안): 작성물 관리. 충분한 수준: 본인 글을 삭제한다(AC-1). 출처: 요청 해석(request.md)\n';
    assert.deepEqual(intentIssues(inline), []);
    assert.match(intentIssues(inline.replace('출처:', '근거:'))[0], /INT-A/);
    const specDirectory = resolve(root, 'docs/specs/efficiency');
    await mkdir(specDirectory, { recursive: true });
    await writeFile(resolve(specDirectory, 'architecture-spec.md'), '# Architecture\n');
    await writeFile(resolve(specDirectory, 'product-spec.md'), inline.replace('출처:', '근거:'));
    const rejected = spawnSync(process.execPath, [resolve(root, '.harness/scripts/harness-spec-review.mjs'), 'begin', '--root', root, '--ticket', 'efficiency', '--axis', 'architecture'], { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Product Spec intent is incomplete/, 'invalid input must fail before admitting a reviewer');
    await writeFile(resolve(specDirectory, 'product-spec.md'), inline);
    const { assertSpecReadyForReview } = await import(`${pathToFileURL(resolve(root, '.harness/src/workflow/spec-review.mjs'))}?ready-${phase}`);
    await assertSpecReadyForReview({ root, ticketId: 'efficiency' });
    const { inspectPlanSet } = await import(`${pathToFileURL(resolve(root, '.harness/src/workflow/plan-review.mjs'))}?${phase}`);
    const configPath = resolve(root, '.harness/harness.yaml');
    const originalConfig = await readFile(configPath, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    await writeFile(configPath, 'tracker:\n  mode: github\n');
    const planDirectory = resolve(root, 'docs/plans/efficiency');
    await mkdir(planDirectory, { recursive: true });
    await writeFile(resolve(planDirectory, 'plans.md'), '# Efficiency\n');
    await writeFile(resolve(planDirectory, 'calc.md'), '---\nstatus: planned\n---\n# Calculate\n');
    const planInput = { root, planSetId: 'efficiency', phase: 'planning' };
    assert.match((await inspectPlanSet(planInput)).reason, /missing or empty: .*parent\.md.*calc\.md/);
    const drafts = resolve(root, '.io/runtime/to-ticket/drafts');
    await mkdir(drafts, { recursive: true });
    await writeFile(resolve(drafts, 'parent.md'), 'Parent issue\n');
    await writeFile(resolve(drafts, 'calc.md'), ' \n');
    assert.match((await inspectPlanSet(planInput)).reason, /missing or empty: \.io\/runtime\/to-ticket\/drafts\/calc\.md$/);
    await writeFile(resolve(drafts, 'calc.md'), 'Calculation issue\n');
    assert.match((await inspectPlanSet(planInput)).reason, /requires the canonical execution workspace/);
    await writeFile(resolve(drafts, 'parent.md'), '');
    await writeFile(resolve(drafts, 'calc.md'), '');
    if (originalConfig === null) await unlink(configPath);
    else await writeFile(configPath, originalConfig);
    for (const [path, content] of Object.entries(projectFiles)) {
      assert.equal(await readFile(resolve(root, path), 'utf8'), content);
      assert.equal(execFileSync('git', ['-C', root, 'status', '--short', '--', path], { encoding: 'utf8' }).startsWith('??'), true, path);
    }
    assert.equal(await readFile(resolve(root, 'app.txt'), 'utf8'), 'ongoing application change\n');
    const status = git('status', '--short', '--untracked-files=all');
    assert.match(status, / M app\.txt/);
    assert.ok(managedPaths.every((path) => !status.includes(path)), status);
    assert.doesNotMatch(status, /(?:^|\n).. \.io\//);
    assert.match(git('check-ignore', '-v', '.io/runtime/to-ticket/drafts/parent.md'), /info\/exclude/);
    const diagnostics = (await runDoctor({ root, sourceRoot })).diagnostics;
    assert.deepEqual(diagnostics.filter((item) => item.code.startsWith('installer_') && managedPaths.some((path) => item.path === resolve(root, path))), []);
    if (phase === 'updated') break;
    for (const path of managedPaths) {
      const previous = `${await readFile(resolve(root, path), 'utf8')}\n// previous release\n`;
      await writeFile(resolve(root, path), previous);
      const hash = createHash('sha256').update(previous).digest('hex');
      lock.files[path].installed_sha256 = hash;
      lock.files[path].upstream_sha256 = hash;
    }
    await writeFile(resolve(root, '.codex/harness-lock.json'), JSON.stringify(lock));
    const stale = (await runDoctor({ root, sourceRoot })).diagnostics;
    for (const path of managedPaths) assert.ok(stale.some((item) => item.code === 'installer_upstream_updated' && item.path === resolve(root, path)), path);
    const update = await updateProject({ sourceRoot, targetRoot: root });
    assert.ok(managedPaths.every((path) => update.updated.includes(path)));
    await protectLocalInstallArtifacts(root, sourceRoot);
  }
});

test('the Spec review looks for excess as well as gaps', async () => {
  assert.match(await read('.harness/skills/quality/spec-review/references/review-criteria.md'), /과한 설계: .*근거하지 않은 결정·규칙·구성요소/);
  assert.match(await read('.harness/skills/quality/spec-review/GUIDE.md'), /충분한 수준을 넘는 과한 설계를 확인한다/);
});

test('implementation review findings are limited to Spec, repository standards and unbacked additions, with DDD standards as a basis', async () => {
  const guide = await read('.harness/skills/quality/code-review/GUIDE.md');
  assert.match(guide, /지적은 세 가지뿐이다/);
  assert.match(guide, /그 밖의 구조 제안이나 더 나은 설계 의견은 지적하지 않는다/);
  assert.match(guide, /`intent_ref`는 현재 요구사항의 `BIZ`·`INV`·`EX`·`AC`·`HS` 또는 전술 설계의 `AS`·`CON` ID를 쓴다/);
  assert.match(await read('.harness/src/wrapper/repair.mjs'), /"\.harness\/skills\/requirements\/bounded-context\/",/);
});

test('the final E2E conditions are prepared once after all plans, derived by the agent, not asked during a plan', async () => {
  assert.match(await read('.harness/skills/delivery/tactical-code/GUIDE.md'), /필요한 결정이 빠졌으면/);
});

test('the final E2E is specified in requirements and run once after approval; tickets never carry an E2E', async () => {
  assert.match(await read('.harness/skills/requirements/requirements-fix/references/template.md'), /### 6\.4 E2E 시나리오/);
  assert.match(await read('.harness/skills/quality/spec-review/references/review-criteria.md'), /시나리오를 위해 추가된 요구에 사용자 답변 출처가 있는지/);
  assert.match(await read('.harness/skills/planning/to-ticket/references/split.md'), /E2E ticket은 만들지 않는다/);
  assert.match(await read('.harness/skills/planning/plan-review/GUIDE.md'), /ticket에 E2E를 배정하지 않는다/);
  const orchestration = await read('.agents/skills/orchestrator/references/implementation.md');
  assert.match(orchestration, /한 실행은 ticket 하나만 구현한다/);
  assert.match(orchestration, /명시적으로 요청된 경우/);
  assert.doesNotMatch(orchestration, /에이전트가 승인 Product\/Architecture Specs와 parent test contract를 읽고/);
});

test('implementation never asks the user: the output schema and the result validator refuse questions', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeOutputSchema } = await import('../.harness/src/workflow/output-schema.mjs');
  const root = new URL('../', import.meta.url).pathname;
  const dir = await mkdtemp(join(tmpdir(), 'impl-schema-'));
  try {
    const path = join(dir, 'schema.json');
    await writeOutputSchema({ root, input: { execution_id: 'tactical-code-1', skill: 'tactical-code' }, prefix: '', path });
    const schema = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(!schema.properties.code.enum.includes('USER_DECISION_REQUIRED'));
    assert.ok(!schema.properties.result.properties.code.enum.includes('USER_DECISION_REQUIRED'));
    assert.equal(schema.properties.result.properties.questions.maxItems, 0);
    const other = join(dir, 'requirements-fix.json');
    await writeOutputSchema({ root, input: { execution_id: 'requirements-fix-1', skill: 'requirements-fix' }, prefix: '', path: other });
    assert.ok(JSON.parse(await readFile(other, 'utf8')).properties.code.enum.includes('USER_DECISION_REQUIRED'), 'requirements-fix still asks');
  } finally { await rm(dir, { recursive: true, force: true }); }
  assert.match(await read('.harness/src/workflow/skill-execution.mjs'), /Implementation does not ask the user/);
  assert.match(await read('.harness/skills/delivery/tactical-code/GUIDE.md'), /사용자에게 직접 질문하거나 추정해 확정하지 않는다/);
});

test('infrastructure checks belong to a separately requested E2E, not to each ticket', async () => {
  assert.match(await read('.harness/skills/planning/to-ticket/references/split.md'), /그 ticket의 작업 환경에서 바로 실행할 수 있는 것만 적는다/);
  assert.match(await read('.harness/skills/quality/code-review/GUIDE.md'), /report `verification_gap` only for a check the plan's own environment can run/);
  assert.match(await read('.harness/skills/planning/plan-review/GUIDE.md'), /ticket에서 빼고 사용자가 요청하는 별도 E2E로 넘기라고 지적한다/);
});

test('the implementer builds to the same layer criteria the reviewer judges with', async () => {
  const implementation = await read('.harness/skills/delivery/tactical-code/GUIDE.md');
  assert.match(implementation, /Ponytail 구현 원칙/);
});
