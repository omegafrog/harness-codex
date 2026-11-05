# 측정값을 비교할 때

성능·토큰·지연 개선 또는 회귀를 주장할 때 적용한다. 기능 성공 여부와 측정의 유효성을 별도로 판정한다.

1. 주장할 결과, 지표/단위, 대표 workload와 허용 회귀를 먼저 고정한다. 측정 스크립트가 포함·제외하는 구간과 실제 완료 작업 수·오류 수를 확인한다. 빠른 실패나 실행되지 않은 작업을 개선으로 세지 않는다.
2. runtime/model/config, 데이터 크기·분포·동시성, cache 상태, machine load를 맞춘다. replay와 live, 다른 모델이나 다른 workload의 결과를 동등 비교하지 않는다. profiling은 보고용 시간 측정과 분리한다.
3. 채택 여부를 판단하는 비교는 각 조건을 최소 5회 교차 실행(A/B/A/B…)하고 median과 range를 보고한다. 예산·인증·환경 제약으로 못 하면 실행 수와 한계를 공개하고 확정적 우열을 주장하지 않는다. 사용자 요청의 단순 개략치는 1회와 명시적 한계로 충분하다.
4. 차이가 편차 안이면 `차이 확인 불가`, 조건이 다르거나 실패/완료 작업을 확인하지 못하면 `inconclusive`로 판정한다. 지연을 줄인 메커니즘·병목 근거와 사용자 전체 경로에서의 비중을 설명한다. 작은 helper의 개선을 전체 workflow 개선으로 확대하지 않는다.
5. 보고에 기준/변경 commit, 재현 명령, 환경, workload, raw 값/증거, 오류·완료 수, median/range, delta와 판정을 포함한다. 작을수록 좋은 지표의 회귀율은 `(current - baseline) / baseline`이다. baseline 0이면 비율 대신 절대 차이를 보고한다.

suite별 threshold와 승인된 baseline은 그대로 적용한다. 통계적 신뢰도 부족은 추가 해석이며 기존 hard-gate 실패나 기능 실패를 무효화하지 않는다. baseline 변경은 별도 승인 대상이다. 무의미한 반복 실행으로 실패를 통과시킬 때까지 재시도하지 않는다.

출처 아이디어: pstack `benchmark-checklist`와 `principle-explain-the-number` ([분석 커밋](https://github.com/backnotprop/pstack/tree/6f131f137de64fdaf928278c0fd9ecec520ccbee)). Harness의 기존 평가·checkpoint 계약에 맞춰 작성했다.
