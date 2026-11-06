<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Plan Review

## 기준

최초 독립 리뷰는 review snapshot이 지정한 Product Spec·Architecture Spec, 계획 index와 모든 canonical plan을 직접 읽고 대조한다. Spec 경로가 별도로 지정되지 않은 기본 위치는 `docs/specs/<plan-set-id>/product-spec.md`, `docs/specs/<plan-set-id>/architecture-spec.md`다. 재리뷰는 아래 변경 범위 규칙을 따른다. Spec의 동작·제약·DDD 경계, 각 slice의 `max_plan_tokens`, plan 간 의존·인계, 업무 규칙 단위 테스트와 통합 후 단일 feature E2E 계약을 검토한다.

자동 검사는 전체 입력 snapshot과 이전 hash·지적을 보존한다. 최초 리뷰는 전체를 읽고, 재리뷰는 admission의 `inputs`와 `previous_inputs`를 비교해 변경된 파일 전체, `previous_findings`와 직접 영향을 받는 Spec·plan 관계를 새 reviewer가 확인한다. 이전에 통과한 무관한 항목은 유지한다. 이전 기준이 없거나 모호하면 전체 snapshot을 검토한다. 변경 영향 판단은 reviewer가 수행하며 전체 snapshot gate는 계속 현재성을 확인한다.

## 실행 모델과 반환

`plan-review`는 workflow 실행기가 dispatch하는 stage가 아니다. `to-ticket` execution이 plan authoring 중 `plan_reviewer` 프로필의 새 read-only native subagent를 직접 호출한다. 매 회차 새 agent context를 만들고 writer 대화나 이전 reviewer 대화를 상속하지 않는다. 각 호출 전 `node .codex/scripts/harness-skill-execution.mjs binding --root <workspace_root> --skill plan-review`로 설정된 model과 reasoning effort를 resolve해 reviewer에 전달한다. Reviewer는 계획을 편집하거나 추가 agent를 만들지 않는다. `reviewer_id`에는 provider가 반환한 실제 native reviewer ID를, `author_ids`에는 해당 `to-ticket` session의 초기 작성 및 모든 이어쓰기 execution ID를 기록하며, `fork_turns`는 `none`으로 한다. ID를 제공하지 않는 provider 실행 경로는 reviewer session 메타데이터로 실제 생성 ID를 확인한다. author/reviewer ID를 지어내거나 두 ID 집합이 겹치면 review를 기록하지 않는다.

Reviewer는 `verdict` (`pass` 또는 `revise`), `findings` (각각 `severity`, `description`, `evidence`)를 `to-ticket`에 반환한다. `to-ticket`은 확인된 실제 reviewer ID, author IDs, attempt ID, plan-set ID, `fork_turns: "none"`를 결합해 [review-record.schema.json](review-record.schema.json)에 맞는 최종 기록을 만들고 `record`한다. 실행기는 `begin`에 저장한 snapshot을 기록에 연결한다. reviewer는 hash를 반환하거나 복사하지 않는다. Findings 판정은 실행 성공/실패 상태와 별개다. 사용자 승인이나 reviewer의 pass 주장을 자동으로 대체하지 않는다.

## to-ticket review loop

1. 매 최초·재검토 전에 `node .codex/scripts/harness-plan-review.mjs begin --root <workspace_root> --plan-set <plan-set-id>`를 실행한다. begin 결과 전체를 session의 JSON으로 저장한다. 실행기가 반환한 `reviewer_input_ref`를 reviewer에게 전달한다. Reviewer는 이 runner-owned JSON의 `execution_id`, `attempt_id`, `plan_set_id`, `inputs`, `files`, `previous_inputs`, `previous_findings`를 현재 admission으로 사용한다. JSON에 `workspace_root`, `session_directory`, `review_delta`를 요구하거나 `.io`를 검색하지 않는다. 승인된 Product/Architecture Spec, 계획 index, canonical plan은 admission의 `files`에서 대조한다. 재리뷰는 현재·이전 hash를 비교하고 변경된 파일 전체와 직전 지적·직접 영향 관계를 검토한다.
2. `to-ticket`은 독립 subagent를 직접 생성하며 작성자 대화를 reviewer context에 복사하지 않는다. 실행기가 제공한 `reviewer_input_ref`와 명시된 문서 기준을 전달한다. Reviewer는 schema 필드와 구체적 근거를 반환한다.
3. `to-ticket`은 실제 생성된 reviewer ID, author IDs가 해당 실행 기록과 다른지, `fork_turns=none`인지 확인하고 아래 명령으로 review JSON을 기록한다: `node .codex/scripts/harness-plan-review.mjs record --root <workspace_root> --plan-set <plan-set-id> --attempt <attempt_id> --reviews <session-relative JSON>`. `pass` 이후 반드시 `check --phase planning`을 실행한다. 통과 전에는 발행 stage로 이동하거나 tracker/Beads를 변경하지 않는다.
4. `revise`이면 `to-ticket`은 findings를 반영해 계획을 수정하고 새 attempt와 새 native reviewer로 재검토한다. 최대 3회차 뒤 미해결 항목은 범위 또는 결정을 묻는 실제 사용자 질문으로 반환한다. 사용자 답변은 해당 결정을 해결할 뿐 review pass로 간주하지 않는다.
5. `pass`이면 `to-ticket`은 현재 snapshot 확인 뒤 completed/OK를 반환한다. Orchestrator는 전체 계획에 대한 사용자의 발행 승인을 받은 뒤 `tracker-publish` stage를 dispatch한다. 그 stage와 workflow completion gate도 review record와 현재 snapshot을 재검증한다.
