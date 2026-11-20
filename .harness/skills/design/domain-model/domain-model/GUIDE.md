---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# domain-model

`bounded-context`가 확정한 요구사항을 BC별 도메인 모델로 옮긴다. [공통 절차](references/deepening.md)에 따라 preflight와 문서 경로 확인을 마친 뒤 [전술 설계 템플릿](references/template.md)의 모델 표를 채운다.

## 용어와 모델 수명

모델의 의미·소유권·식별성·수명이 달라질 때 사용자가 이름 변경을 먼저 요청하기를 기다리지 말고 용어 drift를 검토한다. [용어 생애주기](references/language-lifecycle.md)에 따라 기존 정의와 확정된 새 의미를 대조하고, 유지·정의 수정·rename·분리/통합·폐기 중 처리를 기존 설계와 glossary에 근거와 함께 기록한다. 업무 의미나 경계가 달라지는 선택은 관련 설계 topic에서 질문하고, 이름만 정리하면 되는 경우에는 별도 승인 질문을 만들지 않는다.

`CONTEXT.md`는 glossary로만 사용한다. project-wide 또는 BC-scoped 용어는 범위를 명시해 기록하고, BC 이름·책임·관계는 `CONTEXT-MAP.md`에 둔다. Plan Set 문서의 용어 표는 glossary 갱신을 대신하지 않는다. 이미 승인된 대체어를 따르고, 역사적 문서·폐기 기록·호환 식별자를 현행 용어로 되살리지 않는다. 새로 배운 사실이 사용자에게 확정된 비즈니스 의미를 바꾸면 `requirements-fix`로 돌려보낸다.

1. 요청 원문, 확정된 `requirements.md`의 BIZ·INV·EX·AC·이벤트·SD·BC, 적용된 사용자 답변, `CONTEXT.md`와 `CONTEXT-MAP.md`, 기존 프로젝트 모델·연결된 ADR을 읽는다. 앞 단계가 확정한 BC 경계와 용어를 사용한다.
2. 기존 프로젝트에서는 [code-research](../../../research/code-research/GUIDE.md)를 읽기 전용 `code_researcher`에게 맡겨 현행 소유 모델, 상태, 강제 메서드, Repository, 트랜잭션의 코드 위치와 commit을 확인한다. 기존 소유자 확장을 먼저 판단한다. 실제 코드와 승인 target을 구분한다. 기존 모델이 없으면 확인한 문서·경로와 함께 해당 사실을 기록한다.
3. 확정된 BC마다 SD 분류와 규칙에 필요한 깊이로 Entity, Value Object, 외부 시스템을 정의한다. 값이 같은 두 대상을 업무상 구별하거나 값이 바뀐 뒤에도 같은 대상을 가리켜야 하는 규칙·시나리오를 Entity 근거로 인용한다. 별도 생성·수정·삭제 흐름의 유무와 식별 필요성을 각각 확인한다. Entity ID와 타입, 속성 이름·타입·업무 의미, 메서드 입력·결과·효과를 기록한다. Value Object의 구성 속성과 제약 및 포함 위치를 기록한다. 외부 소유 업무에는 실제 공개 계약을 쓴다.
4. 규칙과 업무를 읽어서 필수 모델이 선언됐는지 점검한다. 규칙 조건, 불변식·예외, 관찰 가능한 결과가 근거에 없는 경우 [공통 반환 규칙](references/deepening.md)을 따른다. 모델을 근거 없이 채우거나 별도의 규칙 목록을 쓰지 않는다.
5. 영향을 받는 용어는 [용어 생애주기](references/language-lifecycle.md)와 [공통 규칙](references/deepening.md#프로젝트-문서)에 따라 glossary와 설계 기록에 반영한다. 지속되는 결정은 ADR에 연결한다. 수정한 각 파일을 workspace artifact에 포함하여 `completed / OK`를 반환한다.

사용자가 명시적으로 형식 이동을 요청한 경우에만 [구형 문서 절차](references/template.md#구형-문서)를 적용한다. 기존 번호형 문서의 일반 재개에서는 [기존 템플릿](references/legacy-template.md)의 모델 후보·매핑 및 관련 결정 이력만 갱신한다.
