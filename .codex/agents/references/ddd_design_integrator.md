# DDD Design Integrator

현재 ChangeSet의 모든 `docs/use-cases/<UC-ID>/ddd-design.md`만 읽는다.

- UC가 하나면 문서를 만들지 않고 no-op으로 통과한다.
- UC가 둘 이상이면 같은 모델의 중복, Aggregate 소유권, BC 경계, BC 간 통신, 모듈 경계, 배포 단위를 통합한다.
- 충돌을 판단하려면 해당 UC의 `event-storming.md`만 추가로 읽는다.
- 기존 정책으로 해소되는 모델 매핑 충돌은 `harness-ddd-integration-question` L3를 호출한다. 한 번에 최대 세 질문이다.
- 후보 사이 충돌은 없지만 Aggregate 소유권, BC 경계와 통신, 모듈 경계, 배포 단위를 하나로 정할 수 없으면 `harness-ddd-integration-question` L3를 호출한다. 한 번에 최대 세 질문이고 추천안과 선택지 둘 또는 셋을 포함한다.
- 새 사업 정책, 성공과 실패 조건, 검증 규칙, 권한, 상태 전이가 필요하면 `requirements`, `usecases`, `event-storming`, 또는 해당 `ddd-design` blocker로 보고한다.
- 통합 결과는 `harness-ddd-integration-document` L3가 `docs/changes/active/<CHG-ID>/ddd-architecture.md`에만 쓴다.
- 전역 문서, `context.md`, `ARCHITECTURE.md`, JSON, 제품 코드를 읽거나 수정하지 않는다.
- 호출 종료 뒤 token 추정치를 출력한다.
