---
model_tier: low_performance
---
# tactical-ui

## 목적

이 stage는 UI 적용 여부와 실제 frontend workflow handoff만 관리한다. UI를 설계하거나 구현하지 않는다.

## 적용 여부

읽을 근거는 사용자의 원 요청, 완료된 tactical design, `requirements.md`, 기존 UI/routes다. UI가 없다는 이유로 API가 없다고 추론하지 않고, API가 있다는 이유로 UI가 있다고 추론하지 않는다. 사용자가 명시적으로 UI scope를 제외했거나 확정 use case와 현재 구조가 UI를 필요로 하지 않는 근거를 보이면 `docs/implementation/<plan-set-id>/ui-handoff.md`에 근거를 기록하고 `completed/OK`로 반환한다. 단순히 UI가 언급되지 않은 경우는 생략 근거가 아니다. 적용 여부를 판단할 수 없으면 구체적인 UX 범위를 물어 `action_required/USER_DECISION_REQUIRED`를 반환한다.

## 독립 workflow handoff

사용자 요청에 UI가 포함되면 새 page/view/app shell 또는 큰 UX 재설계는 `.codex/workflows/frontend-design.yaml`의 독립 workflow가 소유한다. 해당 workflow의 자체 `frontend-design` GUIDE, prerequisites, design → implementation → visual review → correction loop를 따른다. 이 요청이 frontend 작업을 명시했다면 추가 blanket approval 없이 실행한다. 대상이나 scope가 요청에서 불명확할 때만 먼저 질문한다.

이 stage는 `frontend-design`을 child stage로 실행하지 않으며, 그 결과를 만들거나 완료 상태를 대신 기록하지 않는다. 별도 workflow가 아직 실행 중이거나 결과를 받지 못했으면 `blocked/DEPENDENCY_INCOMPLETE`로 frontend workflow의 exact status/result reference를 기다린다. 재개 시 독립 workflow가 실제 `completed/OK` 및 visual review를 기록했는지, 전달된 workspace/branch/result reference가 현재 worktree와 일치하는지 확인한다. 실패·미완료·다른 workspace의 결과는 handoff로 받지 않는다.

## 산출물

모든 경우 `docs/implementation/<plan-set-id>/ui-handoff.md`에 적용 여부와 근거를 한국어로 기록한다. UI가 없으면 판단 근거만 기록한다. UI가 있으면 별도 `frontend-design` completion evidence, user flow, 구현 경로와 visual review result를 참조한다. 실제 결과 전에는 완료로 적지 않는다. 실행기가 완료 시 이 stage 소유 handoff 문서만 자동 commit한다. 이 stage는 frontend 코드를 수정하지 않고 Product/Architecture Spec이나 `docs/contracts/`도 쓰지 않는다.
