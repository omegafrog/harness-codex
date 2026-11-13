import './support/trusted-codex-home.mjs';
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
      assert.match(guide, /사용자가 허용한 조치만 수행하며 수정 승인과 재실행 승인을 구분한다/);
      assert.doesNotMatch(guide, /시도 budget|기존 재시도 budget/);
      // Follow the installed links, including transformed native skill paths.
      for (const match of guide.matchAll(/\]\(([^)]+\.md)\)/g)) {
        await readFile(resolve(root, dirname(path), match[1]));
      }
    }
    const wrapper = await read('.codex/internal-skills/implement-wrapper/GUIDE.md');
    assert.match(wrapper, /tracker-publish가 만든 Issue와 Beads mirror를 확인한다/);
    assert.match(wrapper, /최종 E2E 시나리오에 대한 실제 사용자 승인/);
    assert.match(wrapper, /미결 사항·영향 요구·기존 구현 및 리뷰 근거를 보존해 `action_required\/SPEC_REVISION_REQUIRED`로 orchestrator에 반환/);
    const implementGuide = await read('.codex/internal-skills/implement/GUIDE.md');
    assert.match(implementGuide, /구현 단계에서 직접 사용자에게 결정 질문을 하거나 임의로 정하지 않는다/);
    // Review must come from fresh reviewer stages, never the implementer itself.
    assert.match(implementGuide, /`action_required\/REVIEW_REQUIRED`로 반환/);
    assert.match(implementGuide, /구현자는 자기 diff를 리뷰하거나 reviewer를 직접 호출하지 않는다/);
    assert.doesNotMatch(implementGuide, /`code-review`를 `review_fixed_point`에 대해 실행/);
    assert.match(await read('.agents/skills/orchestrator/references/implementation.md'), /구현 context를 공유하지 않는 fresh `standards_reviewer`·`spec_reviewer`/);
    const dispatch = await read('.codex/internal-skills/skill-execution/references/dispatch.md');
    assert.match(dispatch, /sandbox 및 권한을 유지한다/);
    assert.match(dispatch, /지정된 권한을 적용할 수 없으면 실행하지 말고 실패/);
    assert.match(dispatch, /실제 서브에이전트의 종료를 native 도구로 기다린다/);
    for (const match of wrapper.matchAll(/\]\(([^)]+\.md)\)/g)) {
      await readFile(resolve(root, '.codex/internal-skills/implement-wrapper', match[1]));
    }
    assert.match(await read('.codex/internal-skills/implement-wrapper/references/tracker/local-markdown.md'), /GitHub Issue\/Project 조회나 갱신을 하지 않는다/);
    assert.match(await read('.codex/internal-skills/code-review/GUIDE.md'), /missing or stale Product\/Architecture Specs block completion/);
    assert.match(await read('.codex/internal-skills/review-coordination/GUIDE.md'), /record-basis-result/);
    assert.match(await read('.codex/internal-skills/code-review/references/repair.md'), /basis_unverified/);
    const installedBasis = await import(`file://${resolve(root, '.harness/src/wrapper/basis-recheck.mjs')}?scope=${Date.now()}`);
    assert.equal(typeof installedBasis.prepareBasisRecheck, 'function');
    assert.equal(typeof installedBasis.recordBasisRecheck, 'function');
    assert.match(await read('.codex/scripts/harness-code-review.mjs'), /record-basis-result/);
    assert.match(await read('.codex/internal-skills/e2e-test/GUIDE.md'), /누락되거나 달라졌으면 서버\/인프라를 시작하지 않고/);
    for (const path of ['.codex/agents/e2e_test_runner.toml', '.claude/agents/e2e_test_runner.md']) {
      const runner = await read(path);
      assert.match(runner, /internal-skills\/e2e-test\/GUIDE\.md/);
      assert.doesNotMatch(runner, /skills\/e2e-test\/SKILL\.md/);
      assert.doesNotMatch(runner, /at most two total attempts/i);
    }
    // The runner profile points at the GUIDE, which owns approval, no-auto-fix and rerun rules.
    const e2eGuide = await read('.codex/internal-skills/e2e-test/GUIDE.md');
    // Final E2E always runs in a fresh runner, and dispatch checks call real CLIs.
    assert.match(e2eGuide, /fresh native 서브에이전트/);
    assert.match(await read('.claude/skills/orchestrator/references/implementation.md'), /--stage-id e2e-test --e2e-request/);
    assert.match(await read('.codex/internal-skills/implement-wrapper/GUIDE.md'), /harness-plan-review\.mjs check --root <workspace_root> --plan-set <plan-set-id> --phase dispatch --plan <plan-id>/);
    assert.match(await read('.codex/internal-skills/implement/GUIDE.md'), /harness-workspace-preflight\.mjs --workspace-root <workspace_root> --for-implementation --json/);
    assert.match(await read('.claude/skills/orchestrator/SKILL.md'), /--worktree-id <worktree\.json의 worktree_id> --base-ref <시작 commit SHA> --final-workflow/);
    assert.match(e2eGuide, /실제 답변 참조를 확인하고, 누락되거나 달라졌으면 서버\/인프라를 시작하지 않고/);
    assert.match(e2eGuide, /caller도 코드·테스트·profile을 자동 수정하거나 자동 재실행하지 않고/);
    assert.match(await read('.codex/internal-skills/e2e-test/references/failure-learning.md'), /사용자가 재실행을 지시하면 시도 횟수와 관계없이 따른다/);
    const verificationPolicy = await read('.codex/internal-skills/e2e-test/references/verification-policy.md');
    assert.match(verificationPolicy, /사용자가 재실행을 지시한 경우 횟수만을 이유로 거부하지 않는다/);
    assert.doesNotMatch(verificationPolicy, /시나리오별 시도 budget은 최초 1회/);
    assert.match(await read('.codex/internal-skills/e2e-test/references/failure-learning.md'), /사용자가 재실행을 지시하면 시도 횟수와 관계없이 따른다/);
    assert.doesNotMatch(await read('.codex/internal-skills/to-ticket/references/execution-evidence.md'), /총 시도 budget/);
    assert.doesNotMatch(await read('.codex/internal-skills/to-ticket/references/github-issue-template.md'), /총 시도 budget/);
    assert.doesNotMatch(await read('.codex/internal-skills/to-ticket/references/split.md'), /총 시도 budget/);
    // Scope control must reach installed runtimes and every provider's agent profile.
    const repair = await import(`file://${resolve(root, '.harness/src/wrapper/repair.mjs')}?scope=${Date.now()}`);
    const blocked = repair.planRepairRound({ reviews: [{ role: 'standards', state: 'failed', report: { findings: [{ id: 'SPEC-4', kind: 'implementation_defect', severity: 'major', summary: 'NFC', evidence: 'domain.ts:29' }] } }] });
    assert.equal(blocked.reason, 'unbacked_requirement');
    assert.equal(blocked.next_action, 'user-decision');
    assert.match(await read('.codex/scripts/harness-code-review.mjs'), /scope_decisions/);
    // Profiles point at the GUIDE that owns the rule; the GUIDEs carry the result fields.
    for (const path of ['.codex/agents/implementation_agent.toml', '.claude/agents/implementation_agent.md']) assert.match(await read(path), /internal-skills\/implement\/GUIDE\.md/);
    assert.match(await read('.codex/internal-skills/implement/GUIDE.md'), /unplanned_additions/);
    for (const agent of ['standards_reviewer', 'spec_reviewer']) {
      for (const path of [`.codex/agents/${agent}.toml`, `.claude/agents/${agent}.md`]) assert.match(await read(path), /internal-skills\/code-review\/GUIDE\.md/);
    }
    assert.match(await read('.codex/internal-skills/code-review/GUIDE.md'), /unrequested_behavior/);
    assert.match(await read('.codex/internal-skills/code-review/references/repair.md'), /next_action: user-decision/);
    assert.ok(JSON.parse(await read('.codex/internal-skills/skill-execution/schemas/flows/common.schema.json')).properties.unplanned_additions);
    assert.match(await read('.claude/skills/orchestrator/references/implementation.md'), /user_questions\[\]\.question/);
    assert.match(await read('.claude/agents/spec_reviewer.md'), /exactly one JSON object/);
    assert.match(await read('.codex/internal-skills/product-spec/references/template.md'), /- 충분한 수준:/);
    assert.match(await read('.codex/internal-skills/spec-review/references/review-criteria.md'), /근거 없는 엄밀함/);
    const specReview = await import(`file://${resolve(root, '.harness/src/workflow/spec-review.mjs')}?scope=${Date.now()}`);
    assert.deepEqual(specReview.intentIssues('INT-A\n- 목적: x\n- 충분한 수준: y\n- 출처: 사용자 답변\n- BR-1: 최대 10자다.').length, 1);
    await readFile(resolve(root, '.harness/src/workflow/stage-commit.mjs'));
    await readFile(resolve(root, '.codex/internal-skills/code-review/references/baseline.md'));
    assert.match(await read('.codex/internal-skills/implement/GUIDE.md'), /commit_request/);
    assert.deepEqual(specReview.decisionsWithoutDelegation('| PD-1 | x | 사용자가 위임 |'), ['PD-1']);
    assert.match(await read('.codex/scripts/harness-prepare-input.mjs'), /user-revision/);
    assert.match(await read('.harness/src/workflow/skill-execution.mjs'), /reopening/);
    assert.match(await read('.harness/src/workflow/stage-input.mjs'), /reopening: Boolean\(userRevisionWaiting \|\| \(crossStageRevision/);
    assert.match(await read('.codex/internal-skills/skill-execution/references/dispatch.md'), /--user-revision true/);
    assert.match(await read('.codex/internal-skills/spec-me/GUIDE.md'), /위임은 사용자가 그 선택을 맡긴다고 답한 경우에만 성립한다/);
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
    '.codex/internal-skills/review-coordination/GUIDE.md',
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
