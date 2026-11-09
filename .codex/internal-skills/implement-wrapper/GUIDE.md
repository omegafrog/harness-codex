
# implement-wrapper

plan 구현 중에는 최종 E2E의 실행 조건이나 환경을 사용자에게 묻거나 정하지 않는다. 최종 E2E는 마지막 `e2e` plan이 Spec의 시나리오(Product 13절)와 환경(Architecture 12.7)으로 테스트와 profile을 만들고, 모든 plan 구현과 통합 리뷰 뒤 fresh runner가 한 번 실행한다. `e2e` plan을 구현할 때도 E2E를 직접 실행하지 않는다. 구현하면서 알게 된 앱 실행 사실(실행 명령, 필요한 설정 키와 기본값, 의존 서비스)은 `docs/agents/EXEC.md`에 기록만 한다.

입력의 `context.plan_id`로 배정된 승인 plan 하나만 구현한다. 코드만 고치는 수정 재개(feedback에 `implementation-only`로 표시)에서는 plan 문서를 바꾸지 않고, 고친 내용을 `harness-tracker.mjs comment`로 Issue에만 기록한다. 다른 plan을 스스로 고르지 않는다. 배정된 plan이 이미 `Done`이면 변경 없이 그 사실을 `completed/OK`로 반환한다. 구현 절차는 [implement GUIDE](../../../.codex/internal-skills/implement/GUIDE.md)를 따른다.

전체 plan set의 순차 배정·통합 리뷰·최종 E2E는 기존 [구현 workflow 조율](../../../.codex/skills/orchestrator/references/implementation.md)이 소유한다. 이 wrapper를 새 executor로 대체하지 않는다. 한 번에 split plan 하나를 구현하며, 그 plan의 단위 테스트·독립 리뷰·canonical tracker 완료 확인 뒤 다음 plan으로 진행한다. 모든 구현 후 전체 Spec과 누적 diff의 통합 리뷰를 수행하고, 에이전트가 작성한 최종 E2E 시나리오에 대한 실제 사용자 승인을 받은 뒤 runner를 호출한다. E2E 실패는 자동 수정·재실행하지 않고 사용자에게 확인한다.

## 실행 계약

세션 입력의 `input_refs`에서 승인된 plan·Spec 산출물을 읽고 `context.producer_result_refs`와 `context.previous_result_ref`가 지정한 파일에서 이전 실행 결과를 확인한다. orchestrator가 배정한 plan ID로 구현 전에 `node .codex/scripts/harness-plan-review.mjs check --root <workspace_root> --plan-set <plan-set-id> --phase dispatch --plan <plan-id>`를 실행한다. pass가 아니면 구현하지 않고 그 결과를 반환한다. 결과의 `plan_reference`·`product_spec_path`·`architecture_spec_path`·`canonical_plan`·`review_snapshot_sha256`을 그대로 사용하고 ID나 디렉터리명으로 경로를 다시 만들지 않는다.

정적 실행기가 생성한 `context.execution_workspace`의 workspace_root·workspace_branch를 사용한다. 계획 문서에서 실행 위치를 고르거나 복사하지 않는다. `workspace_root`를 모든 명령의 cwd로 사용한다. 소유 worktree의 branch·복구·등록 정보가 필요하면 전달된 `session_directory/worktree.json`을 읽는다. 작업 위치 배정과 worktree lifecycle은 orchestrator가 관리한다.

## 구현

1. GitHub tracker mode에서는 [GitHub tracker 절차](references/tracker/github.md)에 따라 `harness-tracker.mjs check`로 tracker-publish가 만든 Issue와 Beads mirror를 확인한다. 이전 Harness로 발행돼 draft가 남아 있으면 `harness-publication.mjs activate`를 한 번 실행한다. 이후 활성 `workspace_root`의 implementation/testing guidance를 읽고, 승인 plan의 요구 ID·수용 조건·구현 범위와 대조한다. 관리 worktree에서는 원본 checkout의 지침 파일을 대신 읽지 않는다.
2. 전달된 fixed point와 기존 checkpoint를 보존하고 해당 plan만 구현한다. plan에서 지정한 비즈니스 로직 단위 테스트를 작성·실행한다. 테스트 작성은 [testing guidance](../../../.codex/internal-skills/testing-guidance/GUIDE.md), 실행은 EXEC의 기본 CLI 명령을 따른다. `harness-exec`는 최종 사용자 흐름 E2E에만 사용한다.
3. 요구별 변경 파일·검증 파일·실행 receipt와 commit을 기존 traceability/checkpoint 형식으로 기록한다. 이전 실패·측정 근거를 보존한다.
4. 상세 결과 객체를 공통 envelope의 `result` 필드로 반환한다. 실행기가 이를 검증하고 복구 경로에 보존한다.

## Plan 입력 확인

위 `check` 결과가 주는 값:

- `plan_reference`, `product_spec_path`, `architecture_spec_path`: 실제 읽을 승인 문서.
- `canonical_plan`, `review_snapshot_sha256`: 리뷰한 plan과 현재 입력의 일치 근거.

이 plan이 구현할 `requirement_ids`와 계획된 `verification_files`·검증 명령은 `plan_reference`가 가리키는 plan의 traceability ledger와 verification contract에서 읽는다. E2E profile은 parent plan에만 둔다. 이 값들은 문서 연결·snapshot·실행 증거를 확인하는 데 사용하며, 업무 규칙의 의미적 완전성은 독립 리뷰가 판단한다. 차단 사유는 inline result에 보존하고 orchestrator에 반환한다.

## 반환

구현과 단위 테스트를 마치면 `action_required/REVIEW_REQUIRED`로 반환하고 fixed point·commit·검증 근거의 파일 참조와 `unplanned_additions` 배열을 남긴다. orchestrator가 독립 구현 리뷰와 `repair`를 실행한다. `repair`가 통과했다는 feedback으로 재개되면 이 stage가 plan을 완료한다: 완료 gate를 확인하고 tracker의 그 plan을 `Done`(local-markdown은 `completed`)으로 바꾼 뒤 다음 ready plan을 고른다. Done 전이를 orchestrator에 미루지 않는다. plan을 고른 뒤 바꿀 코드가 없으면 먼저 `node .codex/scripts/harness-code-review.mjs reviewed --root <workspace_root> --plan <plan-id>`를 실행한다. `status: reviewed`이면 HEAD가 같은 계획 snapshot으로 이미 리뷰를 통과한 commit이므로 `REVIEW_REQUIRED`를 반환하지 않고 같은 방식으로 완료한다.

구현 stage는 승인된 Spec과 plan을 구현할 뿐 사용자에게 질문하지 않는다(`USER_DECISION_REQUIRED`와 questions를 반환하지 않는다). Spec이 정하지 않은 결정이 필요하면 `SPEC_REVISION_REQUIRED`, plan 재분할·수정은 `PLAN_REVISION_REQUIRED`로 반환한다. 환경·권한·의존성 부족과 실행 오류는 공통 계약의 blocked/failed 코드로 반환한다. 선택한 scope만으로 작업이 완료되는 호출은 `completed/OK`를 사용할 수 있으며 전체 workflow 완료를 뜻하지 않는다.

구현 또는 구현 리뷰 중 승인된 Spec에 없는 제품·업무 규칙이나 설계 결정을 발견하면 구현과 해당 규칙의 수정을 중단한다. 사용자에게 wrapper에서 직접 선택지를 묻거나 임의 값을 정하지 말고, 미결 사항·영향 요구·기존 구현 및 리뷰 근거를 보존해 `action_required/SPEC_REVISION_REQUIRED`로 orchestrator에 반환한다. orchestrator가 `spec-me`로 돌려보내 결정과 독립 리뷰를 진행하고 영향 계획을 재검토한 뒤 구현을 재개한다. 실행 환경은 Architecture Spec 12.7이 정하고, E2E 실행 승인은 orchestrator가 받는다.

구현자는 직접 commit하지 않고 `commit_request`를 반환하며 실행기가 지정된 파일만 commit한다. 메인 세션이나 관찰자가 대신 commit하지 않는다.

이미 구현된 Spec 밖 동작을 유지할지 제거할지는 Spec 수정을 시작하기 전에 사용자가 정한다. 구현자는 Spec 밖 동작을 `unplanned_additions`에 신고만 한다. 그것과 리뷰의 `unrequested_behavior`·`unbacked_requirement`에 대한 사용자 결정은 orchestrator가 `code-review`의 [판정과 수정 절차](../../../.codex/internal-skills/code-review/references/repair.md#판정과-수정-절차)로 묻는다. wrapper가 임의로 유지하거나 일관성을 맞추려고 확대하지 않는다. 유지가 선택된 경우에만 위의 `SPEC_REVISION_REQUIRED` 경로로 간다.
