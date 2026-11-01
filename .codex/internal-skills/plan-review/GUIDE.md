<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# Plan Review

## 기준

최초 독립 리뷰는 요청 원문, review snapshot이 지정한 Product Spec·Architecture Spec, 관련 결정·다이어그램·현행 계약과 모든 canonical plan을 직접 읽고 대조한다. Spec 경로가 별도로 지정되지 않은 기본 위치는 `docs/specs/<plan-set-id>/product-spec.md`, `docs/specs/<plan-set-id>/architecture-spec.md`다. 재리뷰는 아래 변경 범위 규칙을 따른다. Spec의 동작·제약·DDD 경계, 각 slice의 `max_plan_tokens`, plan 간 의존·인계, 업무 규칙 단위 테스트와 통합 후 단일 feature E2E 계약을 검토한다.

자동 검사는 전체 입력 snapshot과 이전 내용을 보존한다. 최초 리뷰는 전체를 읽고, 재리뷰는 `review_delta`의 변경 구간, 미해결 지적과 직접 영향을 받는 Spec·plan 관계만 새 reviewer가 확인한다. 이전에 통과한 무관한 항목은 유지한다. 이전 내용이 없거나 구간이 모호하면 해당 파일을 전체 검토한다. 변경 영향 판단은 reviewer가 수행하며 전체 snapshot gate는 계속 현재성을 확인한다.

## 실행 모델과 반환

`plan-review`는 workflow 실행기가 dispatch하는 stage가 아니다. orchestrator가 `to-ticket` author execution의 `REVIEW_REQUIRED`를 받은 뒤 `plan_reviewer` 프로필의 새 read-only native subagent를 직접 호출한다. 매 회차 새 agent context를 만들고 writer 대화나 이전 reviewer 대화를 상속하지 않는다. 각 호출 전 `node .codex/scripts/harness-skill-execution.mjs binding --root <workspace_root> --skill plan-review`로 설정된 model과 reasoning effort를 resolve해 reviewer에 전달한다. Reviewer는 계획을 편집하거나 추가 agent를 만들지 않는다. `reviewer_id`에는 호출 결과로 확인되는 실제 native reviewer ID를, `author_ids`에는 해당 `to-ticket` session의 초기 작성 및 모든 feedback 재개에 사용된 실제 execution ID를 기록하며, `fork_turns`는 `none`으로 한다. 두 ID 집합이 겹치거나 실제 ID를 확인할 수 없으면 review를 기록하지 않는다.

Reviewer는 `verdict` (`pass` 또는 `revise`), `inputs` (`{path, sha256}` 배열), `findings` (각각 `severity`, `description`, `evidence`)를 부모 orchestrator 대화에 반환한다. Orchestrator는 실제 호출에서 확인한 reviewer ID, author 실행 원장의 IDs, attempt ID, plan-set ID, `fork_turns: "none"`를 결합해 [review-record.schema.json](review-record.schema.json)에 맞는 최종 기록을 만든다. `inputs`는 `begin`이 반환한 snapshot 전체를 그대로 사용한다. Findings 판정은 실행 성공/실패 상태와 별개다. 사용자 승인이나 reviewer의 pass 주장을 자동으로 대체하지 않는다.

## Orchestrator review loop

1. 매 최초·재검토 전에 `node .codex/scripts/harness-plan-review.mjs begin --root <workspace_root> --plan-set <plan-set-id>`를 실행한다. begin 결과 전체를 control session의 JSON으로 저장한다. 이 snapshot과 attempt ID를 reviewer에게 전달한다. 첫 review는 원문 요청, 승인된 Product/Architecture Spec, 관련 결정·다이어그램·계약, 모든 canonical plan과 Smart Zone을 직접 읽는다. 재리뷰는 snapshot의 `review_delta`와 직전 findings를 따라 변경 구간·미해결 항목·직접 영향 관계를 본다. 범위가 모호하면 해당 파일 전체를 읽는다.
2. orchestrator는 독립 subagent를 직접 생성하며 작성자의 대화 내용을 reviewer context에 복사하지 않는다. 전달할 context는 workspace root, session directory, plan-set ID, begin snapshot/attempt, 명시된 문서 기준뿐이다. caller가 reviewer와 author IDs를 결과에 결합한다. Reviewer는 schema 필드와 구체적 근거를 반환한다.
3. 부모는 returned `reviewer_id`가 실제 생성된 reviewer를 가리키고 author IDs가 실행 원장과 일치하는지, `fork_turns=none`, inputs가 begin snapshot과 정확히 같은지 확인한다. Review JSON을 control session에 저장하고 아래 명령으로 기록한다: `node .codex/scripts/harness-plan-review.mjs record --root <workspace_root> --plan-set <plan-set-id> --attempt <attempt_id> --reviews <session-relative JSON>`. `pass` 이후 반드시 `check --phase planning`을 실행한다. 통과 전에는 발행 stage로 이동하거나 tracker/Beads를 변경하지 않는다.
4. `revise`이면 review record path와 finding 요약을 `harness-prepare-input.mjs --stage-id to-ticket --feedback '<JSON>'`로 동일 author conversation에 전달한다. Author는 feedback record를 읽어 계획을 수정하고 다시 `REVIEW_REQUIRED`를 반환한다. Orchestrator는 새 attempt와 새 native reviewer로 재검토한다. 최대 3회차 뒤 미해결 항목은 범위 또는 결정을 묻는 실제 사용자 질문으로 반환한다. 사용자 답변은 해당 결정을 해결할 뿐 review pass로 간주하지 않는다.
5. `pass`이면 author를 같은 feedback resume 경로로 재개한다. Author는 `check --phase planning`과 publish preconditions를 다시 검사한 뒤에만 configured tracker와 Beads를 변경한다. Workflow completion gate도 review record와 현재 snapshot을 재검증한다.
