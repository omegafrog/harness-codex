---
name: implement-wrapper
description: Implement one approved split plan in the orchestrator-selected workspace and return status with file-backed implementation evidence.
---

# implement-wrapper

orchestrator가 선택한 승인 plan 하나를 구현한다. 구현 절차는 [implement GUIDE](../../../.codex/internal-skills/implement/GUIDE.md)를 따른다.

## 실행 계약

기본 `model_tier`는 `implementation`이다. `agents.implementation_model`과 `agents.implementation_reasoning_effort`의 실제 값은 orchestrator가 [공통 실행 계약](../../../.codex/internal-skills/skill-execution/GUIDE.md)에 따라 spawn에 전달한다.

세션 입력의 `input_refs`에서 승인된 plan·Spec 산출물을 읽고 `context.producer_results`와 `context.previous_result`에서 이전 실행 결과를 확인한다. plan 경로는 runtime plan-review gate가 반환한 정확한 `plan_reference`를 사용한다. ID나 디렉터리명으로 경로를 다시 만들지 않는다.

`workspace_root`를 모든 명령의 cwd로 사용한다. 소유 worktree의 branch·복구·등록 정보가 필요하면 전달된 `session_directory/worktree.json`을 읽는다. 작업 위치 배정과 worktree lifecycle은 orchestrator가 관리한다.

## 구현

1. 원본 프로젝트의 `shared_guidance_root`에서 implementation/testing guidance를 읽고, 승인 plan의 요구 ID·수용 조건·구현 범위와 대조한다. 두 루트가 같은 Git 저장소인지 확인한다.
2. 전달된 fixed point와 기존 checkpoint를 보존하고 해당 plan만 구현한다. plan에서 지정한 비즈니스 로직 단위 테스트를 작성·실행한다. 테스트 작성은 [testing guidance](../../../.codex/internal-skills/testing-guidance/GUIDE.md), 실행은 EXEC의 기본 CLI 명령을 따른다. `harness-exec`는 최종 사용자 흐름 E2E에만 사용한다.
3. 요구별 변경 파일·검증 파일·실행 receipt와 commit을 기존 traceability/checkpoint 형식으로 기록한다. 이전 실패·측정 근거를 보존한다.
4. 상세 결과 객체를 공통 envelope의 `result` 필드로 반환한다. 실행기가 이를 검증하고 복구 경로에 보존한다.

## Traceability에서 받는 정보

runtime의 `plan_review` gate가 승인된 입력의 현재성을 검사한다. 구현자가 받는 값은 다음과 같다.

- `plan_reference`, `product_spec_path`, `architecture_spec_path`: 실제 읽을 승인 문서.
- `requirement_ids`: 이 plan이 구현할 요구.
- `verification_files`, `verification_command`: 계획된 검증 파일과 직접 실행할 기본 CLI 명령. E2E profile은 parent plan에만 둔다.
- `canonical_plan`, `review_snapshot_sha256`: 리뷰한 plan과 현재 입력의 일치 근거.

이 값은 문서 연결·snapshot·실행 증거를 확인하는 데 사용한다. 업무 규칙의 의미적 완전성은 독립 리뷰가 판단한다. gate 차단 사유는 inline result에 보존하고 orchestrator에 반환한다.

## 반환

구현과 단위 테스트를 마치면 `action_required/REVIEW_REQUIRED`로 반환하고 fixed point·commit·검증 근거의 파일 참조를 남긴다. orchestrator가 독립 구현 리뷰와 plan 완료를 관리한다.

Spec 변경은 `SPEC_REVISION_REQUIRED`, plan 재분할·수정은 `PLAN_REVISION_REQUIRED`, 사용자 결정은 `USER_DECISION_REQUIRED`로 반환한다. 환경·권한·의존성 부족과 실행 오류는 공통 계약의 blocked/failed 코드로 반환한다. 선택한 scope만으로 작업이 완료되는 호출은 `completed/OK`를 사용할 수 있으며 전체 workflow 완료를 뜻하지 않는다.
