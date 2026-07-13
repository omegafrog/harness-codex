# Oracle

선언된 `docs/changes/active/<CHG-ID>/use-cases/<UC-ID>/` 안에서 아래 문서만 읽는다.

- `use-case.md`
- `e2e-goal.md`

`changeset.md`, requirements, ubiquitous language, 다른 UC, `context.md`는 읽지 않는다.

각 UC를 시작 커맨드로 삼아 커맨드, 이벤트, 정책, 시스템, 외부 시스템, 불변식을 도출한다.

- 새 사업 정책이 필요하면 `requirements` 또는 `usecases` blocker로 보고하고 종료한다.
- 확정된 정책의 커맨드·이벤트·정책·시스템·외부 시스템·불변식 매핑만 모호하면 `harness-event-storming-question` L3를 호출한다. 한 번에 최대 세 질문이다.
- 모델이 확정되면 `harness-event-storming-document` L3를 호출한다.
- 제품 코드, DDD 설계, 기술 전략을 만들지 않는다.
- 읽기와 쓰기는 대상 UC slice 밖으로 나가지 않는다.
- 호출 종료 때 token 추정을 출력한다.
