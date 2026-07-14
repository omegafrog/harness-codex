# 메인 워크플로우

이 파일은 메인 workflow step의 level, 선행 gate, 산출물 정본이다.

| 순서 | Step | Level | 선행 gate | 완료 gate | 산출물 |
|---|---|---:|---|---|---|
| 0 | `harness-orchestrate-instruction` | L1 | 사용자 요청 | ChangeSet ID·현재 step 결정 | `docs/changes/active/<CHG-ID>/changeset.md` |
| 0a | `harness-changeset-workspace` | L2 | 새 ChangeSet ID | `origin/main` 또는 `HEAD` 기반 sibling worktree·`changes/<CHG-ID>` branch | worktree 경로 |
| 1 | `harness-requirements` | L2 | `changeset.md` | `requirements.md`의 `status: ready` | `docs/changes/active/<CHG-ID>/requirements.md` |
| 1a | `harness-requirements-question` | L3 | requirements 차단 조건 | 사용자 답변 | 질문 |
| 1b | `harness-requirements-document` | L3 | 확정 입력·질문 결과 | 문서 상태 갱신 | `docs/changes/active/<CHG-ID>/requirements.md` |
| 2 | `harness-ubiquitous-language` | L2 | requirements ready | `ubiquitous-language.md`의 `status: ready` | `docs/changes/active/<CHG-ID>/ubiquitous-language.md` |
| 2a | `harness-ubiquitous-question` | L3 | ubiquitous language 차단 조건 | 사용자 답변 | 질문 |
| 2b | `harness-ubiquitous-document` | L3 | 확정 용어 | `status: ready` 문서 작성 | `docs/changes/active/<CHG-ID>/ubiquitous-language.md` |
| 3 | `harness-usecases` | L2 | requirements·ubiquitous language ready | `use-cases.md`의 `status: ready` | UC 문서 묶음 |
| 3a | `harness-usecase-document` | L3 | 확정 UC | 목록·모든 UC detail·E2E goal 작성 | `docs/changes/active/<CHG-ID>/use-cases/**` |
| 4 | `harness-event-storming` | L2 | 모든 UC detail·E2E goal | 모든 대상 `event-storming.md`의 `status: ready` | `docs/changes/active/<CHG-ID>/use-cases/<UC-ID>/event-storming.md` |
| 4a | `harness-event-storming-question` | L3 | 기존 정책의 모델링 모호성 | 사용자 답변 | 질문 |
| 4b | `harness-event-storming-document` | L3 | 확정 이벤트 스토밍 모델 | `status: ready` 문서 작성 | `docs/changes/active/<CHG-ID>/use-cases/<UC-ID>/event-storming.md` |
| 5 | `harness-ddd-design` | L2 | 모든 대상 `event-storming.md`의 `status: ready` | 모든 대상 `ddd-design.md`의 `status: ready` | `docs/changes/active/<CHG-ID>/use-cases/<UC-ID>/ddd-design.md` |
| 5a | `harness-ddd-entity-vo` | L3 | 대상 `event-storming.md` ready | candidate 문서·첫 Mermaid 작성 | `ddd-design.md` |
| 5b | `harness-ddd-behaviors` | L3 | Entity/VO 완료 | Behaviors 갱신 | `ddd-design.md` |
| 5c | `harness-ddd-application-flow` | L3 | Behaviors 완료 | Application Service Flow 갱신 | `ddd-design.md` |
| 5d | `harness-ddd-aggregates` | L3 | Application Service Flow 완료 | Aggregates 갱신 | `ddd-design.md` |
| 5e | `harness-ddd-bounded-contexts` | L3 | Aggregates 완료 | BC·통신·최종 Mermaid 갱신, `status: ready` | `ddd-design.md` |
| 5f | `harness-ddd-question` | L3 | DDD 구조 매핑 모호성 | 사용자 답변 | 질문 |
| 6 | `harness-ddd-integration` | L2 | 모든 대상 `ddd-design.md`의 `status: ready` | UC 하나면 no-op, 다중 UC면 `ddd-architecture.md`의 `status: ready` | `docs/changes/active/<CHG-ID>/ddd-architecture.md` |
| 6a | `harness-ddd-integration-question` | L3 | 다중 UC DDD 충돌 | 사용자 답변 | 질문 |
| 6c | `harness-ddd-architecture-question` | L3 | 통합 DDD architecture 미결정 | 사용자 선택 | 질문 |
| 6b | `harness-ddd-integration-document` | L3 | 통합된 다중 UC DDD | `status: ready` 문서 작성 | `ddd-architecture.md` |
| 7 | `harness-technical-decisions` | L2 | `ddd-architecture.md` ready 또는 integration no-op의 `ddd-design.md` ready | 기술 문제·기술 기반 확정 후 `technical-decisions.md`의 `status: ready` | `docs/changes/active/<CHG-ID>/technical-decisions.md` |
| 7a | `harness-technical-decision-question` | L3 | 미해결 기술 문제 | 사용자 답변 | 질문 |
| 7b | `harness-technical-decision-document` | L3 | 확정 기술 문제 해결 | `status: ready` 문서 작성 | `technical-decisions.md` |
| 8 | `harness-code-planner` | L2 | `technical-decisions.md` ready와 DDD 설계 ready | `plan.md`의 `status: ready` | `docs/changes/active/<CHG-ID>/plan.md` |
| 8a | `harness-plan-question` | L3 | 파일 매핑·실행 순서 모호성 | 사용자 답변 | 질문 |
| 8b | `harness-plan-document` | L3 | 확정 구현 계획 | `status: ready` 문서 작성 | `plan.md` |
| 9 | `harness-implementation-executor` | L2 | plan ready | 첫 미완료 작업 검증 통과·체크·커밋 또는 blocker | 구현 코드·검증 증거 |
| 10 | `harness-review` | L2 | plan 모든 작업 `- [x]` | `review.md`의 `status: ready` 또는 `blocked` | verifier/gate review |
| 10a | `harness-review-document` | L3 | 확정 review 결과 | `status: ready|blocked` 문서 작성 | `docs/changes/active/<CHG-ID>/review.md` |
| 11 | `harness-project-wiki` | L2 | `review.md`의 `status: ready` | OpenAPI·링크·strict build 통과, wiki 전용 커밋 | `docs/wiki/**`, `mkdocs.yml`, `scripts/*-wiki.sh` |
| 11a | `harness-wiki-source-scan` | L3 | review ready | 구조화된 wiki 근거 반환 | 반환값만 사용 |
| 11b | `harness-wiki-document` | L3 | wiki 근거 | 고정 페이지 작성·갱신 | `docs/wiki/**` |
| 11c | `harness-wiki-mkdocs` | L3 | wiki 문서 | MkDocs 설정·스크립트 갱신 | `mkdocs.yml`, `docs/wiki/requirements.txt`, `scripts/*-wiki.sh` |
| 11d | `harness-wiki-install` | L3 | MkDocs 의존성 선언 | root `venv` 설치 완료 | `venv` |
| 11e | `harness-wiki-verify` | L3 | 문서·MkDocs·설치 완료 | OpenAPI·링크·strict build 통과 | 검증 결과 |
| 11f | `harness-wiki-commit` | L3 | wiki verify 통과 | wiki 변경 한국어 커밋 | Git commit |
| 12 | `harness-changeset-pr` | L2 | wiki 완료 | ChangeSet 산출물 없는 `main` 대상 PR 생성 | PR URL |

## 호출 규칙

- L1은 L2만 호출한다.
- L2는 L2 또는 L3만 호출한다.
- 선행 gate 미통과 step은 호출하지 않는다.
- 질문 또는 차단이면 orchestrator는 종료한다.
- `context.md`는 harness 운영 용어 전용이다. 프로젝트 step은 수정하지 않는다.
- ChangeSet 밖 workflow 문서는 읽거나 수정하지 않는다.
- 각 skill 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 보고한다.
