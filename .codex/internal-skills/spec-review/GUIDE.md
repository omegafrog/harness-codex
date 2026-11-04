# 독립 Architecture Spec 리뷰

Product Spec과 Architecture Spec 두 문서만 리뷰 자료로 사용한다. Product Spec은 요구사항 기준이며 Architecture Spec이 이를 충족하는지 독립적으로 검토한다. 리뷰 기준은 [review-criteria.md](references/review-criteria.md)다. 리뷰 지침은 절차를 위한 지침이며 리뷰 자료가 아니다.

1. 두 Spec의 작성을 마친 뒤 `harness-spec-review.mjs begin --root <workspace_root> --ticket <plan-set-id> --axis architecture`를 실행한다. 추가 파일을 입력하지 않는다.
2. `spec_adversarial_reviewer`를 작성자와 분리된 fresh context (`fork_turns: none`)로 호출한다. 두 Spec과 리뷰 기준만 전달한다. 요청 원문, 결정 기록, 근거, 공식 문서, source, glossary, 계약, 다이어그램 등 다른 자료는 읽거나 리뷰하지 않는다.
3. 독립 리뷰는 요구사항 누락·모순, DDD 모델과 책임, 구현에 필요한 핵심 동작과 데이터의 누락을 확인한다. 지적은 두 Spec의 위치와 구체적인 영향을 포함한다. 근거가 없으면 취향으로 finding을 만들지 않는다.
4. reviewer의 원본 결과와 실제 독립 실행 metadata를 session-relative JSON으로 보존하고 `node .codex/scripts/harness-spec-review.mjs record --root <workspace_root> --ticket <plan-set-id> --axis architecture --attempt <attempt_id> --reviews <session-relative-json>`으로 기록한다. 리뷰 JSON의 `architecture`에는 axis, ticket_id, reviewer_id, author_ids, fork_turns, verdict, inputs, findings를 포함한다. 두 Spec의 hash만 실행기가 확인한다. reviewer의 pass를 대신 만들지 않는다.
5. blocker/major는 한 번에 모아 수정하고 새 독립 reviewer가 변경 부분과 직접 영향을 받는 관계만 재검토한다. 이전에 통과한 무관한 부분은 유지한다. 두 Spec의 내용이 리뷰 중 바뀌면 수정 완료 후 새 리뷰를 시작한다. 다른 파일의 변경은 이 리뷰를 무효화하지 않는다.
6. 최신 두 Spec의 독립 리뷰가 통과해야 spec-me를 완료한다. 다이어그램은 이 리뷰 후 별도 단계에서 처리한다.

Architecture Decision 리뷰, 자료 승인 및 다이어그램 검사는 각각의 별도 절차가 담당한다. 이 리뷰는 그 절차를 다시 수행하지 않는다.
