---
model_tier: low_performance
---
# tactical-data

실행 배정에 `document_draft_root`가 있으면 완성한 문서를 그 아래의 같은 상대 경로에 직접 쓴다. 실행기가 gate 통과 후 그 바이트를 정본에 반영한다. 결과에는 정본의 상대 경로를 적는다.

## 목적

요청된 application state의 저장 계약과 바운디드 컨텍스트의 outbound 인터페이스를 실행 코드에 연결할 구현 계약을 확정한다. 저장 상태가 없어도 외부 시스템 또는 다른 컨텍스트를 호출하면 그 인터페이스의 구현 계약을 작성한다.

## 입력

요청, 완료된 tactical design, `tactical-technology`와 `tactical-api` 결과, 현재 모델·저장소·database migration 관례를 읽는다. `context.workspace.preflight.valid`가 `false`이면 차단한다. 현행 모델·저장소·migration 조사는 [code-research](../code-research/GUIDE.md)로 `code_researcher`에게 맡긴다. 기존 domain owner, table/schema, repository와 transaction convention을 먼저 재사용한다.

디자인 freeze 전에 `technology.md`가 tactical-technology 체크리스트의 모든 적용 항목을 정했는지 확인한다. 특히 구현에 필요한 runtime·언어·framework, 저장소 client/driver, 테스트 도구·실행 CLI가 비었거나 `미정`이면 `blocked/DEPENDENCY_INCOMPLETE`로 `result.owner_stage: tactical-technology`와 구체적인 `result.dependency_gap`을 반환해 발행 전에 소유 stage를 다시 열게 한다. 해당 없는 영역은 근거를 확인하며 여기서 임의로 기술을 고르지 않는다.

전술 설계와 요청 또는 현재 codebase 근거로 상태 저장이 필요 없다는 점이 명확하면 근거를 기록한다. 단순히 사용자가 저장소를 언급하지 않았다는 이유로 생략하지 않는다. 필요 여부가 불분명하거나 선택이 data retention, privacy, consistency, 비용, 장애 복구를 바꾸면 그 결정만 질문한다. 저장 기술의 필수 결정이 빠졌으면 그 결정을 소유한 `tactical-technology`로 빈틈을 반환한다.

## 인프라 바인딩

`tactical-design.md`의 컨텍스트별 `인터페이스` 표와 `사용 인터페이스`를 실제 Application Service 메서드에서 대조한다. 저장 Aggregate를 읽고 쓰는 Repository, 외부·다른 컨텍스트를 호출하거나 이벤트를 발행하는 인터페이스를 연결한다. 트랜잭션은 기존 실행 경계로 충분한지 확인하고 설계가 실제 사용을 정한 경우만 별도 인터페이스를 연결한다. 기존 공개 인터페이스·구현·조립을 먼저 찾아 그대로 쓸 수 있는지 확인한다. 필요한 인터페이스가 설계에 빠졌으면 소유 stage로 빈틈을 반환한다.

컨텍스트별 형식(`<!-- tactical-design: context-components-v1 -->`)의 `data.md`에 `## 인프라 바인딩`을 만들고, 사용하는 인터페이스마다 다음 열로 한 행을 작성한다.

| 컨텍스트 | 인터페이스 | 시그니처 | 소유 위치 | 사용 메서드 | 실패 계약 | 인터페이스 경로 | 구현체 | 구현체 경로 | 기술·구현 선언 | 조립 위치 | 데이터 매핑 | 트랜잭션 공유 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

- `컨텍스트`는 BC ID다. 인터페이스 이름, 시그니처, 소유 위치, 사용 메서드(AS ID 및 메서드), 실패 계약은 전술 설계 표의 값을 그대로 옮긴다. 구현체는 해당 시그니처와 실패 계약을 구현한다.
- `인터페이스 경로`와 `구현체 경로`는 저장소 상대 파일 경로다. 관례상 같은 파일이면 같은 경로를 적는다. `구현체`에는 구체 타입, 함수, 모듈이나 framework 선언에서 쓰는 이름을 적는다.
- `기술·구현 선언`에 선택 기술과 구현이 사용하는 구체 선언(예를 들어 Query/ORM·외부 클라이언트 API·메시지 publisher), `조립 위치`에는 적용할 실제 상대 파일 경로와 factory·등록 심볼 등 연결 지점을 적는다. 기존 구현을 재사용할 때도 같은 위치를 적는다.
- `데이터 매핑`에 도메인 타입과 저장 필드 또는 송수신 계약, 구현체가 변환하는 오류를 적는다. `트랜잭션 공유`에 시작·종료 위치와 공유하는 세션·client·transaction 또는 독립 호출 근거를 적는다. 해당 사항이 없으면 그 열에 `해당 없음 — <근거>`를 적는다.
- outbound 인터페이스가 없으면 `## 인프라 바인딩` 아래에 표 없이 `- 판정: 해당 없음 — <근거>`를 적는다. 저장 여부는 본문에 따로 적는다.

## 범위 추가 금지

이 stage는 기능을 추가하지 않는다. 저장할 entity·값은 `tactical-design.md`의 Application Service 메서드(`AS-xx`) 또는 `requirements.md`의 BIZ/INV/EX/AC에 추적되어야 하며 추적되지 않는 상태는 만들지 않는다. 범위 질문("이 데이터를 저장할까요?" 같은 기능 포함 여부)은 하지 않는다. `data.md`의 저장 상태 표(`소유 컨텍스트`, `저장 상태`, `최소 값 및 제약`)에는 `근거` 열을 두고 행마다 `AS-xx`나 요구 ID를 적는다. Aggregate를 저장하는 행에는 사용하는 Repository 인터페이스도 인용한다.

이 stage는 마지막 구현 설계 stage이므로 완료 시 실행기가 design-freeze gate(`node .harness/scripts/harness-design-freeze-check.mjs --workspace-root <absolute workspace root>`)를 한 번 실행한다. `api.md` endpoint가 `AS-xx`·요구 ID에 추적되는지(`UNTRACED_ITEM`), 모든 BIZ가 `AS-xx` use case와(사용자 행위자가 있으면) endpoint·화면에 연결되는지(`REQUIREMENT_UNCOVERED`), 컨텍스트별 설계의 각 인터페이스에 추적 가능한 구현 계약이 있는지(`INFRASTRUCTURE_BINDING_*`)를 본다. 오류의 `owner_stage`가 이 stage이면 `data.md`만 고치고, 앞 stage이면 `blocked/DEPENDENCY_INCOMPLETE`로 `owner_stage`·`dependency_gap`을 적어 반환한다(추적되지 않는 항목은 그 소유 stage가 제거하고, 덮이지 않은 요구는 소유 stage가 추가한다). 통과하면 설계는 확정되어 `to-ticket`이 시작할 수 있다.

## 산출물

매번 `docs/implementation/<plan-set-id>/data.md`에 적용 범위와 근거 및 인프라 바인딩을 기록한다. 필요하면 데이터 소유자, 필요한 entity/value shape, 저장·일관성 경계, migration/retention 제약을 포함한다. 적용이 없으면 사용자 요청·전술 설계 또는 관찰한 codebase 근거를 남긴다. 질문은 한 묶음의 `action_required/USER_DECISION_REQUIRED`로 반환한다. 입력 누락은 `blocked/INPUT_MISSING`으로 반환한다. 실행기가 완료 시 이 stage 소유 문서만 자동 commit한다. 업무 규칙이나 Spec 문서를 만들지 않는다.

앞선 전술 설계 stage의 산출물이 부족해 진행할 수 없으면 `blocked/DEPENDENCY_INCOMPLETE`로 반환하고 `result.owner_stage`(빈틈을 소유한 가장 앞 stage)와 `result.dependency_gap`(그 stage가 추가하거나 고쳐야 할 내용과 근거)을 반드시 적는다. 실행기는 둘이 없으면 반려하며, orchestrator가 사용자에게 묻지 않고 그 stage를 다시 열어 이 stage까지 순서대로 다시 진행한다. 업무 결정이 필요하면 이 코드가 아니라 `USER_DECISION_REQUIRED` 질문을 쓴다.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .harness/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 설계에 사용한 공통 정의의 ID를 근거로 남기고 범위는 확정 요구사항을 따른다.
