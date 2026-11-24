---
model_tier: low_performance
---
# tactical-api

실행 배정에 `document_draft_root`가 있으면 완성한 문서를 그 아래의 같은 상대 경로에 직접 쓴다. 실행기가 gate 통과 후 그 바이트를 정본에 반영한다. 결과에는 정본의 상대 경로를 적는다.

## 목적

전술 설계와 기술 선택을 구현 가능한 application entry/API 계약으로 좁힌다. 제품에 외부 또는 내부 호출 경계가 필요할 때만 계약을 작성한다.

## 입력과 진행

사용자 요청, 완료된 tactical design, 앞선 `tactical-technology`와 `tactical-ui` 결과, 현재 저장소의 entry point/API를 확인한다. preflight를 실행해 workspace와 project readiness를 확인하고 실패하면 편집하지 않는다. 기존 공개 경로와 호출 규약을 재사용한다.

`tactical-ui`가 브리프를 참조한 경우에만 그 브리프를 입력으로 사용한다. 이번 실행에서 UI가 미적용 또는 보류이면 승인된 Application Service를 근거로 API 계약을 정한다. 구현과 visual review는 ticket 발행 뒤 수행하므로 이 단계에서 완료를 요구하지 않는다.

UI, application entry 또는 API가 필요한지 사용자 요청이나 전술 설계가 확정하지 않으면 한 번에 묻는다. 명시적 요청, 전술 설계 또는 관찰한 기존 application 구조가 적용되지 않음을 보일 때만 근거를 남기고 생략한다. 계약은 method/path/message, request/response, 오류, 입력 검증과 필요한 인증·권한만 포함하며 새 업무 규칙을 발명하지 않는다. 정하지 못한 경계를 `unknown`·`미정`·`TBD`로 남기지 않는다. 사용자 결정이면 묻고 앞선 stage 몫이면 owner stage로 반환한다. 이 계획이 다루지 않는 항목은 `범위 밖:`으로 시작해 적어야 placeholder 검사가 통과시킨다. endpoint가 호출하는 Application Service 메서드 이름과 소유 컨텍스트를 기록한다. 해당 메서드가 사용하는 outbound 인터페이스의 구현과 조립은 `data.md`에서 정한다.

## 범위 추가 금지

이 stage는 기능을 추가하지 않는다. endpoint·message마다 `tactical-design.md` 컨텍스트별 Application Service 메서드(`AS-xx`)가 이미 있어야 하고 그 AS가 다루는 `requirements.md`의 BIZ/INV/EX/AC에 추적되어야 한다. 추적되지 않는 endpoint(예: 요구에 없는 로그아웃·세션 조회·관리 기능)는 만들지 않고, "이 기능을 범위에 포함할까요?" 같은 범위 질문도 하지 않는다. 범위 변경은 사용자가 명시적으로 다시 시작하는 요구사항 흐름의 일이다. 기존 요구사항을 다룰 endpoint나 use case가 빠졌으면 설계 빈틈이므로 owner stage(use case가 없으면 `application-service`)로 `blocked/DEPENDENCY_INCOMPLETE`를 반환한다.

endpoint 표에는 반드시 `근거` 열을 둔다. 각 행은 그 endpoint가 호출하는 `AS-xx`와 요구 ID를 적는다. 예: `| Method / path | 요청 | 성공 응답 | 근거 |` 행의 근거는 `AS-02 (BIZ-02, INV-03)`. 실행기는 이 stage가 완료될 때 `api.md`의 placeholder와 근거 누락(`UNTRACED_ITEM`·`REQUIREMENT_UNCOVERED`)을 먼저 확인하고, `tactical-data`가 완료될 때 `harness-design-freeze-check.mjs`로 모든 행의 `AS-xx`가 전술 설계에 있고 요구 ID가 `requirements.md`에 있는지 확인하며, 없으면 `UNTRACED_ITEM`(owner `tactical-api`)으로 이 stage를 다시 연다.

## 산출물

적용 범위, 근거와 계약을 `docs/implementation/<plan-set-id>/api.md`에 한국어로 기록한다. UI design이 있으면 해당 design artifact를 인용한다. UI/API가 없으면 판단 근거를 기록한다. 질문은 `action_required/USER_DECISION_REQUIRED`, 앞선 전술 설계나 frontend design이 부족하면 `blocked/DEPENDENCY_INCOMPLETE`로 반환한다. 이 block은 `result.owner_stage`(빈틈을 소유한 가장 앞 stage)와 `result.dependency_gap`(그 stage가 추가하거나 고쳐야 할 내용과 근거)을 반드시 적는다. 없으면 실행기가 반려하며, 있으면 orchestrator가 사용자에게 묻지 않고 그 stage를 다시 열어 이 stage까지 순서대로 다시 진행한다. 실행기가 완료 시 이 stage 소유 문서만 자동 commit한다. 이 stage는 Spec과 `docs/contracts/`를 쓰지 않는다.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .harness/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 설계에 사용한 공통 정의의 ID를 근거로 남기고 범위는 확정 요구사항을 따른다.
