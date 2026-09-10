# ADR-002: 얇은 Eval Runner 경계

- 상태: Accepted
- 결정일: 2026-09-10

## Context

P0 Behavioral Eval에는 실제 Codex와 실제 harness를 실행하고, case별 workspace·recording·timeout·결과 집계를 관리하는 재사용 가능한 실행 경계가 필요하다. CI shell만 사용하면 lifecycle과 safety boundary가 분산되고, 반대로 orchestration engine을 만들면 `harness-codex`의 책임이 과도하게 커진다.

## Decision

현재 Node package 안에 얇은 `harness-eval` CLI와 내부 eval modules를 둔다.

```text
bin/harness-eval.mjs
src/eval/
  runner.mjs
  case-loader.mjs
  case-workspace.mjs
  plan-workspace.mjs
  codex-adapter.mjs
  recording.mjs
  journal.mjs
  graders/
  report.mjs
```

Runner lifecycle은 다음만 소유한다.

```text
provision → launch → observe → enforce safety boundary
→ collect → grade → cleanup
```

실제 agent execution은 Codex가 수행한다. Workflow YAML/SKILL.md는 workflow semantics를, eval case는 scenario와 expected contract를, grader는 관찰 결과 판정을, journal은 trajectory/evidence를, CI는 CLI 실행과 release gate를 소유한다.

Eval Runner는 `spec-me` stage orchestration, plan dependency scheduler, reviewer spawn 규칙, tracker workflow semantics, Codex agent loop를 재구현하지 않는다.

## Codex Process Adapter

`CodexProcessAdapter`는 실제 Codex 프로세스의 lifecycle만 담당한다.

- case별 `cwd`와 disposable workspace 전달
- native permission profile, model, model config, environment profile 전달
- stdout/stderr 및 Codex structured event 수집
- exit code, signal, timeout 분류
- 필요 시 terminate와 cleanup

Command는 runner에 하드코딩하지 않고 environment profile에서 주입한다.

```yaml
environment:
  codex:
    command:
      - codex
      - exec
    model: gpt-5.6-luna
    permission_profile: eval-workspace
```

실행된 command, cwd, model, permission profile, environment profile snapshot은 eval artifact에 보존한다. Structured event를 semantic source로 우선 사용하고 stdout parsing은 fallback으로만 사용한다. Adapter는 workflow 의미 해석, stage routing, agent loop 재구현을 하지 않는다.

## Consequences

- `node bin/harness-eval.mjs run --suite p0`로 고정된 실행 경계를 제공한다.
- case lifecycle, safety boundary, recording, timeout 분류, 결과 집계를 한 곳에서 검증할 수 있다.
- 별도 orchestration service나 Python runtime 재구축은 하지 않는다.
- 기존 Node package 구조와 새 `src/eval/` 경계 사이의 module contract를 명확히 해야 한다.
