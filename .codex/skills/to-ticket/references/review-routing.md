# 계획 리뷰 준비와 결과 처리

`to-ticket` workflow는 split plan 작성, 독립 리뷰, 수정 반복, 최종 발행으로 실행한다.

## Stage 구성

| Stage | Skill / role | 입력·출력 | Orchestrator 동작 |
|---|---|---|---|
| `plan_split` | `to-ticket` / `to_ticket` | `plan_set_draft` | Spec을 분할하고 사용자 승인 뒤 canonical plan set을 작성한다. |
| `plan_review` | `plan-review` / `plan_reviewer` | `plan_set_draft` → `plan_review_result` | 결과를 review-attempt record에 기록하고 pass/revise로 분기한다. |
| `plan_revision` | `to-ticket` / `to_ticket` | `plan_set_draft` + `plan_review_result` → `plan_set_revision` | Findings를 수정하고 `plan_review`를 새 execution으로 다시 호출한다. |
| `plan_finalize` | `to-ticket` / `to_ticket` | 최신 `plan_set_draft` + pass `plan_review_result` | planning review gate를 재검사한 뒤 Beads·configured tracker에 발행한다. |

각 `plan_review` 실행 전에 orchestrator가 review-attempt CLI의 `begin`으로 attempt와 snapshot을 준비해 read-only reviewer에 전달한다. `plan_review`는 finding이 있어도 리뷰 실행이 정상 완료되면 `completed/OK`로 반환한다. `verdict`와 `plan_review_result` artifact가 승인 여부를 담는다. `revise`이면 `plan_revision`, `pass`이면 `plan_finalize`를 선택한다. `plan_revision` 뒤에는 새 `begin`과 fresh reviewer를 사용해 같은 `plan_review` stage ID를 새 execution으로 반복한다. Stage ledger는 각 실행을 attempt history로 보존하며 plan-review history는 review-attempt CLI가 관리한다.

`begin` 전체 JSON을 제어 session에 저장하고 stage 실행에 `--review-admission-ref <session-relative JSON>`을 전달한다. 실행기는 plan-set ID와 active attempt 및 전체 snapshot을 검증하고 `review_delta`를 reviewer에 전달한다.

Review result의 `reviewer_id`, `author_ids`, `fork_turns`, `inputs`, `findings`를 실제 execution metadata와 대조한 뒤 `harness-plan-review.mjs record`로 기록한다. `author_ids`는 plan 작성 stage의 실제 execution ID를 사용한다. `pass` 결과는 `harness-plan-review.mjs check --phase planning`으로 현재 snapshot을 검증한다. Finalize도 외부 mutation 전에 같은 check를 실행한다. Review attempt가 세 번 끝나도 pass가 없으면 현재 finding과 해결할 scope/decision을 사용자에게 전달하고 기다린다.

## Revision loop

1. `plan_split`이 분할 승인 질문으로 `USER_DECISION_REQUIRED`를 반환하면 질문 파일을 사용자에게 제시하고 실제 답변을 보존해 같은 stage를 재개한다. 승인된 재실행의 `completed/OK` 뒤 `plan_review`를 fresh execution으로 호출한다.
2. Reviewer 결과를 원장에 기록한다. `pass`이면 finalize를 호출한다.
3. `revise`이면 reviewer artifact와 최신 plan draft를 `plan_revision`에 전달한다. Spec 변경이 필요하면 `SPEC_REVISION_REQUIRED`로 spec-me 단계에 인계한다.
4. `plan_revision`이 완료되면 `plan_review`를 새 execution으로 다시 호출한다.
5. `plan_finalize`는 planning review gate pass를 확인한 뒤에만 Beads/tracker mutation을 수행한다.
