# Plan Set 496

## Parent

- [#496 — P0 실행 기반: behavioral eval·execution journal·parallel worktree isolation](https://github.com/omegafrog/harness-codex/issues/496)
- Product Spec: `docs/specs/496/product-spec.md`
- Architecture Spec: `docs/specs/496/architecture-spec.md`

## Split plans

| 순서 | Issue | 목적 | 의존성 |
|---|---|---|---|
| 1 | [#497](https://github.com/omegafrog/harness-codex/issues/497) | Behavioral Eval baseline 실행·판정 contract | 없음 |
| 2 | [#498](https://github.com/omegafrog/harness-codex/issues/498) | Execution journal과 checkpoint projection | #497 |
| 3 | [#499](https://github.com/omegafrog/harness-codex/issues/499) | Parallel-group-aware worktree isolation | #498 |

## 실행 규칙

- 모든 child plan은 GitHub Project 6의 `Workflow Status: Planned` 상태로 시작한다.
- 실행 순서는 dependency graph를 따른다.
- split plan은 Smart Zone 단위이며 parallelism을 의미하지 않는다.
- 병렬 실행은 scheduler가 dependency/resource graph로 독립성을 입증한 경우에만 허용한다.
- plan-set은 하나의 integration PR로 연결한다.
