---
model_tier: low_performance
---
# tactical-ui

## 목적

이 stage는 UI 적용 여부와 실제 frontend workflow handoff만 관리한다. UI를 설계하거나 구현하지 않는다.

## 적용 여부

읽을 근거는 사용자의 원 요청, 완료된 tactical design, `requirements.md`, 기존 UI/routes다. UI가 없다는 이유로 API가 없다고 추론하지 않고, API가 있다는 이유로 UI가 있다고 추론하지 않는다. 사용자가 이번 실행에서 UI를 제외·보류했거나 승인된 작업 계획에 UI 변경이 없거나 확정 use case와 현재 구조가 UI를 필요로 하지 않는 근거를 보이면, 결과의 `summary`에 근거를 기록하고 `completed/OK`로 반환한다. 이 경우 프런트엔드 스킬을 호출하거나 브리프를 참조하지 않는다. UI 보류는 이번 실행 범위에만 적용하며 제품 요구사항은 유지한다. 단순히 UI가 언급되지 않은 경우는 생략 근거가 아니다. 적용 여부를 판단할 수 없으면 구체적인 UX 범위를 물어 `action_required/USER_DECISION_REQUIRED`를 반환한다.

## 범위 추가 금지

이 stage는 화면·흐름을 추가하지 않는다. 화면과 흐름은 `requirements.md`의 BIZ/INV/EX/AC와 `tactical-design.md`의 Application Service 메서드(`AS-xx`)에 추적되어야 하며, 추적되지 않는 화면(요구에 없는 로그아웃·설정·관리 화면 등)은 handoff하지 않는다. "이 화면을 범위에 포함할까요?" 같은 범위 질문도 하지 않는다. `ui-handoff.md`나 결과에 화면 표를 적는다면 `화면`·`근거` 열을 두고 행마다 `AS-xx`나 요구 ID를 적는다. 요구를 덮을 use case가 없으면 `application-service`를 owner로 `blocked/DEPENDENCY_INCOMPLETE`를 반환한다.

## 독립 workflow handoff

사용자 요청에 UI가 포함되면 새 page/view/app shell 또는 큰 UX 재설계는 `.codex/workflows/frontend-design.yaml`의 독립 workflow가 소유한다. design 단계는 ticket 분할 전에, implementation과 visual review는 ticket 발행 뒤에 수행한다. 신규 화면·흐름의 방향이 요청이나 승인된 계획에 구체적으로 정해져 있으면 그 결정을 재사용한다. 미정이면 먼저 사용자와 기존 요구사항이 다루는 핵심 화면과 흐름을 합의한다. 제품이 웹 앱이라는 사실만으로 화면·흐름이 합의됐다고 판단하지 않는다.

이 stage는 `frontend-design`을 child stage로 실행하지 않으며, 그 결과를 만들거나 완료 상태를 대신 기록하지 않는다. 설계가 없으면 `blocked/DEPENDENCY_INCOMPLETE`를 반환한다. 이 인계 block은 `result.owner_stage`·`result.dependency_gap`을 `null`로 둔다. 앞선 전술 설계가 부족해 막힐 때는 `owner_stage`와 `dependency_gap`을 적어 orchestrator가 그 stage를 다시 열게 한다. orchestrator는 핵심 화면·흐름을 합의한 실제 사용자 답을 `--approval-answer`로 넘겨 독립 workflow의 `frontend-design-brief`를 실행하고 완료된 결과로 이 stage를 feedback 재개한다. 브리프가 끝나기 전에 UI가 보류되면 해당 실행의 종료를 확인하고, 사용자의 보류 원문을 `--feedback`으로 넘겨 이 stage에서 이번 실행의 UI 미적용을 기록한다. 재개 시 같은 workspace의 `completed/OK` design 결과와 `frontend_design_brief` artifact를 확인한다. 실패·미완료·다른 workspace의 결과는 받지 않는다.

## 산출물

결과의 `summary`에 적용 여부와 근거를 한국어로 기록한다. UI가 있으면 확인한 `frontend_design_brief` artifact를 결과의 `artifacts`에 그대로 참조한다. 구현과 visual review가 아직 완료됐다고 적지 않는다. 기존 `ui-handoff.md`는 사용자 문서이므로 수정하거나 삭제하지 않는다. 이 stage는 frontend 코드를 수정하지 않고 Product/Architecture Spec이나 `docs/contracts/`도 쓰지 않는다.

## 공통 도메인 조회

입력의 `domain_context_pack`이 있으면 필요한 후보부터 확인한다. 상세는 `node .codex/scripts/harness-domain.mjs get <ID>...`로 일괄 조회하고 후보가 부족하면 `discover` 또는 `search`로 범위를 넓힌다. 설계에 사용한 공통 정의의 ID를 근거로 남기고 범위는 확정 요구사항을 따른다.
