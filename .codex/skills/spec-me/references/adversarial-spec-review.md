# 적대적 Spec 리뷰 순서

리뷰 실행과 evidence 형식은 [spec-review GUIDE](../../../internal-skills/spec-review/GUIDE.md)가 소유한다. 이 문서는 spec-me에서 리뷰를 수행하는 시점과 진행 gate를 정한다.

spec-me 실행이 독립 reviewer 생성·결과 수집·수정 지시·재검토를 관리한다. reviewer는 fresh context에서 읽기 전용 판정과 findings를 반환하며, 사용자 질문은 상위 orchestrator에 전달한다. 수정·결정 요청에는 [공통 리뷰 조정](../../../internal-skills/review-coordination/GUIDE.md)을 적용한다. standalone에서는 spec-me caller가 orchestrator 역할을 수행한다.

1. Product Spec은 coverage gate와 작성자 입력 검증을 통과한 뒤 Architecture의 기준 요구로 사용한다. Product Spec 독립 reviewer stage는 실행하지 않는다.
2. Product Spec, System Targets 및 domain baseline을 사용해 Architecture Spec과 Architecture Decisions를 안정화한다.
3. 리뷰 admission 전에 요청, Product/Architecture Specs, domain baseline과 직접 읽은 근거를 모두 확정한다. `spec-review`의 `begin → fresh reviewer → record → check` 절차로 Architecture 축만 독립 리뷰한다. Reviewer를 실행한 뒤 입력이 바뀌면 해당 결과를 stale로 기록하고, 수정이 끝난 입력으로 새 admission을 발급한다. snapshot에는 요청·Product/Architecture Specs·명시된 근거를 포함하며, 다이어그램은 포함하지 않는다.
4. Architecture review와 Architecture decision gate 통과 뒤 확정된 Spec inventory에서 적용되는 축의 Product·Architecture 다이어그램을 생성·렌더한다. 적용되는 각 축에 대해 `node .codex/scripts/harness-decision-gate.mjs <product_diagram_completion|architecture_diagram_completion> --ticket <plan-set-id>`를 실행하고 JSON 결과의 `status`가 `pass`인지 확인한다. 해당 없음인 축은 gate를 실행하지 않으며 Spec에 이유가 있어야 한다. 모든 적용 축의 gate가 통과한 뒤 spec-me 완료 gate로 진행한다.

리뷰는 spec-me 내부 절차다. Spec 작성 작업은 독립 review stage를 완료하기 전 `completed`나 `REVIEW_REQUIRED`로 반환하지 않는다. Reviewer 실행 전의 준비 실패·취소만 `abort --reason 'pre-dispatch preparation: <원인>'`으로 명시해 기록한다. spec-me는 이 표식이 있는 연속 abort를 최대 3회 허용하고 substantive review 회차에는 포함하지 않는다. 한도에 도달하면 준비를 실제로 복구한 뒤 `resolve --reason 'preparation recovery: <복구 내용>'`으로 기록하고 재개한다. 이는 사용자 요구 결정이나 substantive 회차 초기화가 아니다. Reviewer가 실제 dispatch된 뒤의 종료·취소는 이 표식을 쓰지 않으며 기존 회차 한도를 소비한다. 기존 표식 없는 abort history도 substantive attempt로 유지한다. `record`된 revise/stale 결과는 모두 substantive attempt다. Findings는 원본 attempt를 보존한 뒤 해결·반박 여부를 한 번에 정리하고, 관련 문서를 묶어 수정한 다음 새 reviewer로 영향 구간을 집중 재검토한다. substantive review 최대 회차를 넘기거나 blocker/major가 재검토 뒤 남으면 자동 반복하지 말고 근거와 필요한 사용자 결정을 상위 caller에 반환한다.
