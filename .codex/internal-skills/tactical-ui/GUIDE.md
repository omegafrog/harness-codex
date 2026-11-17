---
model_tier: low_performance
---
# tactical-ui

## 목적

이 stage는 UI 적용 여부와 실제 frontend workflow handoff만 관리한다. UI를 설계하거나 구현하지 않는다.

## 적용 여부

읽을 근거는 사용자의 원 요청, 완료된 tactical design, `requirements.md`, 기존 UI/routes다. UI가 없다는 이유로 API가 없다고 추론하지 않고, API가 있다는 이유로 UI가 있다고 추론하지 않는다. 사용자가 명시적으로 UI scope를 제외했거나 확정 use case와 현재 구조가 UI를 필요로 하지 않는 근거를 보이면 결과의 `summary`에 근거를 기록하고 `completed/OK`로 반환한다. 단순히 UI가 언급되지 않은 경우는 생략 근거가 아니다. 적용 여부를 판단할 수 없으면 구체적인 UX 범위를 물어 `action_required/USER_DECISION_REQUIRED`를 반환한다.

## 범위 추가 금지

이 stage는 화면·흐름을 추가하지 않는다. 화면과 흐름은 `requirements.md`의 BIZ/INV/EX/AC와 `tactical-design.md` 4절의 `AS-xx`에 추적되어야 하며, 추적되지 않는 화면(요구에 없는 로그아웃·설정·관리 화면 등)은 handoff하지 않는다. "이 화면을 범위에 포함할까요?" 같은 범위 질문도 하지 않는다. `ui-handoff.md`나 결과에 화면 표를 적는다면 `화면`·`근거` 열을 두고 행마다 `AS-xx`나 요구 ID를 적는다. 요구를 덮을 use case가 없으면 `application-service`를 owner로 `blocked/DEPENDENCY_INCOMPLETE`를 반환한다.

## 독립 workflow handoff

사용자 요청에 UI가 포함되면 새 page/view/app shell 또는 큰 UX 재설계는 `.codex/workflows/frontend-design.yaml`의 독립 workflow가 소유한다. design 단계는 ticket 분할 전에, implementation과 visual review는 ticket 발행 뒤에 수행한다. 이 요청이 frontend 작업을 명시했다면 추가 blanket approval 없이 실행한다. 대상이나 scope가 요청에서 불명확할 때만 먼저 질문한다.

이 stage는 `frontend-design`을 child stage로 실행하지 않으며, 그 결과를 만들거나 완료 상태를 대신 기록하지 않는다. 설계가 없으면 `blocked/DEPENDENCY_INCOMPLETE`를 반환한다. 이 인계 block은 `result.owner_stage`·`result.dependency_gap`을 `null`로 둔다. 앞선 전술 설계가 부족해 막힐 때는 `owner_stage`와 `dependency_gap`을 적어 orchestrator가 그 stage를 다시 열게 한다. orchestrator는 독립 workflow의 `frontend-design-brief`를 실행하고 완료된 결과를 가지고 이 stage를 feedback으로 재개한다. 재개 시 같은 workspace의 `completed/OK` design 결과와 `frontend_design_brief` artifact를 확인한다. 실패·미완료·다른 workspace의 결과는 받지 않는다.

## 산출물

결과의 `summary`에 적용 여부와 근거를 한국어로 기록한다. UI가 있으면 확인한 `frontend_design_brief` artifact를 결과의 `artifacts`에 그대로 참조한다. 구현과 visual review가 아직 완료됐다고 적지 않는다. 기존 `ui-handoff.md`는 사용자 문서이므로 수정하거나 삭제하지 않는다. 이 stage는 frontend 코드를 수정하지 않고 Product/Architecture Spec이나 `docs/contracts/`도 쓰지 않는다.
