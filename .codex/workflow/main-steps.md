# 메인 워크플로우

이 파일은 intent별 선행 gate, 공통 work-item 실행, 산출물 정본이다.

구현 변경 요청은 `harness-orchestrate-instruction`을 거친다. utility 요청은 `orchestration-routes.md`의 skill로 직접 라우팅하고 이 ChangeSet workflow에 진입하지 않는다. 구현 변경만 아래 공통 진입을 따른다.

## 공통 진입

| 순서 | Step | Level | 선행 gate | 완료 gate | 산출물 |
|---|---|---:|---|---|---|
| 0 | `harness-orchestrate-instruction` | L1 | 사용자 또는 모델이 구현 요청 감지 | ChangeSet ID·intent·work item 결정 | `docs/changes/active/<CHG-ID>/changeset.md` |
| 0a | `harness-changeset-workspace` | L2 | 새 ChangeSet ID | sibling worktree·`changes/<CHG-ID>` branch | worktree 경로 |

orchestrator는 `feature | bugfix | refactor` 중 하나를 기록한다. `feature`는 Feature lane, `bugfix | refactor`는 Maintenance lane으로 보낸다.

## Feature lane

| 순서 | Step | Level | 선행 gate | 완료 gate | 산출물 |
|---|---|---:|---|---|---|
| F1 | `harness-requirements` | L2 | intent `feature` | requirements ready | `requirements.md` |
| F1a | `harness-requirements-question` | L3 | requirements blocker | 사용자 답변 | 질문 |
| F1b | `harness-requirements-document` | L3 | 확정 입력 | requirements 갱신 | `requirements.md` |
| F2 | `harness-ubiquitous-language` | L2 | requirements ready | ubiquitous language ready | `ubiquitous-language.md` |
| F2a | `harness-ubiquitous-question` | L3 | 용어 blocker | 사용자 답변 | 질문 |
| F2b | `harness-ubiquitous-document` | L3 | 확정 용어 | 문서 ready | `ubiquitous-language.md` |
| F3 | `harness-usecases` | L2 | requirements·용어 ready | UC와 E2E goal ready | UC 문서 묶음 |
| F3a | `harness-usecase-document` | L3 | 확정 UC | UC 문서 작성 | UC 문서 묶음 |
| F4 | `harness-event-storming` | L2 | UC·E2E goal ready | event storming ready | `event-storming.md` |
| F4a | `harness-event-storming-question` | L3 | 모델링 blocker | 사용자 답변 | 질문 |
| F4b | `harness-event-storming-document` | L3 | 확정 모델 | 문서 ready | `event-storming.md` |
| F5 | `harness-ddd-design` | L2 | event storming ready | DDD design ready | `ddd-design.md` |
| F5a-e | `harness-ddd-entity-vo` → `harness-ddd-bounded-contexts` | L3 | 이전 DDD gate | candidate DDD ready | `ddd-design.md` |
| F5f | `harness-ddd-question` | L3 | DDD mapping blocker | 사용자 답변 | 질문 |
| F6 | `harness-ddd-integration` | L2 | 대상 DDD design ready | integration ready 또는 no-op | `ddd-architecture.md` |
| F6a-c | integration question·document skills | L3 | integration blocker | 문서 ready | `ddd-architecture.md` |
| F7 | `harness-technical-decisions` | L2 | 통합 DDD architecture ready | ChangeSet 기술 결정 ready | `docs/changes/active/<CHG-ID>/technical-decisions.md` |
| F7a-b | technical decision question·document skills | L3 | 기술 blocker | 문서 ready | `technical-decisions.md` |

## Maintenance lane

| 순서 | Step | Level | 선행 gate | 완료 gate | 산출물 |
|---|---|---:|---|---|---|
| M1 | `harness-maintenance-bootstrap` | L2 | intent `bugfix | refactor`와 `MAINT-<NNN>` | maintenance intake ready | `docs/maintenance/<MAINT-ID>/**` |
| M2 | `harness-technical-decisions` | L2 | 구현 차단 기술 결정 존재 | 기술 결정 ready | `docs/maintenance/<MAINT-ID>/technical-decisions.md` |
| M2a-b | technical decision question·document skills | L3 | 기술 blocker | 문서 ready | `technical-decisions.md` |

architecture impact가 `none`이고 미해결 구현 결정이 없으면 M2를 `skipped`로 기록한다. 기대 동작 근거가 없거나 새 사용자 동작·정책이 필요하면 `feature`로 재분류한다. 용어 또는 DDD 경계만 부족하면 해당 Feature upstream step으로 보낸다.

## 공통 ChangeSet 실행

| 순서 | Step | Level | 선행 gate | 완료 gate | 산출물 |
|---|---|---:|---|---|---|
| W1 | `harness-code-planner` | L2 | ChangeSet slice ready·기술 결정 ready 또는 skipped | plan ready | `docs/plans/active/<CHG-ID>/plan.md` |
| W1a | `harness-plan-question` | L3 | 파일·순서 blocker | 사용자 답변 | 질문 |
| W1b | `harness-plan-document` | L3 | 확정 계획 | plan ready | active plan |
| W2 | `harness-security-plan-reviewer` | L2 | plan ready·선택된 security controls 존재 | security task 반영 | active plan |
| W3 | `harness-artifact-reviewer` | L2 | W2 완료 또는 skipped | plan approved | review 결과 |
| W4 | `harness-delivery-coordination` | L2 | plan approved | 외부 저장소 준비 | `delivery.md` |
| W5 | `harness-implementation-executor` | L2 | plan·delivery ready | 첫 미완료 작업 검증·체크·커밋 또는 blocker | 코드·검증 증거 |
| W6 | `harness-security-implementation-reviewer` | L2 | plan 작업 완료·선택된 security controls 존재 | 보안 review approved | review 결과 |
| W7 | `harness-review` | L2 | plan 작업 완료·W6 완료 또는 skipped | ChangeSet review ready 또는 blocked | `verification.md`, `review.md` |
| W7a | `harness-review-document` | L3 | 확정 review 결과 | 결과 기록 | review 문서 |

W2와 W6은 runtime-selected security controls가 없으면 `skipped`로 기록한다. W5는 단일 ChangeSet plan의 미완료 작업마다 반복한다. blocker가 domain·scope·technical·verification 중 하나면 부족한 최소 upstream step으로 돌아간 뒤 종료한다.

## ChangeSet 완료

| 순서 | Step | Level | 선행 gate | 완료 gate | 산출물 |
|---|---|---:|---|---|---|
| C1 | `harness-project-wiki` | L2 | ChangeSet review ready·wiki 영향 있음 | wiki 검증·커밋 | `docs/wiki/**` |
| C2 | `harness-changeset-pr` | L2 | ChangeSet review ready·wiki 완료 또는 skipped | PR 생성 | PR URL |

## 호출 규칙

- L1은 L2만 호출한다.
- L2는 L2 또는 L3만 호출한다.
- 선행 gate 미통과 step은 호출하지 않는다.
- 질문 또는 차단이면 orchestrator는 종료한다.
- `context.md`는 harness 운영 용어 전용이다.
- 선택된 ChangeSet·active plan 밖 workflow 문서는 읽거나 수정하지 않는다.
- 각 skill 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 보고한다.
