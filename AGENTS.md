# Agent Context

Write internal agent input/output in English. Write workflow artifact Markdown documents and user questions in Korean. Preserve code identifiers, file paths, JSON keys, CLI commands, protocol names, and previously approved canonical terms when compatibility requires their original form.

This repo is a Node.js Codex harness for ChangeSet/use-case workflows.

If you want some settings or instruction about setting, running server or infra, then write below `docs/agents/EXEC.md`.

## Agent skills

### Issue tracker

GitHub Issues are the issue tracker for this repo. See `docs/agents/issue-tracker.md`.

### Domain docs

Multi-context. See `docs/agents/domain.md`.

### End-to-end tests

실제 서버와 인프라를 띄우고 엔드유저 관점의 E2E 테스트를 실행할 때는 `.codex/skills/e2e-test/SKILL.md`를 사용하고 `e2e_test_runner` 에이전트를 호출한다. 에이전트는 `docs/agents/EXEC.md`를 읽고 활성 작업 워크트리에서 실행해야 하며, 테스트 종료 후 artifact cleanup hook을 수행해야 한다.

### Frontend design

새 page/view/app shell을 만들거나 기존 UI/UX를 크게 재설계할 때는 `.codex/skills/frontend-design/SKILL.md`와 `.codex/workflows/frontend-design.yaml`의 독립 workflow를 사용한다. 이 흐름은 reference-first design → 전용 frontend implementation → 실제 browser screenshot 기반 visual review → correction loop를 자체적으로 수행하며, `implement`, `implement-wrapper`, `code-review`, `e2e-test`에 합치거나 하위 단계로 호출하지 않는다. Figwright가 연결되어 있거나 사용자가 Figma-first를 요청하면 `.codex/skills/frontend-figma/SKILL.md`를 사용해 Codex가 Figwright MCP/plugin으로 native Figma design을 직접 작성하고, 같은 root node를 구현 grounding과 browser/Figma 비교의 source of truth로 사용한다. Figma Agent/Make를 전제로 하지 않는다.

### Workspace 전달

워크플로우가 session/plan worktree를 만들거나 재사용하면 절대 경로를 `workspace_root`로 명시해 모든 에이전트와 도구 호출에 전달한다. 각 명령은 `cwd`를 명시하고, 구현·검증 에이전트는 시작 전에 실제 저장소 루트가 전달된 경로와 일치하는지 확인한다. 한 명령의 작업 디렉터리가 다음 명령이나 새 에이전트에 자동 상속된다고 가정하지 않는다. `spec-me`, `to-ticket`, `implement-wrapper`의 구체 규칙은 각각 해당 스킬을 따른다.

`spec-me`, `to-ticket`, E2E runner는 단계/agent/서버를 시작하기 전에 대상 worktree를 `cwd`로 두고 `node .codex/scripts/harness-workspace-preflight.mjs --expected-root <workspace_root> --json`을 실행한다. `valid: true`와 `cwd`, `git_root`, `worktree_registered` 일치를 확인하고, 실패하면 시작을 중단한다. `implement-wrapper`는 dispatch의 `before_dispatch` lifecycle hook이 같은 검증을 수행하며 통과 후에만 agent를 생성한다.

## Durable Context
- Ubiquitous language: `CONTEXT.md`
- Bounded context map: `CONTEXT-MAP.md`
