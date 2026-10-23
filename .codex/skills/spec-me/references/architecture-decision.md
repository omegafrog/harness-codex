# Architecture 결정 단계

Product Spec 이후 Architecture Spec을 작성하기 전까지의 결정 순서를 정한다.

1. 적용되는 System Targets를 확정하고 `docs/specs/<ticket-id>/system-targets.yaml`에 기록한다.
2. material technology choice가 있으면 System Targets에 `decision_metadata`를 기록하고 Architecture Decision ID를 부여한다.
3. 대안을 고르기 전에 [결정 근거 조회·수집](decision-knowledge.md)을 수행한다.
4. 합의된 Architecture 결정을 [Architecture Spec 절차](../../../internal-skills/architecture-spec/GUIDE.md)에 넘긴다.

이 문서는 Architecture 결정의 순서를 소유한다. 근거 조사 방법은 `decision-knowledge.md`, 기술 검토와 Spec 작성은 Architecture Spec GUIDE가 소유한다.
