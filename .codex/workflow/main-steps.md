# 메인 워크플로우

이 파일은 메인 workflow step의 level, 선행 gate, 산출물 정본이다.

| 순서 | Step | Level | 선행 gate | 완료 gate | 산출물 |
|---|---|---:|---|---|---|
| 0 | `harness-orchestrate-instruction` | L1 | 사용자 요청 | ChangeSet 초기화·현재 step 결정 | `docs/changes/active/<CHG-ID>/changeset.md` |
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
| 5 | `harness-ddd-design` | L2 | event storming ready | 다음 검토에서 확정 | DDD 설계 산출물 |
| 6 | `harness-ddd-integration` | L2 | DDD design ready | 다음 검토에서 확정 | 통합 DDD 산출물 |
| 7 | `harness-technical-decisions` | L2 | DDD integration ready | 다음 검토에서 확정 | 기술 결정 산출물 |
| 8 | `harness-code-planner` | L2 | technical decision ready | 다음 검토에서 확정 | 구현 계획 |
| 9 | `harness-implementation-executor` | L2 | plan ready | 다음 검토에서 확정 | 구현 코드·검증 증거 |
| 10 | `harness-review` | L2 | implementation ready | 다음 검토에서 확정 | verifier/gate review |
| 11 | `harness-project-wiki` | L2 | review ready | 다음 검토에서 확정 | wiki |

## 호출 규칙

- L1은 L2만 호출한다.
- L2는 L2 또는 L3만 호출한다.
- 선행 gate 미통과 step은 호출하지 않는다.
- 질문 또는 차단이면 orchestrator는 종료한다.
- `context.md`는 harness 운영 용어 전용이다. 프로젝트 step은 수정하지 않는다.
- ChangeSet 밖 workflow 문서는 읽거나 수정하지 않는다.
- 각 skill 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 보고한다.
