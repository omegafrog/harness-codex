# 적대적 Spec 리뷰 순서

리뷰 실행과 evidence 형식은 [spec-review GUIDE](../../../internal-skills/spec-review/GUIDE.md)가 소유한다. 이 문서는 spec-me에서 리뷰를 수행하는 시점과 진행 gate를 정한다.

1. 확정 답변과 Product Spec·적용 다이어그램의 반영을 마친 뒤 `spec-review`의 `begin → fresh reviewer → record → check` 절차로 Product 축을 검토한다. `product_adversarial_review`가 통과한 뒤 Architecture 결정 단계로 진행한다.
2. Architecture Spec과 적용 다이어그램이 준비되면 Architecture 축을 검토한다. Product Spec이 바뀌어 기존 Product 리뷰가 stale이면 Product 축도 갱신한다.
3. `architecture_adversarial_review`와 Architecture 결정 단계의 decision gate가 통과하면 spec-me 완료 gate로 진행한다.
