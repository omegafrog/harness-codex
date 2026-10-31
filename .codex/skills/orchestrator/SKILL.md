---
name: orchestrator
description: Coordinate workflow composition and stage execution in the main session, and decide transitions from structured status returns.
---

# orchestrator

현재 메인 세션에서 사용자 요청을 구분하고 workflow 구성 요청·stage 호출·단계 전환·사용자 질문·완료 보고를 담당한다. 각 작업 skill은 필요한 경로와 문서를 정본 기록에서 찾아 읽고 작업을 수행한다. 실행 호출은 [정적 호출기](../../../.codex/internal-skills/static-caller/GUIDE.md)를 따른다.

## 시작

1. hook이 전달한 [상태 판정](references/session-state.md)과 사용자 메시지로 기존 작업 재개 또는 새 작업 시작을 결정한다. 재개 시 `orchestrator_session_id`와 stage별 `agent_sessions`를 사용해 기존 Codex 대화를 이어간다. `inspect_required`이면 필요한 확인·복구 작업을 호출한다.
2. 새 작업은 [setup](../setup/SKILL.md)의 진입 조건을 확인하고 필요한 경우 메인 세션에서 setup을 완료한 뒤 [workflow-compose](../../../.codex/internal-skills/workflow-compose/GUIDE.md)를 호출한다. Git의 첫 commit이 없는 상태는 초기 저장소의 정상적인 준비 상태로 판단해 setup이 처리하도록 한다. 상태 확인 명령의 예상된 부재와 실제 실행 실패를 구분하고 사용자에게서 받은 중단 조건을 따른다.
3. `completed / OK`이면 준비된 worktree를 확인하고 사용자 요청·종료 범위·승인된 산출물을 바탕으로 다음 스킬을 선택한다. 그 외에는 반환 코드에 따라 필요한 조치를 결정한다.
4. 새 worktree가 준비되면 사용자에게 그 작업 위치에서 새 Codex 세션을 열고 기존 workflow를 이어가도록 안내한다. 준비된 worktree와 기록을 보존하고, 새 세션이 시작되기 전에는 후속 작업 단계를 실행하지 않는다. 이미 해당 worktree에서 재개한 세션에는 다시 안내하지 않는다.

## 작업 실행

1. 사용자 요청과 현재 산출물·실행 결과를 확인해 스킬을 선택한다. 명세가 부족하면 `spec-me`, 계획이 부족하거나 세분화가 필요하면 `to-ticket`, 승인된 계획의 구현이 필요하면 `implement-wrapper`를 선택한다. 요청한 종료 범위와 기존 승인·리뷰를 반영한다.
2. 실행기를 호출하기 전에 `worktree_ref`가 가리키는 정본 `worktree.json`의 `workspace`를 읽어 작업 root를 확인한다. 선택한 단계를 [정적 호출기 지침](../../../.codex/internal-skills/static-caller/GUIDE.md)에 따라 그 작업 root의 실행기로 호출한다. skill 입력에는 worktree 정보로 `worktree_ref`만 전달하고 skill이 필요한 위치와 plan 식별자를 정본 기록에서 읽는다.
3. 반환 상태와 결과에 따라 다음 단계·재시도·사용자 질문을 결정한다. 각 작업의 세부 절차와 판정 기준은 해당 skill이 담당한다.

결과가 명세·계획·구현의 수정을 요구하면 근거와 영향 산출물을 보존하고 해당 소유 스킬로 회귀한다. 반복 시도에 진전이 없으면 사유를 보고한다.

## 결과에 따른 판단

상태나 code는 기존 계약을 사용한다. 내부 작업의 반환은 같은 방식으로 결과·질문·findings를 읽어 판단한다. reviewer의 보고서에 질문이 있으면 사용자 답변을 같은 세션에 전달하고, 미해결 findings는 기존 작성 작업에 전달한다. 보고서 반환 자체를 리뷰 통과나 사용자 승인으로 취급하지 않는다. 질문·리뷰를 구분하려고 추가 상태를 만들지 않는다.

| 반환 | orchestrator의 처리 |
|---|---|
| `completed/OK` | workflow에서 다음 실행할 stage를 선택한다. |
| `REVIEW_REQUIRED` | 리뷰를 요청한 작업은 독립 reviewer를 호출한다. reviewer가 findings와 함께 반환하면 결과를 읽고 기존 작업을 수정·보완하거나 결정이 필요한 쟁점을 처리한 뒤 필요한 부분을 재검토한다. 미통과 결과를 승인으로 취급하지 않는다. |
| `SUBTASK_REQUIRED` | 결과의 내부 작업을 `harness-prepare-input.mjs --subtask`로 입력을 준비해 호출하고, 성공 결과는 `--subtask-result`로 부모 stage 입력에 전달해 재개한다. |
| `SPEC_REVISION_REQUIRED` | Spec 담당 stage로 회귀한다. |
| `PLAN_REVISION_REQUIRED` | 계획 담당 stage로 회귀한다. |
| `IMPLEMENTATION_REVISION_REQUIRED` | 관련 구현 stage로 회귀한다. |
| `USER_DECISION_REQUIRED` | 제시된 쟁점·선택지·영향·재개 조건으로 사용자에게 질문하고 [질문 스키마](../../../.codex/internal-skills/skill-execution/schemas/question.schema.json)에 맞는 질문을 확인하고 실제 답변을 담당 skill에 전달한다. |
| `blocked` | 필요한 조건의 해소를 기다리고 근거가 반환되면 재개를 결정한다. |
| `failed` | 반환된 사유와 재시도 정책에 따라 수정 작업·재실행을 결정한다. |
| `cancelled` | 실행기와 소유 lifecycle의 종료 절차를 호출한다. |

workflow의 완료 단계와 필수 gate·completion receipt가 통과한 결과를 받으면 전체 완료를 보고한다.
