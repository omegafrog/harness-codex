---
name: orchestrator
description: Coordinate workflow composition and stage execution in the main session, and decide transitions from structured status returns.
---

# orchestrator

현재 메인 세션에서 사용자 요청을 구분하고 workflow 구성 요청·stage 호출·단계 전환·사용자 질문·완료 보고를 담당한다. 각 작업 skill은 필요한 경로와 문서를 정본 기록에서 찾아 읽고 작업을 수행한다. 실행 호출은 [공통 실행 계약](../../../.codex/internal-skills/skill-execution/GUIDE.md)을 따른다.

## 시작

1. hook이 전달한 [상태 판정](references/session-state.md)과 사용자 메시지로 기존 작업 재개 또는 새 작업 시작을 결정한다. `inspect_required`이면 필요한 확인·복구 작업을 호출한다.
2. 새 작업의 요청과 승인 범위를 전달해 [workflow-compose](../../../.codex/internal-skills/workflow-compose/GUIDE.md)를 호출한다.
3. `completed / OK`이면 반환된 workflow를 요청 범위·승인 조건과 대조해 채택한다. 그 외에는 반환 코드에 따라 필요한 조치를 결정한다.

## 작업 실행

1. 실행할 workflow stage를 선택한다.
2. [stage 실행 명령](../../../.codex/internal-skills/skill-execution/GUIDE.md#workflow-stage-직접-실행)으로 해당 stage를 호출한다.
3. 반환 상태와 결과를 읽고 다음 단계·재시도·사용자 질문을 결정한다.

workflow 구성 변경이나 추가 작업이 필요하면 변경 요청을 workflow-compose에 전달하고 갱신된 workflow로 진행한다.

## 결과에 따른 판단

| 반환 | orchestrator의 처리 |
|---|---|
| `completed/OK` | workflow에서 다음 실행할 stage를 선택한다. |
| `REVIEW_REQUIRED` | workflow의 독립 reviewer stage를 호출한다. |
| `SUBTASK_REQUIRED` | 요청된 작업의 승인 범위를 확인하고 해당 stage를 호출한다. |
| `SPEC_REVISION_REQUIRED` | Spec 담당 stage로 회귀한다. |
| `PLAN_REVISION_REQUIRED` | 계획 담당 stage로 회귀한다. |
| `IMPLEMENTATION_REVISION_REQUIRED` | 관련 구현 stage로 회귀한다. |
| `USER_DECISION_REQUIRED` | 제시된 쟁점·선택지·영향·재개 조건으로 사용자에게 질문하고 [질문·답변 전달 절차](../../../.codex/internal-skills/skill-execution/GUIDE.md#질문과-답변)로 실제 답변을 담당 skill에 전달한다. |
| `blocked` | 필요한 조건의 해소를 기다리고 근거가 반환되면 재개를 결정한다. |
| `failed` | 반환된 사유와 재시도 정책에 따라 수정 작업·재실행을 결정한다. |
| `cancelled` | 실행기와 소유 lifecycle의 종료 절차를 호출한다. |

workflow의 완료 단계와 필수 gate·completion receipt가 통과한 결과를 받으면 전체 완료를 보고한다.
