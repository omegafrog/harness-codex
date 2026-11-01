# 적대적 Spec 리뷰 순서

리뷰 실행과 evidence 형식은 [spec-review GUIDE](../../../internal-skills/spec-review/GUIDE.md)가 소유한다. 이 문서는 spec-me에서 리뷰를 수행하는 시점과 진행 gate를 정한다.

spec-me 실행이 독립 reviewer 생성·결과 수집·수정 지시·재검토를 관리한다. reviewer는 fresh context에서 읽기 전용 판정과 findings를 반환하며, 사용자 질문은 상위 orchestrator에 전달한다. 수정·결정 요청에는 [공통 리뷰 조정](../../../internal-skills/review-coordination/GUIDE.md)을 적용한다. standalone에서는 spec-me caller가 orchestrator 역할을 수행한다.

1. Product Spec은 coverage gate와 작성자 입력 검증을 통과한 뒤 Architecture의 기준 요구로 사용한다. Product Spec 독립 reviewer stage는 실행하지 않는다.
2. Product Spec, System Targets 및 domain baseline을 사용해 Architecture Spec과 Architecture Decisions를 안정화한다.
3. `spec-review`의 `begin → fresh reviewer → record → check` 절차로 Architecture 축만 독립 리뷰한다. 리뷰 snapshot에는 요청·Product/Architecture Specs·명시된 근거를 포함하며, 다이어그램은 포함하지 않는다.
4. Architecture review와 Architecture decision gate 통과 뒤 확정된 Spec inventory에서 적용되는 축의 Product·Architecture 다이어그램을 생성·렌더한다. 적용되는 각 축에 대해 `node .codex/scripts/harness-decision-gate.mjs <product_diagram_completion|architecture_diagram_completion> --ticket <plan-set-id>`를 실행하고 JSON 결과의 `status`가 `pass`인지 확인한다. 해당 없음인 축은 gate를 실행하지 않으며 Spec에 이유가 있어야 한다. 모든 적용 축의 gate가 통과한 뒤 spec-me 완료 gate로 진행한다.
