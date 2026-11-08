# Agent Context

Write internal agent input/output in English. Write workflow artifact Markdown documents and user questions in Korean. Preserve code identifiers, file paths, JSON keys, CLI commands, protocol names, and previously approved canonical terms when compatibility requires their original form.

This repo is a Node.js Codex harness for ChangeSet/use-case workflows.

## Harness source changes

When the user asks to change Harness itself in this source repository, edit and verify the source directly in the current workspace. Do not invoke the Harness orchestrator, compose a workflow, or create a worktree for that request unless the user explicitly asks for it.

When changing Harness behavior, update the consumer installation and update path in the same change. Trace the feature from its source through managed asset discovery/transforms, fresh install, update, Doctor inventory/diagnostics, and Git ignore rules (`.git/info/exclude` or `.gitignore`, according to ownership). Change the installer and Doctor wherever required, and add an installed-consumer regression check that verifies the installed behavior and `git status`: Harness-owned generated files must stay out of commits while application-owned changes remain visible and untouched. Do not assume that changing a source file alone makes the feature available to installed projects. Keep consumer-owned project guidance and configuration out of forced managed assets unless the installer explicitly treats them as safe templates.

After a Harness source change is committed, push the Harness source repository before updating any consumer repository. Consumer updates fetch or use the published Harness revision; updating a consumer before the source commit is pushed can silently install the previous behavior. Verify the pushed commit is present on the configured upstream branch before running the consumer update, and report both commit and consumer update results.

Before cleaning a workspace after Harness installation or update, inspect `git status --short` and classify every changed path as Harness-managed generated output or project-owned content. Synchronize consumer ignore rules for Harness-managed paths through the installer and verify representative paths with `git check-ignore -v`; keep project-owned preparation documents, including `docs/agents/EXEC.md`, `docs/agents/execution.json`, and `docs/contracts/**`, visible to Git. Back up every changed or untracked path before cleanup, including tracked modifications because ignore rules do not protect tracked files. Remove only enumerated Harness-generated paths after confirming their ownership, then inspect `git status --short` and verify the backup.

Write settings and instructions for running servers or infrastructure in `docs/agents/EXEC.md`.

## Agent skills

- Issue tracker: GitHub Issues. See `docs/agents/issue-tracker.md`.
- Domain docs: multi-context. See `docs/agents/domain.md`.
- End-to-end tests: 실제 서버·인프라를 띄우는 엔드유저 E2E는 `.codex/internal-skills/e2e-test/GUIDE.md`와 `e2e_test_runner` 에이전트를 사용한다.
- Frontend design: 새 page/view/app shell이나 큰 UI/UX 재설계는 `.codex/internal-skills/frontend-design/GUIDE.md`와 `.codex/workflows/frontend-design.yaml`의 독립 workflow를 사용한다. `implement`·`implement-wrapper`·`code-review`·`e2e-test`의 하위 단계로 호출하지 않는다.

## Workflow 규칙의 정본

workflow 실행 규칙은 각 GUIDE가 소유하며 여기에 복사하지 않는다.

| 주제 | 정본 |
|---|---|
| 작업 입력·`worktree_ref`·stage 실행·질문 반환 | `.codex/internal-skills/skill-execution/GUIDE.md` |
| worktree 생성·유지·종료와 `worktree.json` | `.codex/internal-skills/session-worktree/GUIDE.md`, `.codex/internal-skills/workflow-compose/GUIDE.md` |
| 진입 workspace preflight | 각 stage GUIDE와 workflow `before_dispatch` gate |
| 실행 중 로그·임시 파일·스크린샷 위치 | `.codex/internal-skills/skill-execution/references/runtime-artifact-paths.md` |
| tracker lifecycle·Beads mirror | `.codex/internal-skills/beads/GUIDE.md` |
| 통합 계약 갱신·seal·completion receipt | `.codex/internal-skills/sync-contracts/GUIDE.md` |
| Architecture Spec fresh review | `.codex/internal-skills/spec-me/references/adversarial-spec-review.md`, `.codex/internal-skills/spec-review/GUIDE.md` |
| 일반 검증과 E2E 선택 | `.codex/internal-skills/e2e-test/references/verification-policy.md` |

## Durable Context
- Ubiquitous language: `CONTEXT.md`
- 용어 선택은 해당 Context의 현행 canonical/폐기·대체 기록을 먼저 확인한다. 과거 Spec·구형 코드 명칭으로 폐기 용어를 부활시키지 않는다. 대체 구현은 소비자 이전과 구형 코드·경로·export/config/fixture 정리까지 범위에 포함하며, 호환 유지에는 실제 소비자 근거와 제거 조건을 남긴다.
- Bounded context map: `CONTEXT-MAP.md`
- 기존 모델·규칙 소유권·통신/배포 근거: `docs/architecture/domain-model.md`가 있으면 연결된 source/ADR/diagram과 함께 확인한다. 승인 target과 구현 사실을 구분하고, 작은 기능은 기존 owner 확장부터 검토한다.
- 규칙의 자동 enforcement와 수동 리뷰 범위: `docs/architecture/enforcement.md`. 반복 agent 오류 방지는 `correct`, 사용자 경로 검증 지도 유지보수는 `maintain-verification`을 사용한다.
- Reusable implementation-only user guidance: `docs/agents/implementation-guidance.md`. Test and verification preferences: `docs/agents/testing-guidance.md`. Agents read both from the active workspace, and updates travel with that workspace's branch.

## Beads Project Board

This project has a Beads workspace for durable tasks and shared handoff. Use the `beads` skill and `bd` CLI when working with Beads tasks. Linked Git worktrees share the same Beads workspace. Do not initialize a separate database in a linked worktree or sync/migrate remote data without following the coordinated migration gate.

## Canonical contracts

- Full Product contract: `docs/contracts/product.md`
- DDD architecture contract: `docs/contracts/architecture.md`
- Version/inventory: `docs/contracts/manifest.json`
- Clickable diagram/detail view: `docs/contracts/architecture.html`

Spec·계획·개별 plan 구현은 `docs/contracts/`를 수정하거나 seal하지 않는다. 최종 구현 workflow만 `sync-contracts`로 갱신한다. 다음 설계는 현행 계약·용어 index·Context map과 source를 먼저 읽으며, ticket Spec은 변경 이력일 뿐 통합 계약을 대신하지 않는다.

## 테스트·서비스 실행

Harness 소비자 workflow E2E의 정본 테스트 저장소: `/home/jiwoo/workspace/harness-test` (private GitHub: `git@github.com:omegafrog/harness-test.git`). `docs/agents/EXEC.md`의 계산기·인증·커뮤니티 black-box 시나리오와 두 `codex exec` 원문을 사용하고 implement 완료 후 산출물을 검증한다. 중단·실패·질문에 관찰자가 임의로 개입하거나 자동 재실행하지 않는다. 다른 세션에서도 이 저장소를 사용하며, 경로가 없으면 원격 주소로 찾거나 다시 clone한다. 테스트 전 저장소 상태와 설치된 Harness 버전을 확인한다.

일반 단위·회귀 검증은 `docs/agents/EXEC.md`의 명령을 언어별 기본 CLI로 실행한다. `harness-exec.mjs`와 `execution.json` profile은 명시적 사용자 흐름 E2E에만 사용한다. E2E 실행 전 실제 인자·환경·설정·인프라 readiness를 확인하고, 실행 전제가 바뀌면 관련 E2E profile과 EXEC를 갱신한다.
