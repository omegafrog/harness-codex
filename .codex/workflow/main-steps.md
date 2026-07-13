# 메인 워크플로우

이 파일은 메인 workflow step의 level, 선행 gate, 산출물 정본이다.

| 순서 | Step | Level | 선행 gate | 완료 gate | 산출물 |
|---|---|---:|---|---|---|
| 0 | `harness-orchestrate-instruction` | L1 | 사용자 요청 | 현재 step 결정 | workflow 상태 |
| 1 | `harness-requirements` | L2 | 없음 | `docs/design/요구사항.md`의 `status: ready` | `docs/design/요구사항.md` |
| 1a | `harness-requirements-question` | L3 | requirements 차단 조건 | 사용자 답변 | 질문 |
| 1b | `harness-requirements-document` | L3 | 확정 입력·질문 결과 | 문서 상태 갱신 | `docs/design/요구사항.md` |
| 2 | `harness-ubiquitous-language` | L2 | requirements ready | 다음 검토에서 확정 | `CONTEXT.md` |
| 3 | `harness-usecases` | L2 | ubiquitous ready | 다음 검토에서 확정 | use case 산출물 |
| 4 | `harness-event-storming` | L2 | usecase ready | 다음 검토에서 확정 | event storming 산출물 |
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
