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

test('intent questions resolve material scope choices instead of collecting a motive per rule', async () => {
  const guide = await read('.harness/internal-skills/product-spec/GUIDE.md');
  assert.match(guide, /first propose each feature's `목적` and `충분한 수준`/);
  assert.match(guide, /observable user flows and completion conditions linked to UC\/AC IDs/);
  assert.match(guide, /a missing reason alone does not require a question/);
  assert.match(guide, /never as the user's answer or approval/);
  assert.match(guide, /When asking, show the concrete result and implementation scope of each option/);
  assert.doesNotMatch(guide, /needs the user's reason before it becomes a requirement/);
  const topics = await read('.harness/internal-skills/product-spec/references/topics.md');
  assert.match(topics, /Restating the feature .* is not an intent/);
  assert.match(topics, /reference the existing feature intent and completion conditions/);
  assert.doesNotMatch(topics, /When the request does not state the reason, ask/);
  assert.match(await read('.harness/internal-skills/product-spec/references/template.md'), /에이전트 제안과 근거/);
});

test('every stage requires necessary work to meet completion conditions without adding optional questions', async () => {
  const product = await read('.harness/internal-skills/product-spec/GUIDE.md');
  assert.match(product, /explicitly required or indispensable/);
  assert.match(product, /Agent-proposed intents and completion conditions cannot authorize new product scope/);
  assert.match(product, /explain which condition would fail without it/);
  assert.match(product, /Preserve baseline security, authorization, data protection and ordinary error handling/);
  assert.match(product, /Omit optional improvements without turning them into interview questions/);
  assert.match(product, /Login alone does not require OAuth, email recovery infrastructure or a custom session-timeout policy/);
  for (const skill of ['implement', 'code-review']) {
    assert.match(await read(`.harness/internal-skills/${skill}/GUIDE.md`), /\(\.\.\/product-spec\/GUIDE\.md\)/, skill);
  }
  // The ticket stages no longer depend on a Spec: the same necessity rule rests on the requirements and the tactical design.
  for (const skill of ['to-ticket', 'plan-review']) {
    const guide = await read(`.harness/internal-skills/${skill}/GUIDE.md`);
    assert.doesNotMatch(guide, /product-spec\/GUIDE\.md|12\.7|13절/, skill);
    assert.doesNotMatch(guide.replace(/이전 릴리스의 Product·Architecture Spec[^\n]*\n/, '\n'), /Architecture Spec|Product Spec/, skill);
    assert.match(guide, /INV\/EX\/AC/, skill);
  }
  assert.match(await read('.harness/internal-skills/spec-review/references/review-criteria.md'), /누락 지적에도 같은 필요성 기준/);
});

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
    ...['product-spec', 'to-ticket', 'plan-review', 'implement', 'code-review']
      .map((skill) => `.harness/internal-skills/${skill}/GUIDE.md`),
    '.harness/internal-skills/product-spec/references/topics.md',
    '.harness/internal-skills/product-spec/references/template.md',
    '.harness/internal-skills/spec-review/references/review-criteria.md',
    '.harness/src/workflow/spec-review.mjs',
    '.harness/src/workflow/plan-review.mjs',
    '.harness/src/workflow/stage-runtime.mjs',
    '.harness/src/workflow/stage-checkpoint.mjs',
    '.harness/contracts.mjs',
    '.harness/scripts/harness-spec-review.mjs',
    '.harness/scripts/harness-native-stage.mjs',
    ...['.codex', '.claude'].flatMap((provider) => ['SKILL.md', 'references/coordination.md', 'references/dispatch.md', 'references/input.md', 'references/workflow-map.md']
      .map((path) => `${provider}/skills/orchestrator/${path}`)),
  ];
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  const { runDoctor } = await import(pathToFileURL(resolve(root, '.harness/src/doctor/doctor.mjs')));
  const spec = 'INT-A\n- 목적: 작성물 관리\n- 충분한 수준: 본인 작성물만 삭제한다(AC-1).\n- 출처: 요청 해석(에이전트 추정, request.md)\nBR-1: 글 삭제 시 모든 댓글도 삭제한다.\n- 의도: INT-A 참조\n- 충분한 수준: 삭제한 글의 댓글은 조회되지 않는다(AC-1).\n- 출처: request.md\n';
  for (const phase of ['fresh', 'updated']) {
    const lock = JSON.parse(await readFile(resolve(root, '.harness/harness-lock.json'), 'utf8'));
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
    const { assertPlanIssueDrafts } = await import(`${pathToFileURL(resolve(root, '.harness/src/workflow/plan-review.mjs'))}?${phase}`);
    const configPath = resolve(root, '.harness/harness.yaml');
    const originalConfig = await readFile(configPath, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    await writeFile(configPath, 'tracker:\n  mode: github\n');
    const planInput = { root, plans: [{ id: 'calc' }] };
    await assert.rejects(assertPlanIssueDrafts(planInput), /parent.md.*calc.md/);
    const drafts = resolve(root, '.io/runtime/to-ticket/drafts');
    await mkdir(drafts, { recursive: true });
    await writeFile(resolve(drafts, 'parent.md'), 'Parent issue\n');
    await writeFile(resolve(drafts, 'calc.md'), ' \n');
    await assert.rejects(assertPlanIssueDrafts(planInput), /calc.md/);
    await writeFile(resolve(drafts, 'calc.md'), 'Calculation issue\n');
    await assertPlanIssueDrafts(planInput);
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
    await writeFile(resolve(root, '.harness/harness-lock.json'), JSON.stringify(lock));
    const stale = (await runDoctor({ root, sourceRoot })).diagnostics;
    for (const path of managedPaths) assert.ok(stale.some((item) => item.code === 'installer_upstream_updated' && item.path === resolve(root, path)), path);
    const update = await updateProject({ sourceRoot, targetRoot: root });
    assert.ok(managedPaths.every((path) => update.updated.includes(path)));
    await protectLocalInstallArtifacts(root, sourceRoot);
  }
});

test('the Spec review looks for excess as well as gaps', async () => {
  assert.match(await read('.harness/internal-skills/spec-review/references/review-criteria.md'), /과한 설계: .*근거하지 않은 결정·규칙·구성요소/);
  assert.match(await read('.harness/internal-skills/spec-review/GUIDE.md'), /충분한 수준을 넘는 과한 설계를 확인한다/);
});

test('implementation review findings are limited to Spec, repository standards and unbacked additions, with DDD standards as a basis', async () => {
  const guide = await read('.harness/internal-skills/code-review/GUIDE.md');
  assert.match(guide, /지적은 세 가지뿐이다/);
  assert.match(guide, /그 밖의 구조 제안이나 더 나은 설계 의견은 지적하지 않는다/);
  assert.match(guide, /`intent_ref`는 Product Spec의 INT·BR ID나 BASELINE ID만 쓴다/);
  assert.match(await read('.harness/src/wrapper/repair.mjs'), /"\.harness\/internal-skills\/ddd-design\/",/);
});

test('the final E2E conditions are prepared once after all plans, derived by the agent, not asked during a plan', async () => {
  assert.match(await read('.harness/internal-skills/implement-wrapper/GUIDE.md'), /plan 구현 중에는 최종 E2E의 실행 조건이나 환경을 사용자에게 묻거나 정하지 않는다/);
  assert.match(await read('.harness/internal-skills/implement/GUIDE.md'), /plan 구현 단계에서는 최종 E2E 조건을 사용자에게 묻지 않는다/);
  assert.match(await read('.codex/skills/orchestrator/references/implementation.md'), /시나리오는 Spec에서 확정됐으므로 다시 작성하거나 실행 조건을 묻지 않는다/);
});

test('the final E2E is specified in the Product Spec template and run once after approval; tickets never carry an E2E', async () => {
  assert.match(await read('.harness/internal-skills/product-spec/references/template.md'), /13\. \*\*End-user Scenarios\*\*/);
  assert.match(await read('.harness/internal-skills/product-spec/references/topics.md'), /13\. \*\*End-user Scenarios\*\*/);
  assert.match(await read('.harness/internal-skills/spec-review/references/review-criteria.md'), /시나리오를 위해 추가된 요구에 사용자 답변 출처가 있는지/);
  assert.match(await read('.harness/internal-skills/product-spec/references/topics.md'), /do not add the requirement yourself: ask the user/);
  assert.match(await read('.harness/internal-skills/to-ticket/references/split.md'), /E2E ticket은 만들지 않는다/);
  assert.match(await read('.harness/internal-skills/plan-review/GUIDE.md'), /ticket에 E2E를 배정하지 않는다/);
  const orchestration = await read('.codex/skills/orchestrator/references/implementation.md');
  assert.match(orchestration, /마지막 `e2e` plan을 다른 plan과 같은 방식/);
  assert.match(orchestration, /사용자에게 실행 승인만 묻는다/);
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
    await writeOutputSchema({ root, input: { execution_id: 'implement-wrapper-1', skill: 'implement-wrapper' }, prefix: '', path });
    const schema = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(!schema.properties.code.enum.includes('USER_DECISION_REQUIRED'));
    assert.ok(!schema.properties.result.properties.code.enum.includes('USER_DECISION_REQUIRED'));
    assert.equal(schema.properties.result.properties.questions.maxItems, 0);
    const other = join(dir, 'requirements-fix.json');
    await writeOutputSchema({ root, input: { execution_id: 'requirements-fix-1', skill: 'requirements-fix' }, prefix: '', path: other });
    assert.ok(JSON.parse(await readFile(other, 'utf8')).properties.code.enum.includes('USER_DECISION_REQUIRED'), 'requirements-fix still asks');
  } finally { await rm(dir, { recursive: true, force: true }); }
  assert.match(await read('.harness/src/workflow/stage-runtime.mjs'), /Implementation does not ask the user/);
  assert.match(await read('.harness/internal-skills/implement-wrapper/GUIDE.md'), /사용자에게 질문하지 않는다/);
});

test('infrastructure checks belong to a separately requested E2E, not to each ticket', async () => {
  assert.match(await read('.harness/internal-skills/to-ticket/references/split.md'), /그 ticket의 작업 환경에서 바로 실행할 수 있는 것만 적는다/);
  assert.match(await read('.harness/internal-skills/code-review/GUIDE.md'), /report `verification_gap` only for a check the plan's own environment can run/);
  assert.match(await read('.harness/internal-skills/plan-review/GUIDE.md'), /ticket에서 빼고 사용자가 요청하는 별도 E2E로 넘기라고 지적한다/);
});

test('the implementer builds to the same layer criteria the reviewer judges with', async () => {
  const implement = await read('.harness/internal-skills/implement/GUIDE.md');
  assert.match(implement, /코드를 쓰기 전에 반드시: \[model continuity contract\]/);
  assert.match(implement, /리뷰어도 같은 기준으로 판정한다/);
  assert.match(implement, /plan 내용은 Issue 본문이 아니라 plan-review `check`가 돌려준 canonical plan 파일에서 읽는다/);
  assert.match(await read('.harness/internal-skills/to-ticket/references/split.md'), /domain → application → `api\.md`가 정한 entry → `data\.md`가 정한 저장까지 수직으로 구현하며/);
  assert.match(await read('.harness/internal-skills/plan-review/GUIDE.md'), /domain → application → API → 저장까지 수직이어야 한다/);
  assert.match(await read('.codex/skills/orchestrator/references/implementation.md'), /리뷰어가 인용한 근거\(`basis`의 source·path·quote\)를 그대로 넣어/);
});
