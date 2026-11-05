# 독립 Architecture Spec 리뷰

Product Spec과 Architecture Spec 두 문서만 리뷰 자료로 사용한다. Product Spec은 요구사항 기준이며 Architecture Spec이 이를 충족하는지 독립적으로 검토한다. 리뷰 기준은 [review-criteria.md](references/review-criteria.md)다. 리뷰 지침은 절차를 위한 지침이며 리뷰 자료가 아니다.

1. 두 Spec의 작성을 마친 뒤 `harness-spec-review.mjs begin --root <workspace_root> --ticket <plan-set-id> --axis architecture`를 실행한다. 추가 파일을 입력하지 않는다.
2. `spec_adversarial_reviewer`를 작성자와 분리된 fresh context (`fork_turns: none`)로 호출한다. 두 Spec과 리뷰 기준만 전달한다. 요청 원문, 결정 기록, 근거, 공식 문서, source, glossary, 계약, 다이어그램 등 다른 자료는 읽거나 리뷰하지 않는다. Reviewer의 마지막 assistant 메시지는 `verdict` 값이 `pass`, `revise`, `reject`, `blocked` 중 하나이고 `findings` 배열을 포함하는 JSON 객체여야 한다. 예: `{ "verdict": "pass", "findings": [] }`. Identity와 admission fields는 실행기가 주입·기록하므로 reviewer가 만들거나 추측하지 않는다. 이 실제 마지막 메시지가 native stop 결과와 대조되므로 별도 요약을 덧붙이지 않는다.
   Claude Code에서는 `PreToolUse` Agent admission hook이 현재 활성 Architecture attempt 하나와 연결된 실제 `spec_adversarial_reviewer` 위임만 허가한다. attempt ID와 reviewer identity는 호출 입력에 주입되며, native start/stop identity와 실제 마지막 응답이 기록 결과와 일치해야 한다. hook 차단을 다른 role이나 수동 reviewer 호출로 우회하지 않는다.
3. 독립 리뷰는 요구사항 누락·모순, DDD 모델과 책임, 구현에 필요한 핵심 동작과 데이터의 누락을 확인한다. 지적은 두 Spec의 위치와 구체적인 영향을 포함한다. 근거가 없으면 취향으로 finding을 만들지 않는다.
4. reviewer의 원본 결과와 실제 독립 실행 metadata를 session-relative JSON으로 보존하고 `node .codex/scripts/harness-spec-review.mjs record --root <workspace_root> --ticket <plan-set-id> --axis architecture --attempt <attempt_id> --reviews <session-relative-json>`으로 기록한다. 리뷰 JSON의 `architecture`에는 axis, ticket_id, reviewer_id, author_ids, fork_turns, verdict, findings를 포함한다. 두 Spec의 admission hash는 실행기가 기록하고 현재 파일과 대조한다. Reviewer가 시작 또는 종료되지 않았거나 최종 응답·기록이 누락/불일치하면 gate는 차단 상태로 둔다. 실제 dispatch 뒤의 누락은 substantive 회차를 소비하므로 임의 receipt나 legacy 결과로 대체하지 않는다. reviewer의 pass를 대신 만들지 않는다.
5. reviewer dispatch 전 준비 실패만 `abort --reason 'pre-dispatch preparation: <원인>'`으로 기록한다. 이 abort는 history에 남고 substantive 회차를 소비하지 않으며 연속 최대 3회까지 허용된다. Reviewer dispatch 뒤 취소·실패는 이 예외를 쓰지 않고 substantive 한도를 소비한다. 세 번의 preparation abort 뒤에는 원인을 복구하고 `resolve --reason 'preparation recovery: <복구 내용>'`을 기록해야 재개할 수 있다. 세 번 substantive attempt를 소진하면 필요한 사용자 범위·결정 변경을 얻어 `resolve`하기 전 추가 리뷰를 시작하지 않는다. history는 재개·session 교체 뒤에도 유지된다. blocker/major는 한 번에 모아 수정하고 새 독립 reviewer가 변경 부분과 직접 영향을 받는 관계만 재검토한다. 이전에 통과한 무관한 부분은 유지한다. 두 Spec의 내용이 리뷰 중 바뀌면 수정 완료 후 새 리뷰를 시작한다. 다른 파일의 변경은 이 리뷰를 무효화하지 않는다.
6. 최신 두 Spec의 독립 리뷰가 통과해야 spec-me를 완료한다. 다이어그램은 이 리뷰 후 별도 단계에서 처리한다.

Architecture Decision 리뷰, 자료 승인 및 다이어그램 검사는 각각의 별도 절차가 담당한다. 이 리뷰는 그 절차를 다시 수행하지 않는다.
