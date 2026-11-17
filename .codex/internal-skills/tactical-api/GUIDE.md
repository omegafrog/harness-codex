---
model_tier: low_performance
---
# tactical-api

## 목적

전술 설계와 기술 선택을 구현 가능한 application entry/API 계약으로 좁힌다. 제품에 외부 또는 내부 호출 경계가 필요할 때만 계약을 작성한다.

## 입력과 진행

사용자 요청, 완료된 tactical design, 앞선 `tactical-technology`와 `tactical-ui` 결과, 현재 저장소의 entry point/API를 확인한다. preflight를 실행해 workspace와 project readiness를 확인하고 실패하면 편집하지 않는다. 기존 공개 경로와 호출 규약을 재사용한다.

새 page/view/app shell 또는 큰 UX 재설계가 범위에 있고, frontend-design prerequisites가 충족되면 `.codex/workflows/frontend-design.yaml`을 별도 workflow로 실행한다. 사용자가 이 scope를 요청했으면 실행을 진행하고 추가 승인을 묻지 않는다. 그 workflow의 implementation과 visual review 단계가 완료된 뒤 실제 handoff를 입력으로 사용한다. prerequisite가 충족되지 않거나 결과를 받지 못하면 차단하며, 수행됐다고 주장하지 않는다.

UI, application entry 또는 API가 필요한지 사용자 요청이나 전술 설계가 확정하지 않으면 한 번에 묻는다. 명시적 요청, 전술 설계 또는 관찰한 기존 application 구조가 적용되지 않음을 보일 때만 근거를 남기고 생략한다. 계약은 method/path/message, request/response, 오류, 입력 검증과 필요한 인증·권한만 포함하며 새 업무 규칙을 발명하지 않는다. 정하지 않은 경계는 미정으로 둔다.

## 산출물

적용 범위, 근거와 계약을 `docs/implementation/<plan-set-id>/api.md`에 한국어로 기록한다. UI handoff가 있으면 해당 frontend-design workflow result와 구현된 경로만 인용한다. UI/API가 없으면 판단 근거를 기록한다. 질문은 `action_required/USER_DECISION_REQUIRED`, 앞선 전술 설계나 frontend handoff가 부족하면 `blocked/DEPENDENCY_INCOMPLETE`로 반환한다. 실행기가 완료 시 이 stage 소유 문서만 자동 commit한다. 이 stage는 Spec과 `docs/contracts/`를 쓰지 않는다.
