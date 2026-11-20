---
model_tier: implementation
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# application-service

확정된 업무의 Use Case를 실제 모델과 포트 호출로 조합한다. [공통 절차](../domain-model/references/deepening.md)에 따라 preflight와 경로 확인을 마친 뒤 [템플릿](../domain-model/references/template.md)의 BC별 Application Service·사용 인터페이스를 채운다.

1. 요구사항의 업무별 시나리오·규칙·예외·결과·이벤트 흐름, 적용된 사용자 답변, 모델의 메서드·책임·Aggregate, 관련 ADR과 Context Map의 방향·판단 소유자를 읽는다. 외부 시스템이 업무 전체를 소유하는 BIZ는 외부 시스템의 공개 메서드와 업무 연결로 표현한다.
2. 각 로컬 Use Case 메서드는 이름·입력 타입·결과 타입과 BIZ ID를 갖는다. 번호가 있는 호출 순서로 도메인 메서드와 포트를 실제 이름으로 호출하고, 규칙 거절, 예외, 외부·저장 실패 때의 반환·후속 행동을 명시한다. 해당 판단은 규칙 책임 표의 모델에게 유지한다. 필요한 모델이나 규칙이 없으면 가장 앞선 소유 stage로 돌아간다.
3. 각 쓰기 트랜잭션은 변경 Aggregate, 호출 순서에 연결된 정확한 시작·커밋·롤백 조건과 시점을 기록한다. 트랜잭션이 없으면 이유를 기록한다. 여러 독립 트랜잭션이 있다면 순서와 부분 실패 시 업무 결과를 묶어서 기술한다.
4. 사용 포트마다 실제 이름, 입출력 시그니처, 소유 위치, 사용하는 AS ID, 실패 계약을 작성한다. 필요한 Repository, 외부 호출, 다른 BC 공개 계약, 이벤트 송신, 실제 사용되는 트랜잭션 포트만 적는다. 같은 BC 모델을 직접 호출할 때는 오케스트레이션에 호출 이름을 적는다.
5. 다른 BC의 동기 호출은 제공자 공개 계약의 입력·결과·정상 시점·실패 행동을 기록한다. 비동기 흐름은 발행과 소비를 송신자·수신자 AS에서 연결하고, 메시지 타입·발행 시점·전달 실패·중복 처리에 대한 근거를 적는다. 외부 BC의 Repository, 데이터 테이블, 내부 타입에 의존하지 않는다. 동기·비동기 선택은 기존 요구와 확정 ADR을 따른다. 업무 결과를 바꾸는 승인 근거가 부족하면 [공통 질문·반환 규칙](../domain-model/references/deepening.md#규칙-근거-확인)을 적용한다.
6. 지속되는 결정은 [공통 규칙](../domain-model/references/deepening.md#프로젝트-문서)에 따라 ADR에 기록한다. 전술 설계 및 실제로 변경한 프로젝트 문서를 workspace artifact에 기록한다.

기존 번호형 문서는 [기존 템플릿](../domain-model/references/legacy-template.md)의 Application Service 및 관련 결정 이력을 사용한다.
