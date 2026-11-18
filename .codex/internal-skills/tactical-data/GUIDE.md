---
model_tier: low_performance
---
# tactical-data

## 목적

요청된 application state가 있을 때에만 저장 소유권과 data/storage 계약을 결정한다.

## 입력

요청, 완료된 tactical design, `tactical-technology`와 `tactical-api` 결과, 현재 모델·저장소·database migration 관례를 읽는다. preflight를 실행해 workspace와 project readiness를 확인한다. 기존 domain owner, table/schema, repository와 transaction convention을 먼저 재사용한다.

전술 설계와 요청 또는 현재 codebase 근거로 상태 저장이 필요 없다는 점이 명확하면 근거를 기록하고 stage를 완료한다. 단순히 사용자가 저장소를 언급하지 않았다는 이유로 생략하지 않는다. 필요 여부가 불분명하거나 선택이 data retention, privacy, consistency, 비용, 장애 복구를 바꾸면 그 결정만 질문한다. storage technology는 앞선 선택에 명시적으로 있지 않으면 새로 고르지 않는다. 기존 저장소/table에 대한 근거 없이 write path를 만들지 않는다.

## 범위 추가 금지

이 stage는 기능을 추가하지 않는다. 저장할 entity·값은 `tactical-design.md` 4절의 `AS-xx` 또는 `requirements.md`의 BIZ/INV/EX/AC에 추적되어야 하며 추적되지 않는 상태는 만들지 않는다. 범위 질문("이 데이터를 저장할까요?" 같은 기능 포함 여부)은 하지 않는다. `data.md`의 저장 상태 표(`소유 컨텍스트`, `저장 상태`, `최소 값 및 제약`)에는 `근거` 열을 두고 행마다 `AS-xx`나 요구 ID를 적는다.

이 stage는 마지막 구현 설계 stage이므로 완료 시 실행기가 design-freeze gate(`node .codex/scripts/harness-design-freeze-check.mjs --workspace-root <absolute workspace root>`)를 한 번 실행한다. `api.md` endpoint가 `AS-xx`·요구 ID에 추적되는지(`UNTRACED_ITEM`), 모든 BIZ가 `AS-xx` use case와(사용자 행위자가 있으면) endpoint·화면에 연결되는지(`REQUIREMENT_UNCOVERED`)를 본다. 오류의 `owner_stage`가 이 stage이면 `data.md`만 고치고, 앞 stage이면 `blocked/DEPENDENCY_INCOMPLETE`로 `owner_stage`·`dependency_gap`을 적어 반환한다(추적되지 않는 항목은 그 소유 stage가 제거하고, 덮이지 않은 요구는 소유 stage가 추가한다). 통과하면 설계는 확정되어 `to-ticket`이 시작할 수 있다.

## 산출물

매번 `docs/implementation/<plan-set-id>/data.md`에 적용 범위와 근거를 기록한다. 필요하면 데이터 소유자, 필요한 entity/value shape, 저장·일관성 경계, migration/retention 제약을 포함한다. 적용이 없으면 사용자 요청·전술 설계 또는 관찰한 codebase 근거를 남긴다. 질문은 한 묶음의 `action_required/USER_DECISION_REQUIRED`; 입력 누락은 `blocked/INPUT_MISSING`으로 반환한다. 실행기가 완료 시 이 stage 소유 문서만 자동 commit한다. 업무 규칙이나 Spec 문서를 만들지 않는다.

앞선 전술 설계 stage의 산출물이 부족해 진행할 수 없으면 `blocked/DEPENDENCY_INCOMPLETE`로 반환하고 `result.owner_stage`(빈틈을 소유한 가장 앞 stage)와 `result.dependency_gap`(그 stage가 추가하거나 고쳐야 할 내용과 근거)을 반드시 적는다. 실행기는 둘이 없으면 반려하며, orchestrator가 사용자에게 묻지 않고 그 stage를 다시 열어 이 stage까지 순서대로 다시 진행한다. 업무 결정이 필요하면 이 코드가 아니라 `USER_DECISION_REQUIRED` 질문을 쓴다.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .codex/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 설계에 사용한 공통 정의의 ID를 근거로 남기고 범위는 확정 요구사항을 따른다.
