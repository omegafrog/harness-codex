# ADR-008: Lifecycle Hook과 Deterministic Gate

- 상태: Accepted
- 결정일: 2026-09-10

## Context

Workflow lifecycle 경계의 검증을 agent prompt에만 맡기면 dependency, checkpoint, test, review, tracker 조건이 실행마다 달라진다. 반대로 hook이 routing이나 retry를 소유하면 Harness가 workflow brain이 된다.

## Decision

Lifecycle hook은 다음 경계에서 deterministic gate만 실행한다.

```yaml
hooks:
  before_dispatch:
    checks: [dependency, resource_conflict, workspace, permission_preflight]
  before_handoff:
    checks: [checkpoint_completeness, evidence_flush]
  before_complete:
    checks: workflow-specific
  after_merge:
    checks: workflow-specific
```

기본 구현 lifecycle은 위 검사를 사용한다. `spec-me` 같은 명세 workflow는
`.codex/workflows/<workflow>.yaml`에서 해당 hook에 빈 목록을 명시하고, Product/
Architecture coverage·ambiguity·diagram gate를 stage gate로 선언할 수 있다.
빈 hook은 암묵적 기본 검사를 복원하지 않으며, 실행 시 `no_checks_configured`로
명시적인 pass를 반환한다. workflow-specific gate의 의미와 순서는 canonical
Workflow YAML과 해당 SKILL.md가 소유하고, lifecycle hook은 routing을 소유하지 않는다.

외부 결과 계약은 다음 세 상태다.

```yaml
result:
  status: pass | fail | blocked
  rule_id: ...
  reason: ...
  evidence_path: ...
  violations: []
```

- `pass`: deterministic contract 충족
- `fail`: 현재 상태가 contract 위반
- `blocked`: 판정에 필요한 전제 또는 evidence 부족

Hook은 fail-closed로 동작하며 routing, retry, repair, priority를 결정하지 않는다. Orchestration agent가 verdict를 보고 다음 행동을 결정한다. Native permission result와 workflow gate result는 별도 저장한다.

Hook 자체 crash, malformed output, validator error는 rule violation으로 위장하지 않고 내부 `hook_execution_error` evidence로 기록한다. Behavioral Eval에서는 유효한 판정을 만들 수 없으므로 `inconclusive`가 될 수 있다.

## Consequences

- lifecycle gate의 재현 가능한 계약과 orchestration 책임이 분리된다.
- Hook output schema와 error evidence를 별도로 검증해야 한다.
- `blocked` 상태의 재개 결정은 orchestration agent와 tracker policy에 남는다.
