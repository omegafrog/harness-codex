# 506-engineering-decision-layer 구현 계획 인덱스

## 실행 맥락

- Parent Issue: [#506](https://github.com/omegafrog/harness-codex/issues/506)
- workspace_root: /home/jiwoo/workspace/harness-spec-engineering-decision-layer
- session_branch / execution_line: spec/engineering-decision-layer
- plan_base_sha: 2a040599edeed6c30541133f0e0e82e49e8d0517
- 상태와 전체 계획 본문의 정본은 GitHub Issue 및 Project의 Workflow Status다.
- 구현 브랜치 결과는 위 execution_line에 통합하며, 전체 구현 후 하나의 최종 PR을 생성한다.

## 분할 계획

| 순서 | plan_id | Issue | 구현 목적 | 선행 Issue |
|---|---|---|---|---|
| 1 | 506-01-system-targets | [#507](https://github.com/omegafrog/harness-codex/issues/507) | 시스템 특성으로 필요한 NFR만 선택하고, 현재·예상 성장·재검토 경계를 출처와 함께 기록한다. | 없음 |
| 2 | 506-02-architecture-decisions | [#508](https://github.com/omegafrog/harness-codex/issues/508) | Code와 Infrastructure 결정을 요구사항·목표·대안·근거에 연결하고, 승인 대상 자체의 변경을 검출한다. | [#507](https://github.com/omegafrog/harness-codex/issues/507) |
| 3 | 506-03-learning-review | [#509](https://github.com/omegafrog/harness-codex/issues/509) | 사용자가 설계를 방어하고 Reviewer가 근거 기반 이의를 제기하며, 새 자료는 먼저 사용자에게 사용 승인을 받게 한다. | [#508](https://github.com/omegafrog/harness-codex/issues/508) |
| 4 | 506-04-source-claim-harvest | [#510](https://github.com/omegafrog/harness-codex/issues/510) | Engineering 질문에서 출처를 탐색·평가하고 원문에 연결된 atomic Claim까지 프로젝트에 보존한다. | [#508](https://github.com/omegafrog/harness-codex/issues/508) |
| 5 | 506-05-principle-approval | [#511](https://github.com/omegafrog/harness-codex/issues/511) | 지지·반대 Claim을 독립적으로 검토한 Principle 후보를 사람 승인 후에만 공통 근거로 게시한다. | [#510](https://github.com/omegafrog/harness-codex/issues/510) |
| 6 | 506-06-local-evidence | [#512](https://github.com/omegafrog/harness-codex/issues/512) | 측정 관측을 로컬 후보로 보관하고 사용자가 확인한 정규화 요약만 durable Evidence로 등록한다. | [#510](https://github.com/omegafrog/harness-codex/issues/510) |
| 7 | 506-07-knowledge-integration | [#513](https://github.com/omegafrog/harness-codex/issues/513) | 승인된 Principle과 Local Evidence를 spec-me 판단에 연결하고, 변경 영향과 worktree 병합 충돌을 안전하게 표시한다. | [#509](https://github.com/omegafrog/harness-codex/issues/509), [#511](https://github.com/omegafrog/harness-codex/issues/511), [#512](https://github.com/omegafrog/harness-codex/issues/512) |
| 8 | 506-08-runtime-evidence | [#514](https://github.com/omegafrog/harness-codex/issues/514) | Harness의 실행 관측을 자동으로 Evidence 후보로 수집하면서 기존 execute/verify 판정과 원본 history를 유지한다. | [#513](https://github.com/omegafrog/harness-codex/issues/513) |

## 관련 명세

- [Product Spec](../../specs/506/product-spec.md)
- [Architecture Spec](../../specs/506/architecture-spec.md)

## 다이어그램

- [UC-001.activity](../../specs/506/diagrams/product/UC-001.activity.svg)
- [UC-001.usecase](../../specs/506/diagrams/product/UC-001.usecase.svg)
- [UC-002.activity](../../specs/506/diagrams/product/UC-002.activity.svg)
- [UC-002.usecase](../../specs/506/diagrams/product/UC-002.usecase.svg)
- [UC-003.activity](../../specs/506/diagrams/product/UC-003.activity.svg)
- [UC-003.usecase](../../specs/506/diagrams/product/UC-003.usecase.svg)
- [UC-004.activity](../../specs/506/diagrams/product/UC-004.activity.svg)
- [UC-004.usecase](../../specs/506/diagrams/product/UC-004.usecase.svg)
- [architecture-review.state](../../specs/506/diagrams/architecture/architecture-review.state.svg)
- [engineering-decision.class](../../specs/506/diagrams/architecture/engineering-decision.class.svg)
- [principle.state](../../specs/506/diagrams/architecture/principle.state.svg)

## 검증 및 인계

- 각 child Issue의 테스트 계약과 수용 기준을 따른다. UI는 CLI/Agent workflow이며 entity까지의 실제 저장·조회 결과를 검증한다.
- 실제 서버·인프라 E2E는 e2e-test 스킬과 e2e_test_runner를 사용하며 EXEC.md 및 cleanup 규칙을 따른다.
- 구현은 이 세션 worktree를 기준으로 implement-wrapper/implement에 인계한다. 각 계획의 scope 외 변경은 재계획 대상으로 남긴다.
