# ADR-011: Graphify Navigation Boundary

- 상태: Accepted
- 결정일: 2026-09-10

## Context

코드 조사에서 repository map을 Harness가 별도로 생성하면 source와 파생 index의 일관성을 유지해야 하고, Graphify가 제공하는 navigation capability와 중복된다. 반면 Graphify의 탐색 결과만 사실로 취급하면 stale index가 잘못된 설계 판단으로 이어질 수 있다.

## Decision

`code-research`는 Graphify connector가 제공하는 navigation 결과를 관련 파일·symbol·dependency를 찾는 1차 탐색 힌트로 사용한다. Graphify는 navigation index이며 source of truth가 아니다. 구체적인 사실은 실제 source와 tests로 확인하고, Graphify가 없거나 불완전하면 repository-local `rg`/`find`를 사용한다.

Harness는 별도의 `.codex/cache/repo-map.json`이나 동등한 derived source index를 생성·갱신하지 않는다. Graphify connector 호출은 외부 capability boundary를 통과하며 workflow semantics나 evidence ownership을 Harness 밖으로 이전하지 않는다.

```text
code_researcher
      ↓
Graphify navigation (optional)
      ↓
actual source and tests verification
      ↓
rg/find supplementation
```

## Consequences

- source/index drift를 Harness가 관리할 필요가 없다.
- Graphify connector가 없어도 local search로 code-research를 수행할 수 있다.
- Graphify navigation 결과 자체는 설계·정책 판단의 증거가 될 수 없고, 실제 source/test 확인이 필요하다.
