# Architecture 결정 단계

Product Spec 이후 Architecture Spec을 작성하기 전까지의 결정 순서를 정한다.

1. 적용되는 System Targets를 확정하고 `docs/specs/<plan-set-id>/system-targets.yaml`에 기록한다.
2. material technology choice가 있으면 System Targets에 `decision_metadata`를 기록하고 Architecture Decision ID를 부여한다.
3. 대안을 고르기 전에 [결정 근거 조회·수집](decision-knowledge.md)을 수행한다.
4. 합의된 Architecture 결정을 [Architecture Spec 절차](../../../internal-skills/architecture-spec/GUIDE.md)에 넘긴다.

이 문서는 Architecture 결정의 순서를 소유한다. 근거 조사 방법은 `decision-knowledge.md`, 기술 검토와 Spec 작성은 Architecture Spec GUIDE가 소유한다.

각 결정의 정본은 `docs/specs/<plan-set-id>/architecture-decisions/<decision-id>.yaml`이며 `.codex/schemas/decision/architecture-decision.schema.yaml`을 따른다. 승인 전에도 `proposed` 객체를 이 경로에 작성한다. 사용자에게는 결정 내용과 영향을 보여주고, 내부 동의 기록에 사용할 해시는 worktree에서 `node .codex/scripts/harness-decision-gate.mjs decision_subject_hash --ticket <plan-set-id> --decision <decision-id>`의 `subject_hash`를 사용한다. 결정 객체가 바뀌면 같은 명령으로 다시 확인하고 기존 동의를 임의로 새 내용에 옮기지 않는다. Markdown 본문이나 본문에 적힌 해시 문자열을 정본으로 계산·비교하지 않는다. 완료 검증은 기존 decision gate가 같은 정본 객체의 approval을 검사한다.
