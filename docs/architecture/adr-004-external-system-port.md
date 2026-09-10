# ADR-004: ExternalSystemPort 외부 호출 경계

- 상태: Accepted
- 결정일: 2026-09-10

## Context

Behavioral Eval은 실제 Codex와 harness를 실행하면서도 GitHub/MCP mutation을 차단하고, 외부 응답 변화를 재현 가능하게 통제해야 한다. Runner나 grader가 provider API를 직접 호출하면 safety enforcement와 replay가 분산된다.

## Decision

모든 eval 외부 호출은 `ExternalSystemPort`를 통과한다.

```text
Eval Runner
   ↓
ExternalSystemPort
   ├─ GitHubStub/RecordingAdapter
   ├─ MCPStub/RecordingAdapter
   └─ ExplicitIntegrationAdapter
```

최소 계약은 다음과 같다.

```yaml
external_system_port:
  operations:
    - execute
    - record
    - replay
  request:
    normalized: true
  response:
    normalized: true
  mutation:
    default: deny
```

Recording은 provider raw payload보다 normalized semantic request/response를 우선 저장한다. Replay는 동일한 normalized request에 deterministic response를 반환한다. recording missing, request mismatch, schema mismatch는 live fallback 없이 `inconclusive`로 처리한다. Live adapter는 `integration: true`인 case에서만 선택하고 dedicated test resource만 사용한다.

Live integration case는 다음 `integration_resource` 계약을 선언해야 한다.

```yaml
integration_resource:
  system: github
  resource_id: fixture-repository
  target:
    repo: owner/harness-codex-eval-fixture
  dedicated: true
```

Live mutation은 선언된 `system`과 `target` 범위에 일치할 때만 허용한다. 기본 adapter, replay adapter, 범위를 벗어난 live request는 모두 mutation을 거부하고 `unauthorized_external_mutation` policy evidence를 남긴다. Production resource를 식별·허용하는 별도 우회 경로는 제공하지 않는다.

Enforcement는 세 층으로 나눈다.

```text
Codex permission
→ agent가 할 수 있는 행동 범위
ExternalSystemPort
→ 외부 시스템 side effect 경계
Harness workflow gates
→ 현재 workflow에서 행동이 허용되는지
```

별도 범용 permission engine은 도입하지 않는다. Runner와 grader의 GitHub/MCP 직접 호출은 금지한다.

## Consequences

- 외부 mutation 차단과 replay가 단일 경계에서 검증된다.
- Provider wire format 변화가 eval fixture에 미치는 영향을 줄인다.
- 각 외부 시스템 adapter와 normalized contract를 유지해야 한다.
- Integration case는 production resource와 분리된 운영·정리 정책이 필요하다.
