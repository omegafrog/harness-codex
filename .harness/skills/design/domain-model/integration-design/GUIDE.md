---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# integration-design

BC별 Application Service와 사용 포트가 요구된 통합을 구현할 수 있는지 검토한다. [공통 절차](../domain-model/references/deepening.md)에 따라 preflight와 경로 확인을 마친 뒤 확정 요구사항, 승인 답변, Context Map, 관련 ADR과 [전술 설계](../domain-model/references/template.md)를 읽는다.

- 요구된 동기 호출에 실제 메서드·포트·요청·응답·오류 처리가 있고 호출자가 필요한 시점에 결과를 받는지 확인한다.
- 비동기 흐름의 발행·수신 메서드가 같은 메시지 계약을 따르는지, transaction과 발행 순서 및 실패 결과가 요구와 일치하는지 확인한다.
- 관계·판단 소유권이 틀리면 `bounded-context`, 일관성 근거가 틀리면 `aggregate-design`, 호출·포트가 빠졌으면 `application-service`의 가장 앞선 소유자로 반환한다. 관계 그래프의 기술 선택은 구현 설계에서 한다.
- 확인 결과와 근거를 요약에 기록하고 `completed / OK`를 반환한다. BC별 통합 사실은 기존 AS 행과 사용 포트가 소유한다.

기존 번호형 문서를 재개할 때는 [기존 템플릿](../domain-model/references/legacy-template.md)의 통합 및 관련 결정 이력을 완성한다. 구형 일관성 행의 출처와 통신 근거를 그대로 사용한다.
