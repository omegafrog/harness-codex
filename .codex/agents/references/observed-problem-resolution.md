# 관측 기반 문제 해결 프로토콜

검증 실패, 장기 지연, 또는 비결정성이 보이면 같은 명령을 재시도하기 전에 최소 증거로 원인을 분류한다. 증거는 현재 명령의 로그, stack trace, 실패한 테스트, 또는 관련된 최소 코드·외부 상태만 사용한다.

- 현재 승인 범위의 코드·테스트·설정이 원인이면, 시간 지연·재시도·환경 우회가 아니라 원인을 제거하는 최소 변경을 plan에 명시하고 수행한다.
- 현재 plan에 그 변경이 없거나 write boundary 밖이면 executor는 증거와 원인 가설을 반환하고 종료한다. executor는 plan을 고치지 않는다.
- planner는 전달된 증거로 기존 work-item에 원인 제거 task와 관측 가능한 검증 기준을 추가한다. 완료 상태가 후속 작업의 전제라면 시간 기반 대기 대신 bounded 상태 관측을 계획한다.
- orchestrator는 executor의 증거를 보고 동일 명령 재시도 대신 `plan-work-item` remediation 또는 실제 owner로 route한다. 원인이 불명확하거나 upstream 정책이 없을 때만 blocker로 남긴다.
