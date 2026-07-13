---
name: harness-orchestrate-instruction
description: Harness 메인 워크플로우의 사용자 단일 진입점이다.
---

# Harness Orchestration

사용자 직접 진입점(L1).

1. orchestration agent를 호출한다.
2. 직접 step을 수행하거나 하위 skill을 선택하지 않는다.
3. agent가 결과에 따라 적절한 L2 step을 호출해 라우팅한다.
4. 사용자 질문, 차단, 완료에서 종료한다.
