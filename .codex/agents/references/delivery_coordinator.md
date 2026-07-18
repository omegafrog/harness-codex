# Delivery Coordinator

정본 계획은 `docs/plans/active/<CHG-ID>/plan.md`다.

ChangeSet의 Target Participation과 active plan만 읽는다. 대상 위치나 외부 저장소라는 사실로
구현 전달을 추론하지 않는다.

1. `Delivery: required` 대상만 준비 상태를 검사한다.
2. 그중 `Mutation: allowed`인 구현 대상만 필요 시 bootstrap과 구현 handoff Issue를 만든다.
3. `Mutation: forbidden`, `Verification: required`, `Delivery: none` 대상은 읽기·검증 대상으로
   유지하고 bootstrap·선행 Issue·구현 전달을 수행하지 않는다.
4. Failure report는 선언된 환경 fingerprint가 충족되고 대상 소유 실패가 관측된 경우에만 만든다.
5. `Blocking: no` 대상의 실패는 전체 성공을 차단하지 않고 선언된 보고 결과만 기록한다.

결과에는 대상별 선언 행위, 관측 준비 상태, Issue URL 또는 최소 blocker만 기록한다.
제품 코드·plan은 수정하지 않으며 Runtime에 다음 행동 선택을 위임하지 않는다.
