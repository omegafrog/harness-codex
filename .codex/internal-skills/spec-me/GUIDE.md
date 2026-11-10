# spec-me

## What it does

`spec-me` turns a user request into Product Spec and Architecture Spec within this one stage, from the Product interview through Architecture, independent review and diagrams. The orchestrator chooses the next stage; when another workflow step is needed, return the common status code.

`spec-me`가 Product·Architecture Spec Markdown을 작성하고 수정한다. `diagram_creator`는 다이어그램 파일을 작성한다. 확정된 결정과 근거를 반영해 각 Spec template과 topics의 적용 항목을 작성한다. 작성 과정과 실행 내역은 일반 실행 로그에 남긴다. Git은 다루지 않는다. 결과가 승인되면 실행기가 Spec 문서(`docs/specs/<plan-set-id>/`, `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/architecture/`)와 근거 `knowledge/`를 commit한다. 실행 안내(`docs/agents/EXEC.md`)와 코드는 구현 단계가 고친다.

## Spec 작성과 수정

사용자 원문과 확정 답변을 `docs/specs/<plan-set-id>/request.md`에 보존하고 Product 결정은 `product-decisions.md`에 기록한다. Product 결정이 바뀌면 결정 기록과 Product Spec을 함께 수정한다. 같은 workflow가 작성한 Spec은 리뷰 지적에 따라 수정할 수 있다. 기존에 사용자 또는 다른 workflow가 작성한 Spec을 교체할 때는 사용자 승인을 받는다.

두 Spec을 확정한 뒤 [적대적 Spec 리뷰 순서](references/adversarial-spec-review.md)에 따라 이 stage 안에서 fresh `spec_adversarial_reviewer`로 독립 리뷰를 수행하고, 현재 문서의 hash와 통과한 리뷰가 일치할 때만 `completed/OK`를 반환한다. 이 리뷰를 `review_request.skill: spec-review`로 orchestrator에 넘기지 않는다. 별도의 writer receipt나 writer 요청 envelope는 사용하지 않는다. 별도의 Architecture 결정 리뷰가 `review_request`를 필요로 하면 `context_path`는 Spec 디렉터리가 아닌 session 상대 JSON 파일이다.

내부 작업에는 실행할 skill 지침, `.codex/agents/<ID>.toml` 프로필과 구체적 목적을 전달한다. Product와 Architecture Spec 작성은 각각 해당 `product-spec` 및 `architecture-spec` 지침을 따른다. 재개 시 기존 작업과 확정된 결정을 재사용한다.

## Flow

1. `context.worktree_ref`의 `worktree.json`을 읽고 `workspace`를 `session_worktree`로 사용한다. 신규 worktree를 생성하지 않으며 `workspace_root`와 모든 명령의 cwd는 이 worktree다. 구현 중 설계 변경은 caller 소유의 같은 worktree를 사용한다.
2. Begin with the [Product Spec procedure](../../../.codex/internal-skills/product-spec/GUIDE.md) only. After Product decisions and the coverage gate are complete, load [Architecture decisions](references/architecture-decision.md); load the [adversarial review procedure](references/adversarial-spec-review.md) only when both Specs are ready for review. Load any diagram instructions only after the Architecture review passes and the inventory is settled. Keep working in this stage and session across phases. The runner pastes the Product guide and topics only until this plan set's `product-spec.md` exists; when you revise Product later, read them from the links.
3. 리뷰와 완료 gate를 통과한 Specs와 근거를 작업 branch에 보존한다. 신규 Spec 요청은 `completed/OK`로 반환한다. 구현 중 설계 변경은 변경 Spec·결정·영향 요구 ID를 상위 구현 caller에 반환한다. caller는 영향 계획의 갱신과 리뷰를 `to-ticket`에 인계하고 승인 근거를 받은 뒤 보존한 fixed point에서 구현을 재개한다.

## Documents

- Create `docs/specs/<plan-set-id>/` when missing. Product Spec은 `docs/specs/<plan-set-id>/product-spec.md`, Architecture Spec은 `docs/specs/<plan-set-id>/architecture-spec.md`에 둔다.
- Before accepting any writer/diagram result, verify every output resolves inside the selected `session_worktree`.
- Read the `plan_set_id` created during workflow composition from the canonical `worktree.json` and use it for Spec, diagram, decision, plan, review, and handoff paths. Preserve it for the same plan set; do not regenerate or rename it.
- For a path under the current plan set's Spec directory, run `node .codex/scripts/harness-spec-path.mjs <absolute-workspace-root> <spec-relative-path>` and use the returned path for writing or referencing the artifact. The result runner also derives the current Spec directory from canonical `worktree.json` before validating returned artifact paths and hashes.

## Rules

- When the user explicitly states a reusable implementation-only or test-running preference in the request or confirmed interview answers, update `docs/agents/implementation-guidance.md` or `testing-guidance.md` inside the active `workspace_root` through the matching [implementation guidance](../../../.codex/internal-skills/implementation-guidance/GUIDE.md) or [testing guidance](../../../.codex/internal-skills/testing-guidance/GUIDE.md). This keeps the memory change on the workflow branch so it can be reviewed and pushed with that workspace. Do not treat developer/skill instructions, inferred preferences, ticket-specific behavior, or unsettled architecture choices as durable guidance.
- The model decides whether to write an ADR. Write one when the decision is worth preserving; otherwise do not.

## 기준 계약

Spec 설계 전에 대상 프로젝트의 `docs/contracts/` 계약과 연결 다이어그램을 읽고 현재 구현 기준으로 참고한다. 제안하는 변경은 ticket-scoped Spec에 기록한다. 통합 계약 갱신은 구현 ticket 통합이 끝난 최종 구현 완료 단계에서 수행한다.

Architecture 단계에서 새로 정하거나 의미를 바꾼 도메인 용어도 [Product Spec 절차](../product-spec/GUIDE.md) 9번과 같은 방식으로 활성 `workspace_root/CONTEXT.md`에 반영하고, Bounded Context의 책임·관계는 `CONTEXT-MAP.md`에 갱신한다.

## 실행 산출물 경로

workflow 실행의 `session_directory`는 현재 작업을 위해 준비된 worktree의 canonical session이며 실행 결과·리뷰 증거·임시 산출물의 기준이다. `context.control_session_directory`는 orchestrator workflow 상태용으로만 사용한다. 두 경로를 서로 대체하거나 `.git` 아래에서 다시 계산하지 않는다. Spec과 다이어그램은 준비된 worktree의 선언 경로에 기록한다.


## 질문

무엇을 언제 묻는지는 [Product Spec 절차](../product-spec/GUIDE.md)의 질문 기준과 coverage gate를 따른다. 반환 형식은 실행기가 함께 준 stage 반환 계약을 따른다. 사용자가 불필요한 질문을 건너뛰라고 하면 해당 범위에서 이 기준을 적용해 계속한다. 이를 근거 없는 사용자 승인이나 향후 질문 전체에 대한 위임으로 기록하지 않는다.

질문 전에 현재 workflow의 확정 답변과 `request.md`, `product-decisions.md`, 프로젝트의 승인된 결정·위임 범위를 확인한다. 같은 조건에서 이미 답했거나 명시적으로 위임된 선택은 근거와 함께 재사용한다. 위임은 사용자가 그 선택을 맡긴다고 답한 경우에만 성립한다. "Spec에서 결정"처럼 결정이 일어날 단계를 가리키는 표현이나 orchestrator feedback의 요약은 위임이 아니므로 질문한다. `product-decisions.md`에서 위임을 근거로 쓰는 행은 해당 답변의 `answers.json`을 출처로 적으며, 없으면 Spec review 완료가 차단된다. 질문 문장과 선택지에 사용자가 말하지 않은 단위·인코딩·정규화·정밀도를 전제로 넣지 않는다. 이를테면 길이 제한의 수치를 물으면서 코드 포인트를 단위로 끼워 넣으면 수치 답변이 그 정밀도까지 승인한 것으로 기록된다. 그런 세부가 실제로 결과를 바꿀 때만 별도 질문으로 분리한다. 위임 범위를 벗어난 선택이나 승인되지 않은 추천은 사용자 답으로 기록하지 않는다.

질문을 반환한 execution의 `decision-answers.json`과 해당 `result.json`의 질문을 함께 확인한다. 재개 execution의 `answers.json`은 입력으로 받은 답변이며 이전 execution에 같은 이름의 파일이 있다고 추정하지 않는다. 사용자 결정은 장기 문서에도 내용과 출처를 보존하고, 참조 경로를 인용하기 전에 실제 존재를 확인한다.
