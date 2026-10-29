# Agent Context

Write internal agent input/output in English. Write workflow artifact Markdown documents and user questions in Korean. Preserve code identifiers, file paths, JSON keys, CLI commands, protocol names, and previously approved canonical terms when compatibility requires their original form.

This repo is a Node.js Codex harness for ChangeSet/use-case workflows.

## Harness source changes

When changing Harness behavior, update the consumer installation and update path in the same change. Trace the feature from its source through managed asset discovery/transforms, fresh install, update, Doctor inventory/diagnostics, and Git ignore rules (`.git/info/exclude` or `.gitignore`, according to ownership). Change the installer and Doctor wherever required, and add an installed-consumer regression check that verifies the installed behavior and `git status`: Harness-owned generated files must stay out of commits while application-owned changes remain visible and untouched. Do not assume that changing a source file alone makes the feature available to installed projects. Follow `.codex/internal-skills/implement/GUIDE.md` for the complete implementation check.

Before cleaning a workspace after Harness installation or update, inspect `git status --short` and classify every changed path as Harness-managed generated output or project-owned content. Synchronize consumer ignore rules for Harness-managed paths through the installer and verify representative paths with `git check-ignore -v`; keep project-owned preparation documents, including `docs/agents/EXEC.md`, `docs/agents/execution.json`, and `docs/contracts/**`, visible to Git. Back up every changed or untracked path before cleanup, including tracked modifications because ignore rules do not protect tracked files. Remove only enumerated Harness-generated paths after confirming their ownership, then inspect `git status --short` and verify the backup.

If you want some settings or instruction about setting, running server or infra, then write below `docs/agents/EXEC.md`.

## Agent skills

### Issue tracker

GitHub Issues are the issue tracker for this repo. See `docs/agents/issue-tracker.md`.

### Domain docs

Multi-context. See `docs/agents/domain.md`.

### End-to-end tests

실제 서버와 인프라를 띄우고 엔드유저 관점의 E2E 테스트를 실행할 때는 `.codex/skills/e2e-test/SKILL.md`를 사용하고 `e2e_test_runner` 에이전트를 호출한다. 에이전트는 `docs/agents/EXEC.md`를 읽고 활성 작업 워크트리에서 실행해야 하며, 테스트 종료 후 artifact cleanup hook을 수행해야 한다.

### Frontend design

새 page/view/app shell을 만들거나 기존 UI/UX를 크게 재설계할 때는 `.codex/skills/frontend-design/SKILL.md`와 `.codex/workflows/frontend-design.yaml`의 독립 workflow를 사용한다. 이 흐름은 reference-first design → 전용 frontend implementation → 실제 browser screenshot 기반 visual review → correction loop를 자체적으로 수행하며, `implement`, `implement-wrapper`, `code-review`, `e2e-test`에 합치거나 하위 단계로 호출하지 않는다. Figwright가 연결되어 있거나 사용자가 Figma-first를 요청하면 `.codex/internal-skills/frontend-figma/GUIDE.md`를 사용해 Codex가 Figwright MCP/plugin으로 native Figma design을 직접 작성하고, 같은 root node를 구현 grounding과 browser/Figma 비교의 source of truth로 사용한다. Figma Agent/Make를 전제로 하지 않는다.

### 작업 입력과 Workspace

기본적으로 스킬과 하위 작업의 입력에 작업 위치·문서·산출물 경로를 개별적으로 전달하지 않는다. worktree가 준비된 호출에는 정본 `worktree.json`의 `worktree_ref`만 전달하고 각 스킬이 필요한 위치와 plan 식별자를 읽는다. 사용자가 특정 파일을 지정하거나 실행 도구의 필수 인자처럼 경로를 직접 전달해야 하는 경우에만 해당 경로를 전달한다. 작업 위치와 공용 지침은 정본 기록을 기준으로 확인하고, 서로 다른 Git common directory의 경로를 혼용하지 않는다. 명령의 작업 디렉터리가 다음 명령이나 새 에이전트에 자동 상속된다고 가정하지 않는다. `spec-me`, `to-ticket`, `implement-wrapper`의 구체 규칙은 각각 해당 스킬을 따른다.

`spec-me`, `to-ticket`, E2E runner는 진입 시 대상 worktree를 `cwd`로 두고 `node .codex/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json`을 한 번 실행한다. `workflow-compose`가 worktree 생성·재사용과 생성 직후 검사를 맡고, `spec-me`는 전달받은 `worktree.json`의 작업 위치에서 진입 검사를 수행한다. `valid: true`와 `cwd`, `git_root`, `worktree_registered` 일치를 확인하고, 실패하면 시작을 중단한다. `to-ticket`은 GitHub 조회를 계획 리뷰 완료 뒤 한 번에 수행하기 위해 `--defer-tracker-sync`를 사용하고, 정상 종료의 `tracker_sync` gate에서 전체 티켓을 batch 확인한다. `implement-wrapper`는 dispatch의 `before_dispatch` lifecycle hook이 같은 검증을 수행하며 통과 후에만 agent를 생성한다.

## Durable Context
- Ubiquitous language: `CONTEXT.md`
- 용어 선택은 해당 Context의 현행 canonical/폐기·대체 기록을 먼저 확인한다. 과거 Spec·구형 코드 명칭으로 폐기 용어를 부활시키지 않는다. 대체 구현은 소비자 이전과 구형 코드·경로·export/config/fixture 정리까지 범위에 포함하며, 호환 유지에는 실제 소비자 근거와 제거 조건을 남긴다.
- Bounded context map: `CONTEXT-MAP.md`
- 기존 모델·규칙 소유권·통신/배포 근거: `docs/architecture/domain-model.md`가 있으면 연결된 source/ADR/diagram과 함께 확인한다. 승인 target과 구현 사실을 구분하고, 작은 기능은 기존 owner 확장부터 검토한다.
- 규칙의 자동 enforcement와 수동 리뷰 범위: `docs/architecture/enforcement.md`. 반복 agent 오류 방지는 `correct`, 사용자 경로 검증 지도 유지보수는 `maintain-verification`을 사용한다.
- Reusable implementation-only user guidance: `docs/agents/implementation-guidance.md`. `spec-me` and user design discussions record explicit preferences there with provenance; `implement` and implementation agents read only in-scope entries and stop on conflicts with the approved ticket Specs.
- Test and verification preferences: `docs/agents/testing-guidance.md`. All implementation and test agents read both guidance documents from the original project root identified by the canonical worktree record, never from branch-local copies. Verify it shares the same Git common directory as the workspace.

## Beads Project Board

This project has a Beads workspace for durable tasks and shared handoff. `to-ticket` creates each workflow ticket in both Beads and the configured tracker; implementation status transitions are mirrored to Beads while the configured tracker remains authoritative. Use the `beads` skill and `bd` CLI when working with Beads tasks. Linked Git worktrees share the same Beads workspace. Do not initialize a separate database in a linked worktree or sync/migrate remote data without following the coordinated migration gate.

## Canonical contracts

- Full Product contract: `docs/contracts/product.md`
- DDD architecture contract: `docs/contracts/architecture.md`
- Version/inventory: `docs/contracts/manifest.json`
- Clickable diagram/detail view: `docs/contracts/architecture.html`

`spec-me`와 `to-ticket`은 제안·계획 단계이므로 ticket-scoped Spec과 계획만 갱신하고 `docs/contracts/`는 수정하거나 seal하지 않는다. 구현 ticket이 모두 완료·통합된 최종 `implement-wrapper` 완료와 독립 최종 구현 workflow에서만 `sync-contracts`와 실제 `contract_docs` 검사를 수행한다. 구현 중에는 contract snapshot drift를 preflight에서 명시적으로 deferred로 기록하되, 구조 오류·실행 준비 실패는 계속 차단한다. 다음 설계는 현행 계약·용어 index·Context map과 source를 먼저 읽는다. ticket Spec은 변경 이력이며 통합 계약을 대신하지 않는다. 문서·모델·용어·diagram·source가 어긋나면 최종 완료/Done/종속 plan 해제를 차단한다.

## Tracker lifecycle

신규 tracker mirror는 `beads` 스킬의 lifecycle v1과 `harness-tracker.mjs` 공통 코드로 관리한다. canonical 상태는 네 개이며 backlog 분류와 test/review 단계는 metadata다. workflow 시작 preflight/dispatch와 종료 hook의 실제 tracker_sync 검사를 통과해야 한다. 단, `to-ticket`은 모든 계획과 fresh review 완료 전 외부 Issue 조회를 미루고, publish 후 완료 hook에서 해당 plan set 전체를 batch 확인한다. 기존 데이터 migration과 자동 연결은 하지 않는다.

## Workflow worktree 종료

workflow의 소유 linked worktree는 `session-worktree`의 create/reserve/register와 finish로 관리한다. `spec-me` 완료 뒤 `to-ticket`으로 이어질 때는 같은 worktree를 유지하고, `to-ticket` 완료나 실패·사용자 중단에서는 worktree를 제거한다. primary/비소유 workspace는 지우지 않는다. cleanup 실패는 완료 실패다.

소유 worktree의 canonical context와 lifecycle은 `<workspace>/.io/worktree.json` 하나로 관리한다. `session-worktree` CLI가 생성·갱신하고, 각 작업은 이 정본을 읽는다. 개별 worktree 필드를 작업 입력마다 복사하지 않는다.

공통 completion receipt의 `state=completed`는 `completion_kind`가 지정하는 단계 산출물만 완료됐다는 뜻이다: Spec은 `spec_ready_for_planning`, 계획 발행은 `plan_set_ready_for_implementation`, 개별 plan은 `plan_implemented`, 최종 통합은 `feature_implemented`. `spec-me`의 완료 receipt 뒤 `to-ticket`은 같은 worktree에서 계획을 이어간다. 취소·실패로 종료한 실행은 `worktree.json`의 `outcome=aborted|failed`로 기록한다.

## Session output

실행 입력은 작업 workspace의 `.io/<plan-set-id>/<skill>/<execution-id>/input.json`에 기록한다. 로그·임시 파일·스크린샷·평가 결과·checkpoint는 해당 workspace의 `.io`에 기록한다. standalone/main 실행은 `harness-session-output.mjs`로 위치를 구하고, worktree 작업은 canonical `worktree.json`을 읽는다. worker는 worktree의 `.git` 아래에 접근하지 않고 `docs/agents/EXEC.md`의 process 환경·browser output 규칙을 적용한다. 최종 source·Spec·계약·제품 다이어그램은 선언된 프로젝트 경로를 사용한다.

## 테스트·서비스 실행

Harness 소비자 workflow 테스트 저장소: `/home/jiwoo/workspace/.harness-worktrees/harness/aa279184-e3bc-4a1e-bf58-27b1835724db` (private GitHub: `git@github.com:omegafrog/harness-specme-e2e-20261028.git`). 다른 세션에서도 이 저장소를 사용하며, 경로가 없으면 원격 주소로 찾거나 다시 clone한다. 테스트 전 저장소 상태와 설치된 Harness 버전을 확인한다.

일반 단위·회귀 검증은 `docs/agents/EXEC.md`의 명령을 언어별 기본 CLI로 실행한다. `harness-exec.mjs`와 `execution.json` profile은 명시적 사용자 흐름 E2E에만 사용한다. E2E 실행 전 실제 인자·환경·설정·인프라 readiness를 확인하고, 실행 전제가 바뀌면 관련 E2E profile과 EXEC를 갱신한다.

## Fresh Spec review

새 Architecture Spec은 `spec-review`의 작성자와 분리된 fresh subagent 한 명이 요청 원문, Product Spec, Architecture Spec과 근거를 직접 읽고 적대적으로 검토한다. Product Spec은 요구사항 기준으로 검토 입력에 포함하며 별도 Product 리뷰를 수행하지 않는다. parent/writer 맥락을 상속하지 않으며 Normal mode도 생략하지 않는다. DDD 분류와 규칙 소유권, 비즈니스 로직 단위 테스트 명세, 기술 선택 근거의 연결 및 요구사항 구현에 필요한 인프라 완전성을 평가한다. 중대 지적·stale snapshot·리뷰 누락은 spec-me 완료/to-ticket 인계를 막고 수정본은 새 reviewer로 재검토한다.
