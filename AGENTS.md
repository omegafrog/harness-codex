# Agent Context

Write internal agent input/output in English. Write workflow artifact Markdown documents and user questions in Korean. Preserve code identifiers, file paths, JSON keys, CLI commands, protocol names, and previously approved canonical terms when compatibility requires their original form.

This repo is a Node.js Codex harness for ChangeSet/use-case workflows.

## Harness source changes

When changing Harness behavior, update the consumer installation and update path in the same change. Trace the feature from its source through managed asset discovery/transforms, fresh install, and update; change the installer where required and add an installed-consumer regression check. Do not assume that changing a source file alone makes the feature available to installed projects. Follow `.codex/internal-skills/implement/GUIDE.md` for the complete implementation check.

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

### Workspace 전달

워크플로우가 session/plan worktree를 만들거나 재사용하면 절대 경로를 `workspace_root`로 명시해 모든 에이전트와 도구 호출에 전달한다. 각 명령은 `cwd`를 명시하고, 구현·검증 에이전트는 시작 전에 실제 저장소 루트가 전달된 경로와 일치하는지 확인한다. 한 명령의 작업 디렉터리가 다음 명령이나 새 에이전트에 자동 상속된다고 가정하지 않는다. `spec-me`, `to-ticket`, `implement-wrapper`의 구체 규칙은 각각 해당 스킬을 따른다.

`spec-me`, `to-ticket`, E2E runner는 단계/agent/서버를 시작하기 전에 대상 worktree를 `cwd`로 두고 `node .codex/scripts/harness-workspace-preflight.mjs --expected-root <workspace_root> --json`을 실행한다. `valid: true`와 `cwd`, `git_root`, `worktree_registered` 일치를 확인하고, 실패하면 시작을 중단한다. `to-ticket`은 GitHub 조회를 계획 리뷰 완료 뒤 한 번에 수행하기 위해 `--defer-tracker-sync`를 사용하고, 정상 종료의 `tracker_sync` gate에서 전체 티켓을 batch 확인한다. `implement-wrapper`는 dispatch의 `before_dispatch` lifecycle hook이 같은 검증을 수행하며 통과 후에만 agent를 생성한다.

## Durable Context
- Ubiquitous language: `CONTEXT.md`
- 용어 선택은 해당 Context의 현행 canonical/폐기·대체 기록을 먼저 확인한다. 과거 Spec·구형 코드 명칭으로 폐기 용어를 부활시키지 않는다. 대체 구현은 소비자 이전과 구형 코드·경로·export/config/fixture 정리까지 범위에 포함하며, 호환 유지에는 실제 소비자 근거와 제거 조건을 남긴다.
- Bounded context map: `CONTEXT-MAP.md`
- 기존 모델·규칙 소유권·통신/배포 근거: `docs/architecture/domain-model.md`가 있으면 연결된 source/ADR/diagram과 함께 확인한다. 승인 target과 구현 사실을 구분하고, 작은 기능은 기존 owner 확장부터 검토한다.
- 규칙의 자동 enforcement와 수동 리뷰 범위: `docs/architecture/enforcement.md`. 반복 agent 오류 방지는 `correct`, 사용자 경로 검증 지도 유지보수는 `maintain-verification`을 사용한다.
- Reusable implementation-only user guidance: `docs/agents/implementation-guidance.md`. `spec-me` and user design discussions record explicit preferences there with provenance; `implement` and implementation agents read only in-scope entries and stop on conflicts with the approved ticket Specs.
- Test and verification preferences: `docs/agents/testing-guidance.md`. All implementation and test agents read both guidance documents from the original project root passed as absolute `shared_guidance_root` (`return_root` for workflow worktrees), never from branch-local copies. Verify it shares the same Git common directory as `workspace_root`.

## Beads Project Board

This project has a Beads workspace for durable tasks and shared handoff. `to-ticket` creates each workflow ticket in both Beads and the configured tracker; implementation status transitions are mirrored to Beads while the configured tracker remains authoritative. Use the `beads` skill and `bd` CLI when working with Beads tasks. Linked Git worktrees share the same Beads workspace. Do not initialize a separate database in a linked worktree or sync/migrate remote data without following the coordinated migration gate.

## Canonical contracts

- Full Product contract: `docs/contracts/product.md`
- DDD architecture contract: `docs/contracts/architecture.md`
- Version/inventory: `docs/contracts/manifest.json`
- Clickable diagram/detail view: `docs/contracts/architecture.html`

모든 정상 workflow 종료는 `sync-contracts` 스킬과 실제 `contract_docs` 검사를 적용한다. 다음 설계는 위 현행 계약·용어 index·Context map과 source를 먼저 읽는다. ticket Spec은 변경 이력이며 통합 계약을 대신하지 않는다. 문서·모델·용어·diagram·source가 어긋나면 완료/Done/종속 plan 해제를 차단한다.

## Tracker lifecycle

신규 tracker mirror는 `beads` 스킬의 lifecycle v1과 `harness-tracker.mjs` 공통 코드로 관리한다. canonical 상태는 네 개이며 backlog 분류와 test/review 단계는 metadata다. workflow 시작 preflight/dispatch와 종료 hook의 실제 tracker_sync 검사를 통과해야 한다. 단, `to-ticket`은 모든 계획과 fresh review 완료 전 외부 Issue 조회를 미루고, publish 후 완료 hook에서 해당 plan set 전체를 batch 확인한다. 기존 데이터 migration과 자동 연결은 하지 않는다.

## Workflow worktree 종료

workflow의 소유 linked worktree는 `session-worktree`의 create/reserve/register와 공통 finish로 관리한다. 완료·실패·사용자 중단·handoff에서 writer/agent/서버를 종료하고 기록을 보존·검증한 뒤 worktree를 제거한다. branch/recovery는 유지하고 primary/비소유 workspace는 지우지 않는다. cleanup 실패는 완료 실패다. 다음 진입에서는 pending receipt를 확인하고 중단된 실행만 복구 정리한다.

## Session output

로그·임시 파일·스크린샷·평가 결과·checkpoint·복구 백업은 `harness-session-output.mjs --root <workspace_root>`가 반환한 `session_directory` 안에만 기록한다. 모든 agent/tool에 이 경로를 전달하고 `docs/agents/EXEC.md`의 process 환경·browser output 규칙을 적용한다. 최종 source·Spec·계약·제품 다이어그램은 선언된 프로젝트 경로를 사용한다.

## 테스트·서비스 실행

테스트·서버·인프라는 `docs/agents/EXEC.md`와 프로젝트 소유 `docs/agents/execution.json`의 프로필을 사용해 `harness-exec.mjs --root <workspace_root> --profile <id>`로 실행한다. 인자·환경값·설정 준비/검증·인프라 readiness 누락/실패 시 시작을 차단하며 직접 명령으로 우회하지 않는다. 구현이 실행 전제를 바꾸면 프로필·EXEC도 함께 갱신한다.

## Fresh Spec review

새 Product/Architecture Spec은 `spec-review`의 서로 다른 fresh subagent가 요청 원문과 근거를 직접 읽고 적대적으로 검토한다. parent/writer 맥락을 상속하지 않으며 Normal mode도 생략하지 않는다. 중대 지적·stale snapshot·리뷰 누락은 spec-me 완료/to-ticket 인계를 막고 수정본은 새 reviewer로 재검토한다.
