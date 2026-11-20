---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# aggregate-design

`domain-model`이 선언한 모델을 불변식으로 묶는다. [공통 절차](../domain-model/references/deepening.md)에 따라 preflight와 문서 경로 확인을 마친 뒤 [템플릿](../domain-model/references/template.md)의 BC별 Aggregate와 규칙 책임을 채운다.

1. 확정된 BIZ·INV·EX·AC·이벤트와 승인 답변, 각 BC의 선언·기존 모델 근거·Context Map을 대조한다. 기존 모델로 표현할 수 없는 책임은 `domain-model`로 반환한다.
2. 같은 시점에 함께 지켜야 할 불변식으로 Root와 멤버를 정하고, ID로 다른 Aggregate를 참조한다. Root는 외부 변경을 받는 Entity며 Entity는 Aggregate 하나에 속한다. 상태와 생애주기가 없는 BC는 Aggregate 부재 근거를 남긴다. 업무와 Aggregate의 크기는 실제 일관성 범위로 정한다.
3. Entity, Value Object 또는 외부 시스템이 소유하는 INV·EX마다 발동 조건, 불변식·예외, 결과를 요구사항·승인 답변에서 확인하고 책임 표에 소유 모델과 실제 담당 메서드 하나를 연결한다. 소유 가능한 Entity·Value Object가 없다면 `domain-service`에 처리할 규칙과 근거를 결과에 남긴다. 같은 규칙을 다른 표나 계층에 중복 정의하지 않는다.
4. Aggregate 사이 동작이 무엇을 읽고 무엇을 바꾸는지 구분한다. 동일 BC에서 하나의 연산이 함께 바꿀 상태가 즉시 일관성을 요구하면 같은 Aggregate로 묶는다. 조회 전용 참조는 ID를 유지한다. 다른 BC의 즉시 확인은 Aggregate 경계를 유지하고 `application-service`에 근거와 동기 확인 요구를 전달한다. 지연이 허용되는 경우 분리와 관찰 가능한 중간 결과를 관련 규칙 및 ADR에 연결한다. 근거로 결정할 수 없는 업무 선택에는 [공통 질문 절차](../domain-model/references/deepening.md#규칙-근거-확인)를 적용한다.
5. Entity 또는 Value Object가 있는 BC마다 [전술 클래스 다이어그램 지침](../../../quality/plantuml-diagrams/GUIDE.md#전술-클래스-다이어그램)을 적용해 `diagrams/<bc>.class.puml`과 SVG를 만들고 해당 BC에 상대 링크를 추가한다. Aggregate 경계·Root·Entity·Value Object의 포함과 Aggregate 사이 참조가 표와 일치해야 한다. Aggregate가 없는 BC에서는 값과 그 관계를 표시한다.
6. 지속되는 결정을 [공통 규칙](../domain-model/references/deepening.md#프로젝트-문서)에 따라 갱신한다. 전술 설계, 변경한 다이어그램 및 ADR 등 실제 수정한 파일을 workspace artifact에 기록한다.

기존 번호형 문서는 [기존 템플릿](../domain-model/references/legacy-template.md)의 Aggregate·일관성 결정 및 관련 결정 이력을 사용한다. 명시적 형식 이동은 `domain-model`부터 진행한다.
