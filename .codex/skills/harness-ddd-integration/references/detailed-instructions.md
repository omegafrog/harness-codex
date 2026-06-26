# Harness DDD Integration Detailed Instructions

## 실행 순서

1. active ChangeSet에서 affected use case를 확인한다.
2. 모든 UC의 `ddd-design.md`가 candidate로 준비됐는지 확인한다. 누락된 후보가 있으면 해당 DDD stage로 block을 라우팅한다.
3. 각 후보의 Event Storming, Use Case, E2E goal, `context.md`, 기존 `ARCHITECTURE.md`를 읽는다.
4. 모델 claim을 정규화한 뒤 동일성, Aggregate 소유권, lifecycle, invariant, command/event 의미를 비교한다.
5. 모든 후보 claim을 accepted, deferred, rejected, blocked 중 하나로 추적한다.
6. accepted일 때만 Markdown 결정 기록, JSON contract, 필요한 `ARCHITECTURE.md` delta를 작성한다.

## 병합 규칙

- Markdown 문서를 이어 붙이지 않는다. 모델 claim 단위로 병합한다.
- 같은 의미의 중복 claim은 하나로 합치되 모든 UC를 provenance에 남긴다.
- additve 변경은 기존 invariant와 양립할 때만 canonical model에 추가한다.
- 동일 Aggregate의 보완적 행동은 한 contract에 합친다.
- Aggregate가 다른 Entity를 직접 공유·수정하도록 만들지 않는다. 필요한 연결은 ID, domain event, published contract로 표현한다.
- 저장소, adapter, retry, transaction propagation, cache 등 구현 메커니즘은 technical-decisions로 남기고 DDD 통합을 차단하지 않는다.

## fail-closed 충돌

다음은 근거가 없으면 `blocked`다.

- 같은 Entity의 Aggregate owner가 둘 이상인 경우
- physical delete, soft delete, immutable lifecycle, 상태 전이가 양립하지 않는 경우
- 권한·일관성·검증 규칙이 충돌하는 경우
- 같은 command/event 이름의 의미가 다른 경우
- canonical noun, actor role, state label의 의미 경계가 모호한 경우

Blocker는 가장 가까운 소유 단계로 라우팅한다.

- 요구사항 정책 부족: `requirements-definition`
- canonical 용어·alias·상태 의미 부족: `ubiquitous-language-definition`
- flow, command/event, policy evidence 부족: `event-storming`
- 특정 후보의 DDD 구조 불완전: `ddd-architecture-definition --uc <UC-ID>`

## 산출물 경로

ChangeSet 자체가 `docs/changes/active/<CHG-ID>.md` 파일이므로 같은 이름의 디렉터리를 만들 수 없다. 다음 sibling artifact를 사용한다.

- `docs/changes/active/<CHG-ID>.ddd-integration.md`
- `docs/changes/active/<CHG-ID>.ddd-integration.json`

JSON은 runtime validator가 읽는다. candidate input hash가 달라지면 통합 결과와 downstream 단계는 stale이다.

## JSON contract 필수 schema

`status: "accepted"` 산출물은 다음 key를 반드시 포함한다.

- `change_set`: ChangeSet ID 문자열
- `candidate_inputs`: candidate별 입력 배열
  - 각 항목은 `uc_id`, `path`, `hash`를 포함한다.
  - `hash` 값은 `sha256:<hex>` 형식이다. `sha256` key만 쓰지 말고 반드시 `hash` key를 쓴다.
- `coverage`: UC별 반영 상태 mapping
  - 예: `"coverage": {"UC-030": "accepted", "UC-031": "accepted"}`
  - 배열만 쓰지 않는다.
- `canonical_models`: canonical bounded context별 모델 배열
  - 각 항목은 `bounded_context` 문자열과 `aggregates` 배열을 포함한다.
  - 각 aggregate는 `name` 문자열과 `provenance` 배열을 포함한다.
- `blocked_conflicts`: accepted 상태에서는 빈 배열이어야 한다.

예시:

```json
{
  "status": "accepted",
  "change_set": "CHG-20260625-001",
  "candidate_inputs": [
    {
      "uc_id": "UC-030",
      "path": "docs/use-cases/UC-030/ddd-design.md",
      "hash": "sha256:..."
    }
  ],
  "coverage": {
    "UC-030": "accepted"
  },
  "canonical_models": [
    {
      "bounded_context": "Notification Management Context",
      "aggregates": [
        {
          "name": "NotificationAggregate",
          "provenance": ["UC-030"]
        }
      ]
    }
  ],
  "blocked_conflicts": []
}
```
