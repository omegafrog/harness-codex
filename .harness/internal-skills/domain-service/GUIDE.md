---
model_tier: implementation
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# domain-service

`aggregate-design`이 자연스러운 Entity·Value Object 소유자를 찾지 못한 도메인 판단을 구현 가능한 메서드로 정의한다. [공통 절차](../domain-model/references/deepening.md)에 따라 preflight와 경로 확인을 마친 뒤 [템플릿](../domain-model/references/template.md)의 BC별 모델 표와 규칙 책임 표를 채운다.

1. 확정 요구사항, 적용된 사용자 답변과 앞 단계의 소유 모델을 대조한다. 다른 Entity나 Value Object가 자연스럽게 소유할 수 있는 규칙은 `domain-model`이나 `aggregate-design`으로 반환한다.
2. 필요한 Domain Service만 모델 표에 추가한다. 판단에 필요한 정보는 값 또는 모델 타입의 입력으로 받고 도메인 결과와 거절 조건을 메서드에 표시한다. 저장, 이벤트 전달, transaction, 외부 호출과 업무 순서 조율은 `application-service`의 책임이다.
3. 실제 발동 조건, 불변식·예외, 결과를 확인한 INV·EX마다 책임 표에 이 모델과 실제 메서드를 연결한다. 이전 stage가 소유한 규칙 행은 그대로 둔다. 근거가 부족하면 가장 앞선 소유 stage에 반환하고 서비스·규칙을 만들어 채우지 않는다.
4. 변경한 전술 설계와 프로젝트 모델 행·ADR을 workspace artifact로 보고한다.

기존 번호형 문서는 [기존 템플릿](../domain-model/references/legacy-template.md)의 Domain Service 및 관련 결정 이력을 사용한다.
