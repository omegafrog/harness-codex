# 메인 워크플로우

이 파일은 intent별 선행 gate, 공통 work-item 실행, 산출물 정본이다.

구현 변경 요청은 `harness-orchestrate-instruction`을 거친다. utility 요청도 이 진입점이 명시적으로 선택된 경우 orchestration agent가 route를 고른 뒤 해당 utility L2 step skill을 직접 호출한다. 구현 변경만 아래 ChangeSet workflow에 진입한다.
utility 요청은 `orchestration-routes.md`에서 먼저 직접 route를 찾는다.

## 공통 진입

| 순서 | Step | Level | 선행 gate | 완료 gate | 산출물 |
|---|---|---:|---|---|---|
| 0 | `harness-orchestrate-instruction` | L1 | 사용자가 명시하거나 모델이 구현 요청 감지 | orchestration agent가 route를 결정하고 대상 L2 step skill 호출 결과를 반환 | route 결과와 step 결과 |
| 0a | `harness-changeset-workspace` | L2 | 새 ChangeSet ID | sibling worktree, `changes/<CHG-ID>` branch | worktree 경로 |

orchestrator는 `feature | bugfix | refactor` 중 하나를 기록한다. `feature`는 Feature lane, `bugfix | refactor`는 Maintenance lane으로 보낸다.

분류 전 `.codex/workflow/declaration-contracts.md`의 Intent Assessment를 작성한다.
제품 의미 변경의 긍정 근거가 없으면 사용자 관찰 가능성만으로 `feature`를 선택하지 않는다.
Mutation 전에는 caller-owned probe와 baseline observation을 확정한다. Runtime은 선언을
검증·실행·기록할 뿐 intent, 다음 step, retry, remediation 또는 완료를 결정하지 않는다.

## Feature lane

| 순서 | Step | Level | 선행 gate | 완료 gate | 산출물 |
|---|---|---:|---|---|---|
| F1 | `harness-requirements` | L2 | intent `feature` | requirements ready | `requirements.md` |
| F1a | `harness-requirements-question` | L3 | requirements blocker | 사용자 응답 | 질문 |
| F1b | `harness-requirements-document` | L3 | 확정 입력 | requirements 갱신 | `requirements.md` |
| F2 | `harness-ubiquitous-language` | L2 | requirements ready | ubiquitous language ready | `ubiquitous-language.md` |
| F2a | `harness-ubiquitous-question` | L3 | 용어 blocker | 사용자 응답 | 질문 |
| F2b | `harness-ubiquitous-document` | L3 | 확정 용어 | 문서 ready | `ubiquitous-language.md` |
| F3 | `harness-usecases` | L2 | requirements, 용어 ready | UC와 E2E goal ready | UC 문서 묶음 |
| F3a | `harness-usecase-document` | L3 | 확정 UC | UC 문서 작성 | UC 문서 묶음 |
| F4 | `harness-event-storming` | L2 | UC, E2E goal ready | event storming ready | `event-storming.md` |
| F4a | `harness-event-storming-question` | L3 | 모델링 blocker | 사용자 응답 | 질문 |
| F4b | `harness-event-storming-document` | L3 | 확정 모델 | 문서 ready | `event-storming.md` |
| F5 | `harness-ddd-design` | L2 | event storming ready | DDD design ready | `ddd-design.md` |
| F5a-e | `harness-ddd-entity-vo` ~ `harness-ddd-bounded-contexts` | L3 | 이전 DDD gate | candidate DDD ready | `ddd-design.md` |
| F5f | `harness-ddd-question` | L3 | DDD mapping blocker | 사용자 응답 | 질문 |
| F6 | `harness-ddd-integration` | L2 | 대상 DDD design ready | integration ready 또는 no-op | `ddd-architecture.md` |
| F6a-c | integration question, document skills | L3 | integration blocker | 문서 ready | `ddd-architecture.md` |
| F7 | `harness-technical-decisions` | L2 | 통합 DDD architecture ready | ChangeSet 기술 결정 ready | `docs/changes/active/<CHG-ID>/technical-decisions.md` |
| F7a-b | technical decision question, document skills | L3 | 기술 blocker | 문서 ready | `technical-decisions.md` |

## Maintenance lane

| 순서 | Step | Level | 선행 gate | 완료 gate | 산출물 |
|---|---|---:|---|---|---|
| M1 | `harness-maintenance-bootstrap` | L2 | intent `bugfix | refactor`와 `MAINT-<NNN>` | maintenance intake ready | `docs/maintenance/<MAINT-ID>/**` |
| M2 | `harness-technical-decisions` | L2 | 구현 차단 기술 결정 존재 | 기술 결정 ready | `docs/maintenance/<MAINT-ID>/technical-decisions.md` |
| M2a-b | technical decision question, document skills | L3 | 기술 blocker | 문서 ready | `technical-decisions.md` |

architecture impact가 `none`이고 미해결 구현 결정이 없으면 M2를 `skipped`로 기록한다. 기대 동작 근거가 없거나 새 사용자 동작, 정책이 필요하면 `feature`로 재분류한다. 용어 또는 DDD 경계만 부족하면 해당 Feature upstream step으로 보낸다.

## 공통 ChangeSet 실행

| 순서 | Step | Level | 선행 gate | 완료 gate | 산출물 |
|---|---|---:|---|---|---|
| W1 | `harness-code-planner` | L2 | ChangeSet slice ready, 기술 결정 ready 또는 skipped | plan ready | `docs/plans/active/<CHG-ID>/plan.md` |
| W1a | `harness-plan-question` | L3 | 파일, 순서 blocker | 사용자 응답 | 질문 |
| W1b | `harness-plan-document` | L3 | 확정 계획 | plan ready | active plan |
| W2 | `harness-security-plan-reviewer` | L2 | plan ready, 선택된 security controls 존재 | security task 반영 | active plan |
| W3 | `harness-artifact-reviewer` | L2 | W2 완료 또는 skipped | plan approved | review 결과 |
| W4 | `harness-delivery-coordination` | L2 | plan approved, `Delivery: required` Target 존재 | 선언된 전달 대상 준비 | `delivery.md` |
| W5 | `harness-implementation-executor` | L2 | plan, 필요한 delivery ready | 첫 미완료 batch 완료 또는 blocker | 코드, fingerprint 검증 증거 |
| W5a | `harness-codedeploy-pipeline` | L2 | W5 plan 작업 완료, `Deployment Pipeline: codedeploy` | `created | updated | unchanged` 또는 blocker | GitHub Actions workflow, `codedeploy-gate.json` |
| W6 | `harness-security-implementation-reviewer` | L2 | plan 작업 완료, 선택된 security controls 존재 | 보안 review approved | review 결과 |
| W7 | `harness-review` | L2 | plan 작업 완료, W6 완료 또는 skipped | ChangeSet review ready 또는 blocked | `verification.md`, `review.md` |
| W6r/W7r | `harness-implementation-repair` | L2 | W6의 in-scope `security_review_failure` 또는 W7의 in-scope `implementation_failure` | `ready_for_recheck` 또는 blocker | 코드, focused verification evidence, failure fingerprint |
| W7d | `harness-deferred-findings` | L2 | W7의 범위 밖 finding과 사용자 disposition | 모든 finding resolved 또는 needs_input | `deferred-findings.md`, 선택된 Issue URL |
| W7a | `harness-review-document` | L3 | 확정 review 결과 | 결과 기록 | review 문서 |

W2와 W6은 caller-selected security controls가 없으면 `skipped`로 기록한다. W4는
`Delivery: required` Target이 없으면 `skipped`다. W5는 의사결정 없이 연속 실행 가능한
batch를 한 호출에서 처리한다. blocker가 domain, scope, technical, verification 중 하나면
부족한 최소 upstream step으로 돌아간 뒤 종료한다. 유효한 evidence는 재사용하고
invalidated downstream 또는 독립 실행 requirement만 다시 검증한다.
W5a는 `Deployment Pipeline: none`이면 `skipped`다. `codedeploy`여도 기존 workflow와
배포 계약이 같으면 파일을 수정하지 않고 `unchanged`로 통과한다.

W7의 범위 밖 finding은 W7r로 보내지 않는다. 사용자에게 disposition을 질문하고 W7d가
`accepted_scope | follow_up_changeset | github_issue`를 기록한다. `github_issue`는 사용자 승인 뒤에만
생성한다. unresolved finding이 있으면 W7은 `needs_input`이며 C1/C2로 진행하지 않는다.

W6의 `security_review_failure`는 모든 finding이 active plan의 허용 경로 안에서 수정 가능할
때만 W6r로 보낸다. W7의 `implementation_failure`는 현재 변경에서 발생한 컴파일, 테스트,
정적 분석, 설정·연결 오류일 때만 W7r로 보낸다. `scope_conflict`,
`upstream_design_conflict`, `environment_blocker`, `unclear_e2e_goal`,
`verification_goal_unclear`, `document_delta_conflict`는 repair하지 않고 기존 최소 upstream
blocker 경로를 유지한다.

한 failure episode의 repair는 최대 2회다. 같은 failure fingerprint가 다시 관측되면 남은
횟수와 관계없이 즉시 중단한다. W6 repair 뒤에는 W6부터 재검증한다. W7 repair가 선택된
security control을 무효화하면 W6부터, 아니면 W7부터 재검증한다. 재검증은 invalidated
requirement와 독립 실행 requirement만 실행하고 유효한 evidence는 재사용한다.

## ChangeSet 완료

| 순서 | Step | Level | 선행 gate | 완료 gate | 산출물 |
|---|---|---:|---|---|---|
| C1 | `harness-project-wiki` | L2 | ChangeSet review ready, unresolved finding 0건, Documentation Impact가 `local | broad | bootstrap` | 선언 수준 문서 검증·보강 | 선언된 문서 |
| C2 | `harness-changeset-pr` | L2 | ChangeSet review ready, unresolved finding 0건, wiki 완료 또는 skipped | PR 생성 | PR URL |

## 호출 규칙

- L1은 orchestration agent를 호출한다.
- orchestration agent는 route를 결정하고 대상 L2 step skill을 직접 호출한다.
- L2는 필요한 L2 또는 L3만 호출한다.
- 선행 gate 미통과 step은 호출하지 않는다.
- 질문 또는 차단이면 orchestrator는 종료한다.
- `context.md`는 harness 운영 용어 정본이다.
- 선택한 ChangeSet, active plan 및 workflow 문서는 읽거나 수정하지 않는다.
- 각 skill 호출 종료 뒤 `.codex/workflow/token-estimation.md` 기준으로 입력, 출력, 합계 추정 token을 보고한다.
- agent 생성·재사용·대기는 `.codex/workflow/agent-lifecycle.md`를 따른다.
