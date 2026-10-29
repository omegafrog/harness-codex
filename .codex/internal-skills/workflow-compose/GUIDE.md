# Workflow 생성

최초 사용자 요청과 현재 산출물로 요청별 실행 workflow를 만든다. `spec-me`가 맡던 작업 worktree 준비와 Spec 작성 전 단계 구성·리뷰 순서·다음 작업 연결을 이 skill로 분리한다. 실제 Spec·plan·source 작성과 reviewer 호출은 구성 결과를 받은 메인 orchestrator가 실행한다.

## 실행 모델과 입력

기본 `model_tier`는 `low`이며 `agents.low_performance_model`과 `agents.low_performance_reasoning_effort`의 실제 값을 caller의 codex exec 실행기가 CLI에 전달한다. [공통 실행 계약](../skill-execution/GUIDE.md)을 따른다.

입력은 `execution_id`, `workspace_root`, `shared_guidance_root`, `session_directory`, 요청 원문·확정 답변·이미 존재하는 산출물의 `input_refs`, 승인된 범위다. 최초 호출에 workflow 파일이 있다고 가정하지 않는다. 기존 workflow 수정 요청이면 caller가 현재 workflow와 변경 요청을 입력으로 전달한다.

## 작업 위치 준비

입력의 `workspace_root`와 `session_directory`는 호출 시작 위치와 반환 파일 위치다. 작업 worktree 준비 요청은 workflow-compose 진입 시 실행기가 처리한다. 실행기는 원본 권한으로 기존 worktree 생성 CLI를 수행하고 `context.worktree_ref`에 canonical `worktree.json` 경로를 기록한다. 모델은 `workspace-write` sandbox로 실행된다. workflow-compose는 이 파일을 읽어 작업 위치를 확인하고 해당 cwd에서 preflight를 수행한다. 기존 작업은 같은 기록을 재사용하며, 생성 실패는 실행기에서 실패로 기록한다. worktree lifecycle의 변경과 모델의 문서 구성 실행을 분리한다.

`context.plan_set_id`는 선택 대상이 기존 Spec/plan인 orchestration에서만 전달한다. 새 Spec 작성은 이 값을 복사하지 않고, `spec-me`가 합의된 feature name에서 readable slug를 생성한 뒤 active `worktree.json`에 bind한다. 기존 Spec/plan을 대상으로 새 worktree를 만들면 대상의 `docs/specs/<id>/` 또는 `docs/plans/<id>/plans.md`에서 ID를 확인해 새 worktree 생성 CLI에 넘긴다. 현재 worktree나 다른 session의 ID를 대상 확인 없이 상속하지 않는다. 재사용 worktree에 이미 다른 ID가 있으면 중단한다. 준비 뒤 stage input은 canonical `worktree.json`의 ID를 `context.plan_set_id`에 전달한다.

준비한 파일의 `workspace`가 후속 단계의 `workspace_root`, `return_root`가 `shared_guidance_root`, `worktree.json`의 `session_directory`가 dispatched task의 `session_directory`다. 결과 `details.worktree_ref`에 이 `worktree.json`의 절대 경로를 기록한다. workflow manifest와 state는 compose를 시작한 제어 session에 남기고, 후속 stage input·결과·임시 파일은 작업 worktree session에 저장한다. `context.control_session_directory`로 제어 session을 따로 전달하고, 제어 session의 입력 참조는 `base=control_session`으로 구분한다. compose 자체의 입력·반환 session은 실행기에서 바꾸지 않는다.

## 구성 절차

1. 요청 원문과 확인된 입력을 읽고 필요한 결과와 승인 범위를 정리한다. 업무 결정이 부족하면 미확정 사항을 결과 파일에 기록하고 `USER_DECISION_REQUIRED`를 반환한다.
2. 실제 사용 가능한 skill의 entrypoint와 각 skill의 입력·산출물·반환 코드를 읽는다. 새 기능의 Product/Architecture Spec 작성은 `spec-me`, 승인된 Spec의 분할은 `to-ticket`, 승인된 plan 구현은 `implement-wrapper`, 구현 리뷰는 `code-review`, 최종 사용자 검증은 `e2e-test`로 구성한다. 버그 진단·frontend 등 요청된 독립 workflow의 경계를 유지한다. 승인되지 않은 구현·게시 단계를 실행 가능 상태로 만들지 않는다.
3. Spec 작성 뒤의 독립 Spec 리뷰, 전체 split plan 작성 뒤의 plan-review, plan별 구현·단위 테스트 뒤의 독립 구현 리뷰를 배치한다. 모든 plan 통합 뒤 최종 E2E를 배치한다. `to-ticket` 요청은 `.codex/skills/orchestrator/references/to-ticket.md`의 stage 구성과 산출물 계약을 workflow로 만든다:
   - `plan_split`: `to-ticket` / `to_ticket`; output `plan_set_draft`.
   - `plan_review`: `plan-review` / `plan_reviewer`, `needs: [plan_split]`; input `plan_set_draft`, output `plan_review_result`.
   - `plan_revision`: `to-ticket` / `to_ticket`, `needs: [plan_split, plan_review]`; inputs `plan_set_draft`, `plan_review_result`, output `plan_set_revision`.
   - `plan_finalize`: `to-ticket` / `to_ticket`, `needs: [plan_split, plan_review]`; inputs latest `plan_set_draft`, latest `plan_review_result`, output `plan_set_ready_for_implementation`.
   Orchestrator는 `plan_review` result의 `details.verdict`를 읽어 revise stage와 finalize stage를 선택하고 수정 뒤 같은 review stage를 새 fresh execution으로 반복한다. Finalize의 planning review gate가 pass와 current snapshot을 확인한다. 필요한 writer·diagram·research 단계는 실제 역할과 skill로 연결한다. 고정 YAML은 단계·gate 정의를 재사용할 때만 참고한다.
4. [workflow schema](schemas/workflow.schema.json)를 읽고 그 필드만 사용한다. 최상위는 `schema_version`, `workflow_id`, `scope`, `stages`이며 `summary`만 선택 사항이다. stage는 `id`, `skill`, `role`, `scope`, `needs`, `conditions`, `gates`, `inputs`, `outputs`를 모두 기록한다. `role`은 `.codex/agents/<role>.toml`의 실제 ID 또는 `default`다. 설명문을 role ID로 쓰지 않는다. gate는 기존 workflow/CLI가 지원하는 실제 ID를 사용한다.
   이미 존재하는 입력은 `{ "base": "workspace" | "session", "path": "실제 상대 경로" }`, 미래 입력은 `{ "from_stage": "생산 stage ID", "artifact": "생산 output ID" }`로 쓴다. `outputs`는 `{ "id": "산출물 ID", "description": "설명" }` 배열이며 worker는 이 ID를 결과 `artifacts[].kind`로 기록한다. 아직 없는 Spec 경로나 `<ticket-id>` placeholder를 읽을 입력으로 넣지 않는다. model·effort 값은 작성하지 않고 기존 binding을 참조한다. 자기 자신이나 orchestrator를 실행 stage로 넣지 않는다.
5. 전체 흐름의 누락 입력·의존성 순환·승인 전 실행·리뷰 누락을 확인한다. 구성이 완료되면 `<session_directory>/runtime/orchestrator/workflow.json`에 저장한다. 이 파일은 요청별 실행 계획이며 현재 진행 상태와 실제 agent ID는 orchestrator의 `state.json`이 관리한다.

## 반환

전체 result 객체를 Codex session response의 `result` 필드로 반환하고 `artifacts`에 `{ "kind": "request_workflow", "base": "session", "path": "runtime/orchestrator/workflow.json" }`를 넣는다. `summary`에는 구성한 범위, `details`에는 미확정 조건과 기존 workflow를 수정한 이유를 기록한다. 전체 작업 완료나 실행 승인을 뜻하지 않는다.

실행기가 inline result와 공통 envelope를 검증한다. `context.worktree_ref`는 절대 정본 참조다. workflow schema·실제 role/skill/gate·현재 입력·생산자 연결·의존성 순환을 검사하고, 검증을 통과하지 않은 workflow를 completed로 반환하지 않는다.

원문·산출물 접근이 부족하면 `INPUT_MISSING`, 사용자 결정이 필요하면 `USER_DECISION_REQUIRED`로 반환한다. 다른 작업 skill이나 reviewer를 dispatch하거나 tracker·제품 파일을 변경하지 않는다. worktree 생성·기록은 위 CLI 절차만 사용하며 workflow 채택 이후의 종료·통합은 orchestrator가 관리한다.
