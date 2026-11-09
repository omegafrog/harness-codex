# code-review 호출과 수정 절차

리뷰를 실행하고 그 결과로 다음 행동을 정하는 메인 orchestrator가 읽는다. reviewer의 판정 기준과 결과 형식은 [code-review GUIDE](../GUIDE.md)에 있다.

## 실행

The main orchestrator spawns the two reviewers as fresh native subagents (`standards_reviewer`, `spec_reviewer`); each reads the [code-review GUIDE](../GUIDE.md) from its profile pointer:

1. Confirm the fixed point. If the reviewer model binding is missing, return `blocked/MODEL_BINDING_UNAVAILABLE` with the missing keys; do not invoke setup.
2. Dispatch a fresh `standards_reviewer` with the diff, commit list, Product Spec, scoped plan/evidence and standards sources; allow targeted source/test reads to verify acceptance claims.
3. Dispatch a separate fresh `spec_reviewer` with the diff, commit list, Architecture Spec, affected durable model/ADR refs and scoped plan/evidence; allow source/caller/test reads beyond changed lines to verify rule ownership and bypass paths.
   For every planned implementation, give both reviewers the current Product and Architecture Specs and every canonical plan so they compare behavior and constraints directly; a plan set may still omit part of a Spec.
4. Run them in parallel when supported, otherwise as separate subagent executions. Keep both contexts isolated and read-only. Never run a reviewer pass inline in the parent or simulate isolation with two labels; if isolation is unavailable, report that limitation.
5. Wait for both to finish (a running reviewer is pending, not failed). Preserve their actual return files, execution and thread IDs; never invent reviewer IDs.
6. Aggregate without merging, reranking or letting one axis mask the other, then route the next action with the repair decision below. Do not auto-fix, auto-rerun or auto-close issues.

수정이나 사용자 결정 요청 전에 orchestrator가 [공통 리뷰 조정](../../../../.codex/internal-skills/review-coordination/GUIDE.md)의 구현 리뷰 절차를 적용한다. 두 축의 결과를 모두 받은 뒤 수정표를 정하고, 계획된 구현의 review_input에는 plan-review check가 반환한 plan_set_id와 review_snapshot_sha256을 각각 plan_set_id·planning_snapshot_sha256으로 보존한다. repair 예약과 최종 완료는 같은 planning snapshot을 기준으로 판정한다.

## 판정과 수정 절차

1. reviewer를 생성하기 전에 plan-review check의 현재 pass 결과와 `canonical_plan` metadata(kind·reference·input_key·hash_algorithm·normalization·sha256)를 확인한다. hash 판정은 `harness-plan-review.mjs check` 결과를 쓰고 raw 파일 SHA와 비교하지 않는다. `canonical_plan.reference` 파일을 읽으며, `input_key`의 `#canonical` 접미사는 가상 snapshot 식별자다.
2. 두 reviewer가 끝나면 review JSON을 직접 조립하지 말고 `node .codex/scripts/harness-code-review.mjs assemble --root <workspace_root> --plan <plan-id> --fixed-point <review_fixed_point> --implementation-result <구현 stage의 session-relative result.json> --standards-agent <standards reviewer의 native agent ID> --spec-agent <spec reviewer의 native agent ID>`를 실행한다. reviewer를 띄울 때 도구가 돌려준 agent ID만 쓴다. subagent hook이 worktree session의 `runtime/orchestrator/subagents.jsonl`에 기록한 두 reviewer의 최종 답(`{"state":"passed"|"failed","report":{"findings":[...]}}`)이 review가 되며, 기록되지 않았거나 작성자 대화를 fork한 reviewer는 거부된다. 이 명령이 실제 commit 목록(기준점 포함)·`diff_range` 객체·diff, plan-review dispatch check의 Spec 경로·`canonical_plan`·planning snapshot, 구현자의 `unplanned_additions`로 `review_input`을 만들어 `runtime/reviews/implementation-<plan-id>.json`에 기록한다. reviewer의 답을 파일로 옮겨 적거나 고치지 않는다.
3. 수정·설계 인계·사용자 질문을 하기 전에 지적이 있든 없든 `node .codex/scripts/harness-code-review.mjs repair --root <workspace_root> --plan <plan-id> --reviews <session-relative JSON>`을 실행한다. 기본 한도는 1회이며 승인된 설정이 2회이면 `--max-rounds 2`를 사용한다. `repair`는 `review_input.unplanned_additions` 배열이 없으면 차단한다. 근거 없음이나 인용 불일치로 판정된 수정 지적은 `unbacked_requirement`가 되어 `unrequested_behavior`와 함께 사용자 결정으로 간다. 실행 workspace의 `.io/runtime/reviews/implementation-<plan-id>.json`이 횟수·fixed point·지적의 정본이다. 같은 커밋의 중복 예약과 재개를 통한 한도 상향을 차단한다. wrapper runtime도 같은 예약 함수를 사용한다.
4. requirement_ambiguity·architecture_decision·scope_expansion·spec_conflict이면 구현 수정을 보류하고 먼저 5번으로 사용자에게 묻는다. `spec-me`는 사용자가 Spec에 추가하기로 답한 지적만 받는다. 전환할 때는 요구를 키워 쓰지 말고 지적과 사용자 답을 그대로 넘긴다. 새 명령·새 업무 상태·새 규칙·새 경계가 필요한지와 현재 구현 결함을 구분하고, 발견한 경로 전체·필요 결정·기존 fixed point·commit·repair 기록을 checkpoint에 보존한다. 승인된 Spec과 영향 계획의 fresh review 뒤 같은 구현 기준으로 재개한다. 설계 재검토 중 구현 repair를 먼저 예약하지 않는다.
5. `repair`가 `next_action: user-decision`으로 차단하면 수정을 시작하지 않는다. `user_questions`의 각 `question`을 `questions` 배열에 그대로 넣어 `action_required/USER_DECISION_REQUIRED`로 반환하고 질문 본문을 바꾸지 않는다. orchestrator는 stage가 아니라서 이 질문에는 실행기가 부여한 `question_id`가 없다. 사용자가 답하면 지적마다 `node .codex/scripts/harness-code-review.mjs record-decision --root <workspace_root> --plan <plan-id> --finding <finding_id> --choice <reject|accept|adopt> --answer '<사용자의 답 원문>'`을 실행한다. 이 명령은 가장 최근 `repair`가 물은 질문(`question_id`에 지적 내용의 지문이 들어 있다)에만 답을 받고, 그 질문 뒤에 사용자가 실제로 보낸 입력(hook이 `runtime/orchestrator/user-inputs.jsonl`에 기록)에 답 원문이 있어야 기록한다. 답 원문에 선택한 선택지 라벨이 없어도 거부한다. 지적 ID가 이전 라운드와 같아도 다른 지적일 수 있으므로 이전 답을 재사용하지 말고 매번 질문 원문 그대로 사용자에게 묻는다. 기록된 결정은 같은 내용의 지적에만 적용된다. 그 뒤 3번을 다시 실행하면 runtime이 답변과 대조한다. ID를 추측해 만들거나 답을 요약해 쓰지 않는다. 같은 항목을 가리키는 지적은 원본을 고치지 말고 session JSON 최상위 `scope_groups`에 `{id, finding_ids}`로 묶은 뒤 3번을 다시 실행한다. 그러면 질문이 항목별로 하나만 나오고 결정의 `finding_id`에 그룹 `id`를 쓴다. 지원하지 않기로 한 결정은 `product-decisions.md`에 기록해 같은 지적을 다시 묻지 않는다. `choice`는 reject, accept, adopt다. accept는 묶인 항목이 모두 `rule_impact: none`일 때만 제시되며 Spec 변경 없이 유지하고 리뷰 기록에 남는다. 규칙 영향이 있는 항목의 유지는 adopt와 같이 Spec 승인으로 간다. `unrequested_behavior`의 reject는 제거 수정이며 Spec 변경 없이 진행하고 수리 예산이 소진돼도 허용된다. `unbacked_requirement`의 reject는 지적 기각이다. adopt는 `scope_expansion`으로 바뀌어 4번으로 간다. 사용자가 답하기 전에는 유지도 제거도 하지 않는다.
6. 허용된 수정을 마치면 focused verification과 새 commit을 보존하고 두 축을 새 reviewer로 재검토한다. 직전 라운드에서 한 축이 지적 없이 통과했고 수정이 다른 축의 blocking 지적이 인용한 파일만 바꿨다면, 그 축의 reviewer를 띄우지 말고 2번의 `assemble`에서 그 축의 `--standards-agent`/`--spec-agent` 대신 `--reuse-axis standards|spec`을 쓴다. 조건이 어긋나면 `assemble`이 거부하므로 그때는 두 축 모두 새 reviewer를 띄운다. 자신이 조건을 판단해 이월하지 않는다. 한도를 소진하면 `repair`가 남은 지적을 `user_questions`로 돌려준다. 한도 소진을 이유로 지적을 Spec이나 plan 수정으로 올리지 않는다. 사용자가 계속 고치기로 답한 경우에만 plan을 갱신한다. 같은 plan에서 사이클이 3번 끝나면 `resolve`가 `repair_cycle_limit`로 멈추고 질문을 돌려주며, 계속하려면 사용자 답을 `--answers-ref`와 `--question-id`로 전달한다. 한도 초기화는 실제 수정 범위/설계 결정 변경, 그에 따른 새 planning snapshot, 독립 계획 리뷰와 dispatch pass가 모두 있을 때만 허용한다. `resolve --root <workspace_root> --plan <plan-id> --reason '<사용자 결정 원문과 위치>'`는 현재 snapshot이 기존 repair 예약의 snapshot과 달라야 통과한다. 일반 진행 지시, 동일 범위에서의 추가 수정 허용, 근거 없는 요청은 reset하지 않는다. handoff checkpoint에는 수정 예약 결과와 원장 경로·기존 fixed point·남은 지적·다음 작업을 보존한다.

## Output

- fixed point와 implementation commit
- 축별 state·구조화 findings·실제 reviewer metadata
- 현재 plan의 미해결 blocker와 최종 통합으로 연결한 항목

## 소유 worktree

상위 workflow가 전달한 worktree를 그대로 쓰고 소유권·종료를 다루지 않는다. 직접 소유한 실행이면 [session-worktree](../../../../.codex/internal-skills/session-worktree/GUIDE.md)를 따른다.

## 실행 산출물 경로

실행 중 생기는 로그·임시 파일·스크린샷은 [실행 산출물 경로](../../../../.codex/internal-skills/skill-execution/references/runtime-artifact-paths.md)를 따른다.
