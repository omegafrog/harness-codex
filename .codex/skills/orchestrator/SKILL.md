---
name: orchestrator
description: Select workflow skills from the request and current workflow state, dispatch them, and route their structured results.
---

# orchestrator

메인 세션에서 사용자 요청과 현재 workflow 상태를 읽고 다음에 실행할 skill을 고른다. 각 skill의 작업 절차와 산출물 규칙은 해당 skill 문서가 소유한다. 이 문서에는 skill 선택과 단계 전환 기준만 둔다. 실행 호출은 [실행 조율](../../../.codex/internal-skills/skill-execution/GUIDE.md)을 따른다.

## Skill 선택

| 조건 | 선택 |
|---|---|
| 저장소에 Harness setup이 필요함 | `setup` |
| setup이 끝났고 새 사용자 작업을 시작함 | `workflow-compose` |
| 새 기능의 요구사항이나 승인이 정리되지 않음 | `spec-me` |
| 승인된 Spec은 있지만 구현 계획·티켓이 없음 | `to-ticket` |
| 승인된 계획이 있고 구현이 요청됨 | `implement-wrapper` |
| 사용자가 제품 경로의 검증 문서를 만들거나 맞춰 달라고 요청함 | `maintain-verification` |
| 사용자가 실제 서버·인프라를 사용하는 엔드유저 E2E를 요청함 | `e2e-test` |

기존 workflow 재개 요청은 새 작업으로 취급하지 않는다. hook의 검증된 후보와 요청을 대조해 현재 단계의 skill을 선택한다. 후보가 모호하면 사용자에게 선택을 묻고, 소유권이나 정본 기록이 유효하지 않으면 복구 필요 사유를 보고한다. `.io` 로그나 백업만으로 workflow 또는 worktree를 추정하지 않는다.

사용자 요청의 범위, 승인된 산출물과 완료 상태를 함께 판단한다. 요청된 종료 단계가 이미 완료됐으면 불필요한 다음 skill을 실행하지 않는다. 구현 도중 Spec 또는 계획 변경이 필요하다는 결과가 나오면 해당 산출물의 소유 skill로 돌아간다.

## 실행과 단계 전환

선택한 skill의 실행 위치는 정본 worktree 기록에서 확인한다. `worktree_ref`만 실행 입력으로 전달하고 나머지 위치 정보는 skill이 정본에서 읽게 한다. 입력 준비, 실행기 호출, 부모 대화 재개는 [실행 조율](../../../.codex/internal-skills/skill-execution/GUIDE.md)의 공통 절차를 사용한다.

반환 상태에 따라 workflow를 전환한다.

| 반환 | 처리 |
|---|---|
| `completed/OK` | 요청 범위와 workflow 상태에 따라 다음 skill을 선택한다. workflow 완료 gate가 남아 있으면 전체 완료로 보고하지 않는다. |
| `REVIEW_REQUIRED` | 반환에 명시된 reviewer/profile을 사용해 독립 리뷰를 진행하고 결과를 원래 skill에 돌려준다. 구체 절차는 해당 skill의 리뷰 계약을 따른다. |
| `SPEC_REVISION_REQUIRED` | `spec-me`를 선택한다. |
| `PLAN_REVISION_REQUIRED` | `to-ticket`을 선택한다. |
| `IMPLEMENTATION_REVISION_REQUIRED` | 영향을 받은 구현 plan의 `implement-wrapper`를 선택한다. |
| `USER_DECISION_REQUIRED` | 반환된 질문을 사용자에게 전달하고 실제 답을 요청 skill에 돌려준다. |
| `blocked` | 보고된 unblock 조건을 기다린 뒤 같은 workflow를 재개한다. |
| `running` | 실행 중복을 만들지 않는다. 실행 조율 절차로 실제 프로세스와 기존 세션을 확인한다. |
| `failed` 또는 `cancelled` | 원인과 보존된 실행 결과를 확인하고, skill의 재시도·중단 계약에 따라 라우팅한다. |

질문, 리뷰, 단계 산출물, completion receipt의 세부 형식은 이 문서에 복사하지 않는다. 실행 skill과 공통 실행 조율 계약을 따른다.
