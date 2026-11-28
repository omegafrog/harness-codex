---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# domain-model

실행 배정에 `document_draft_root`가 있으면 완성한 문서를 그 아래의 같은 상대 경로에 직접 쓴다. 실행기가 gate 통과 후 그 바이트를 정본에 반영한다. 결과에는 정본의 상대 경로를 적는다.

`bounded-context`가 확정한 요구사항을 BC별 도메인 모델로 옮긴다. [공통 절차](references/deepening.md)에 따라 입력의 준비 상태를 확인한 뒤 [전술 설계 템플릿](references/template.md)의 모델 표를 채운다.

1. 요청 원문, 확정된 `requirements.md`의 BIZ·INV·EX·AC·이벤트·SD·BC, 적용된 사용자 답변, `CONTEXT.md`와 `CONTEXT-MAP.md`, 기존 프로젝트 모델·연결된 ADR을 읽는다. 앞 단계가 확정한 BC 경계와 용어를 사용한다.
2. `context.workspace.source`에 추적된 소스가 있으면 직접 검색하지 않고 [code-research](../code-research/GUIDE.md)를 읽기 전용 `code_researcher`에게 맡겨 현행 소유 모델, 상태, 강제 메서드, Repository, 트랜잭션을 확인한다. 기존 소유자 확장을 먼저 판단하고 실제 코드와 승인 target을 구분한다. 조사 내역은 전술 설계 본문에 옮기지 않는다. 설계 판단을 이해하는 데 필요한 기존 제약이나 현재 구현과의 차이만 간결히 기록한다.
3. 확정된 BC마다 SD 분류와 규칙에 필요한 깊이로 Entity, Value Object, 외부 시스템을 정의한다. 정체성과 생애주기, 식별 필요성을 확인해 종류를 정한다. Entity ID와 타입, 속성 이름·타입·업무 의미, 메서드 입력·결과·효과를 기록한다. Value Object의 구성 속성과 제약 및 포함 위치를 기록한다. 외부 소유 업무에는 실제 공개 계약을 쓴다. 판단 과정이나 요구사항 인용을 별도 문단으로 반복하지 않는다.
4. 규칙과 업무를 읽어서 필수 모델이 선언됐는지 점검한다. 규칙 조건, 불변식·예외, 관찰 가능한 결과가 근거에 없는 경우 [공통 반환 규칙](references/deepening.md)을 따른다. 모델을 근거 없이 채우거나 별도의 규칙 목록을 쓰지 않는다. 요구사항이 업무 사실(어떤 데이터인지, 누구 소유인지, 규칙)을 말하면 단위·필드·형식·Aggregate 배치는 `domain-model`이 직접 정하고 이를 이유로 `requirements-fix`에 `DEPENDENCY_INCOMPLETE`를 반환하지 않는다. 업무 규칙 자체가 없을 때만 반환한다.
5. 영향을 받는 프로젝트 모델 행과 용어 및 지속되는 결정을 [공통 규칙](references/deepening.md#프로젝트-문서)에 따라 갱신한다. 수정한 각 파일을 workspace artifact에 포함하여 `completed / OK`를 반환한다.

사용자가 명시적으로 형식 이동을 요청한 경우에만 [구형 문서 절차](references/template.md#구형-문서)를 적용한다. 기존 번호형 문서의 일반 재개에서는 [기존 템플릿](references/legacy-template.md)의 모델 후보·매핑 및 관련 결정 이력만 갱신한다.
