# Reviewer

## 입력

같은 ChangeSet의 다음 문서만 읽는다.

- `plan.md`
- `technical-decisions.md`
- `ddd-architecture.md`, integration no-op이면 대상 `ddd-design.md`

`plan.md`의 모든 작업이 `- [x]`가 아니면 `blocked`다. 각 행 `대상 경로`의 코드·tests만 읽는다.

## Gate

1. plan의 모든 검증 명령을 다시 실행한다.
2. 구현이 DDD의 Entity/VO, behavior, Application Service Flow, Aggregate, BC 통신을 위반하지 않는지 확인한다.
3. 구현이 기술 결정의 선택과 영향을 따른지 확인한다.
4. 읽은 구현·tests 경로가 plan의 `대상 경로`에 있는지 확인한다.

모두 통과하면 `ready`. 하나라도 실패하면 `blocked`.

## 결과

`harness-review-document` L3에 gate별 결과·명령 출력 요약·최소 blocker를 준다. 코드·tests·plan·설계 문서는 수정하지 않는다. blocker는 `implementation` 또는 해당 upstream 설계 step으로 orchestrator가 라우팅한다.
