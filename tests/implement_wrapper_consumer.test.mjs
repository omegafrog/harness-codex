import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { updateProject } from '../.harness/src/installer/update.mjs';
import { protectLocalInstallArtifacts } from '../.harness/src/installer/local-exclude.mjs';
import { runDoctor } from '../.harness/src/doctor/doctor.mjs';

test('existing implement-wrapper distributes sequential review and E2E approval through install and update', async () => {
  const sourceRoot = resolve('.');
  await mkdir('.io/runtime', { recursive: true });
  const root = await mkdtemp(resolve('.io/runtime/implement-consumer-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q');
  await protectLocalInstallArtifacts(root, sourceRoot);
  await updateProject({ sourceRoot, targetRoot: root, initialize: true });
  const read = (path) => readFile(resolve(root, path), 'utf8');
  const checkGuidance = async () => {
    for (const provider of ['.agents', '.claude']) {
      const entry = await read(`${provider}/skills/orchestrator/SKILL.md`);
      assert.match(entry, /references\/implementation\.md/);
      const path = `${provider}/skills/orchestrator/references/implementation.md`;
      const guide = await read(path);
      assert.match(guide, /한 번에 split plan 하나만 배정/);
      assert.match(guide, /전체 누적 diff/);
      assert.match(guide, /실제 답변 참조/);
      assert.match(guide, /자동 수정하지 않고 재실행하지 않는다/);
      // Follow the installed links, including transformed native skill paths.
      for (const match of guide.matchAll(/\]\(([^)]+\.md)\)/g)) {
        await readFile(resolve(root, dirname(path), match[1]));
      }
    }
    const wrapper = await read('.codex/internal-skills/implement-wrapper/GUIDE.md');
    assert.match(wrapper, /구현할 plan ID로 plan-set draft 활성화를 시작한다/);
    assert.match(wrapper, /최종 E2E 시나리오에 대한 실제 사용자 승인/);
    assert.match(wrapper, /미결 사항·영향 요구·기존 구현 및 리뷰 근거를 보존해 `action_required\/SPEC_REVISION_REQUIRED`로 orchestrator에 반환/);
    assert.match(await read('.codex/internal-skills/implement/GUIDE.md'), /구현 단계에서 직접 사용자에게 결정 질문을 하거나 임의로 정하지 않는다/);
    const provider = await import(`file://${resolve(root, '.harness/src/workflow/providers/codex.mjs')}`);
    const harnessConfig = await read('.codex/harness.yaml').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    await writeFile(resolve(root, '.codex/harness.yaml'), 'tracker:\n  mode: github\n');
    const args = await provider.buildCommand({ root, sandbox: 'workspace-write', resumeWriteDirs: [], binding: { model: 'example', reasoning_effort: 'medium' }, schemaPath: '/tmp/schema', output: '/tmp/output', skill: 'implement-wrapper' });
    assert.ok(args.includes('sandbox_workspace_write.network_access=true'));
    const claude = await import(`file://${resolve(root, '.harness/src/workflow/providers/claude-code.mjs')}`);
    const claudeArgs = claude.buildCommand({ root, sandbox: 'workspace-write', binding: { model: 'example', reasoning_effort: 'medium' }, schema: {}, skill: 'implement-wrapper' });
    assert.deepEqual(JSON.parse(claudeArgs[claudeArgs.indexOf('--settings') + 1]).sandbox.network.allowedDomains, ['api.github.com', 'github.com']);
    const otherArgs = await provider.buildCommand({ root, sandbox: 'workspace-write', resumeWriteDirs: [], binding: { model: 'example', reasoning_effort: 'medium' }, schemaPath: '/tmp/schema', output: '/tmp/output', skill: 'to-ticket' });
    assert.ok(!otherArgs.includes('sandbox_workspace_write.network_access=true'));
    await writeFile(resolve(root, '.codex/harness.yaml'), 'tracker:\n  mode: local-markdown\n');
    const localArgs = await provider.buildCommand({ root, sandbox: 'workspace-write', resumeWriteDirs: [], binding: { model: 'example', reasoning_effort: 'medium' }, schemaPath: '/tmp/schema', output: '/tmp/output', skill: 'implement-wrapper' });
    assert.ok(!localArgs.includes('sandbox_workspace_write.network_access=true'));
    const localClaude = claude.buildCommand({ root, sandbox: 'workspace-write', binding: { model: 'example', reasoning_effort: 'medium' }, schema: {}, skill: 'implement-wrapper' });
    assert.equal(JSON.parse(localClaude[localClaude.indexOf('--settings') + 1]).sandbox.network, undefined);
    if (harnessConfig === null) await unlink(resolve(root, '.codex/harness.yaml'));
    else await writeFile(resolve(root, '.codex/harness.yaml'), harnessConfig);
    for (const match of wrapper.matchAll(/\]\(([^)]+\.md)\)/g)) {
      await readFile(resolve(root, '.codex/internal-skills/implement-wrapper', match[1]));
    }
    assert.match(await read('.codex/internal-skills/implement-wrapper/references/tracker/local-markdown.md'), /GitHub Issue\/Project 조회나 갱신을 하지 않는다/);
    assert.match(await read('.codex/internal-skills/code-review/GUIDE.md'), /missing or stale Product\/Architecture Specs block completion/);
    assert.match(await read('.codex/internal-skills/e2e-test/GUIDE.md'), /누락되거나 달라졌으면 서버\/인프라를 시작하지 않고/);
    for (const path of ['.codex/agents/e2e_test_runner.toml', '.claude/agents/e2e_test_runner.md']) {
      const runner = await read(path);
      assert.match(runner, /actual user approval reference before starting services/);
      assert.match(runner, /neither caller nor runner may automatically fix/);
      assert.match(runner, /internal-skills\/e2e-test\/GUIDE\.md/);
      assert.doesNotMatch(runner, /skills\/e2e-test\/SKILL\.md/);
    }
    const doctor = await runDoctor({ root, sourceRoot });
    assert.equal(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing'), false);
  };
  await checkGuidance();
  const owned = {
    'docs/agents/EXEC.md': 'project launch instructions',
    'docs/agents/execution.json': '{"profiles":{}}',
    'docs/contracts/product.md': 'project contract',
    'app.js': 'project application change',
  };
  for (const [path, content] of Object.entries(owned)) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), content);
  }
  // Model a prior managed release, so update must replace its guidance without force.
  const stalePaths = [
    '.codex/internal-skills/implement-wrapper/GUIDE.md',
    '.agents/skills/orchestrator/references/implementation.md',
    '.claude/skills/orchestrator/references/implementation.md',
    '.codex/agents/e2e_test_runner.toml',
  ];
  const lock = JSON.parse(await read('.codex/harness-lock.json'));
  for (const path of stalePaths) {
    const content = 'previous managed release';
    await writeFile(resolve(root, path), content);
    lock.files[path].installed_sha256 = createHash('sha256').update(content).digest('hex');
    lock.files[path].upstream_sha256 = lock.files[path].installed_sha256;
  }
  await writeFile(resolve(root, '.codex/harness-lock.json'), JSON.stringify(lock));
  const updated = await updateProject({ sourceRoot, targetRoot: root });
  for (const path of stalePaths) {
    assert.ok(updated.updated.includes(path));
    if (path.includes('/skills/') || path.includes('/internal-skills/')) {
      assert.equal(await readFile(resolve(updated.backup_directory, path), 'utf8'), 'previous managed release');
    }
  }
  await checkGuidance();
  const status = git('status', '--short', '--untracked-files=all');
  for (const [path, content] of Object.entries(owned)) {
    assert.ok(status.includes(path), path);
    assert.equal(await read(path), content);
  }
  for (const path of stalePaths) {
    assert.ok(!status.includes(path));
    assert.ok(git('check-ignore', '-v', path).includes(path));
  }
  const missing = '.codex/internal-skills/e2e-test/references/verification-policy.md';
  await unlink(resolve(root, missing));
  const doctor = await runDoctor({ root, sourceRoot });
  assert.ok(doctor.diagnostics.some((item) => item.code === 'execution_asset_missing' && item.path === resolve(root, missing)));
});
