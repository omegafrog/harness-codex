# Codex 세션 `019f6e1d-5d71-72e2-bfc8-0d7960f33e45` 워크플로우 감사 보고서

## 1. 결론

이 세션은 완료된 세션이다. 세션 종료 시점에 `CHG-20260717-001`의 계획 42개가 모두 체크됐고, 구현 검토와 wiki 검증을 거쳐 브랜치가 push됐으며 비드래프트 PR이 생성됐다.

다만 완료의 의미를 둘로 나누어야 한다.

| 판정 대상 | 판정 | 요약 |
| --- | --- | --- |
| Harness 절차 완료 | 완료 | Feature lane F1~F7, 공통 W1~W7, 완료 C1~C2를 최종적으로 모두 통과했다. |
| 형식적 gate 준수 | 대체로 준수 | 요구사항 재시작, plan 독립 검토, blocked review 보수, 재검증, wiki, PR까지 연결됐다. |
| 워크플로우 효율 | 낮음 | 초기 산출물 폐기, 1,728회 대기 호출, 불명확한 executor batch 경계와 반복 상태 복구가 있었다. |
| 사용자 원래 제품 의도 충족 | 범위 판정 불명확 | MVP 구현 범위를 unit/component 수준으로 볼지, 실제 AI·HTTP 통합 실행까지 볼지 ChangeSet이 선언하지 않았다. |
| 최종 W7 review 신뢰성 | 제한적 | 선언된 53/53 명령은 통과했지만 검증 수준을 표시하지 않아 `ready`가 곧 live product ready로 오해될 수 있다. |

따라서 최종 종합 판정은 **“워크플로우는 완료됐으나 Harness가 완료의 검증 수준과 범위 밖 발견사항의 후속 처리를 충분히 정의하지 않았다”**이다.

## 2. 감사 범위와 근거

감사 대상은 다음과 같다.

- 루트 세션 JSONL 1개
- 같은 `session_id`를 가진 서브에이전트 JSONL 41개
- 최대 중첩 깊이 4의 에이전트 트리
- ChangeSet worktree의 요구사항, DDD architecture, plan, review, wiki 및 제품 코드
- 브랜치 commit과 GitHub PR 상태
- 당시 설치된 `.codex/workflow/main-steps.md`와 orchestration 지침

확인된 정량 근거는 다음과 같다.

| 항목 | 값 |
| --- | ---: |
| 세션 로그 파일 | 42개 |
| 서브에이전트 세션 | 41개 |
| `spawn_agent` 호출 | 61회 |
| 에이전트 협업 도구 호출 | 2,431회 |
| `wait_agent` | 1,433회 |
| `wait` | 295회 |
| 전체 대기 호출 비중 | 71.1% |
| 계획 완료 | 42/42 |
| review가 보고한 명령 통과 | 53/53 |
| PR 포함 commit | 43개 |
| 생성 PR | `omegafrog/dnd-master#1` |

`spawn_agent` 61회 중 41개만 고유 서브에이전트 세션 로그로 남았다. 나머지 호출은 실패, 중복 시도 또는 고유 세션을 만들지 못한 호출로 보이며, 특히 중첩 한도와 agent slot 문제를 처리하는 과정에서 호출 낭비가 확인된다.

## 3. 정의된 워크플로우와 실제 실행

당시 정본 `.codex/workflow/main-steps.md`는 Feature 요청에 다음 순서를 요구한다.

```text
F1 Requirements
→ F2 Ubiquitous Language
→ F3 Use Cases
→ F4 Event Storming
→ F5 DDD Design
→ F6 DDD Integration
→ F7 Technical Decisions
→ W1 Plan
→ W2 Security Plan Review 또는 skipped
→ W3 Artifact Review
→ W4 Delivery Coordination
→ W5 Implementation 반복
→ W6 Security Implementation Review 또는 skipped
→ W7 ChangeSet Review
→ C1 Project Wiki
→ C2 ChangeSet PR
```

| 단계 | 실제 실행 | 판정 |
| --- | --- | --- |
| L1 / workspace | 원문을 `/root/orchestration`에 전달하고 sibling worktree와 ChangeSet을 생성했다. | 준수 |
| F1 Requirements | 최초 인터뷰가 너무 빨리 `ready`를 선언했다. 사용자 이의 후 Harness update와 ChangeSet reset을 거쳐 19개 결정 질문으로 다시 수행했다. | 최종 준수, 최초 품질 실패 |
| F2 Ubiquitous Language | 최초 산출물은 폐기됐고 v2가 재작성했다. | 최종 준수 |
| F3 Use Cases | 최초 6개 UC는 폐기됐고 v2에서 10개 UC와 E2E goal을 작성했다. | 최종 준수 |
| F4 Event Storming | 최초 일부가 폐기됐다. v2에서는 UC-001~010을 UC별 입력 격리 규칙으로 작성했다. | 최종 준수 |
| F5 DDD Design | 두 agent가 UC-001~005, UC-006~010을 나눠 Entity/VO부터 BC까지 설계했다. | 준수, 승인 비용 과다 |
| F6 DDD Integration | `ddd_integrator`가 후보를 통합하고 실제 충돌만 질문했다. | 준수 |
| F7 Technical Decisions | Java 21, Spring Boot/Spring AI, PostgreSQL/pgvector 등을 확정했다. | 준수 |
| W1 Plan | 36개 초기 작업을 만들고 blocked review 보수 6개를 추가해 총 42개가 됐다. | 준수 |
| W2 Security plan review | 선택된 security control이 없다는 이유로 skipped됐다. | 규칙상 허용, selector 품질 의문 |
| W3 Artifact review | 독립 reviewer가 두 차례 blocker를 제시했고 plan 보수 후 승인했다. | 준수, 유효한 gate |
| W4 Delivery | 외부 저장소 없음으로 `delivery.md`를 기록했다. | 준수 |
| W5 Implementation | 여러 executor가 42개 작업을 commit 단위로 완료했다. blocked review 후 6개 repair 작업도 실행했다. | 준수, 실행 방식 비효율 |
| W6 Security implementation review | 선택된 security control이 없어 skipped됐다. | 규칙상 허용, 위험 기반 검토 부족 |
| W7 Review | 최초 blocker를 기록한 뒤 repair plan, 독립 재검토, 재실행을 거쳐 `review.md status: ready`로 바꿨다. | 절차는 준수했지만 달성한 verification level을 표시하지 않았다. |
| C1 Wiki | source scan, 작성, MkDocs 구성, 설치, 검증, 별도 한국어 commit을 수행했다. | 준수 |
| C2 PR | wiki build와 금지 경로 guard 후 push하고 비드래프트 PR을 생성했다. | 결과 준수, 호출 경로 일부 이탈 |

## 4. 모든 서브에이전트 검토

### 4.1 오케스트레이션 및 초기 폐기 흐름

| 경로 | 역할과 결과 | 평가 |
| --- | --- | --- |
| `/root/orchestration` | 전체 route, gate 회귀, agent 재사용, 구현·review·wiki·PR 연결 | 단계 연결은 성공했지만 858회의 `wait_agent`와 장기 컨텍스트 유지로 비효율적이었다. |
| `requirements_interviewer` | 큰 질문 3개 뒤 requirements ready | 요구사항 안정성을 충분히 확인하지 않아 downstream 폐기를 초래했다. |
| `ubiquitous_language_reviewer` | 최초 19개 용어 작성 | 입력 requirements가 실질적으로 불안정해 결과가 폐기됐다. |
| `harness_usecases` | 최초 UC 6개 작성 | 조기 downstream 진행으로 폐기됐다. |
| `oracle_uc_001_003` | 최초 UC-001~003 이벤트 스토밍 진입 | 사용자 중단으로 미완료·폐기됐다. |
| `oracle_uc_004_006` | UC-004 작성 후 blocked | 사용자 요구사항 이의가 발생한 상황에서 계속 진행돼 낭비가 커졌다. |

### 4.2 재시작된 분석·설계 흐름

| 경로 | 역할과 결과 | 평가 |
| --- | --- | --- |
| `requirements_interviewer_v2` | 19개 결정을 최대 3개씩 질문하고 requirements ready | 사용자 지시와 요구사항 인터뷰 목적을 잘 지켰다. |
| `ubiquitous_language_v2` | v2 요구사항 기반 canonical term 확정 | 적절 |
| `harness_usecases_v2` | UC 10개와 E2E goal 작성 | 적절 |
| `oracle_001_005_v2` | UC-001~005 이벤트 스토밍 | UC별 입력 격리를 지켰다. |
| `oracle_006_010_v2` | UC-006~010 이벤트 스토밍 | UC별 입력 격리를 지켰다. |
| `ddd_001_005` | UC-001~005 후보 DDD | 설계는 체계적이나 추천안 승인 요청이 지나치게 세분화됐다. |
| `ddd_006_010` | UC-006~010 후보 DDD | 같은 승인 비용 문제가 있었다. |
| `ddd_integrator` | 다중 UC 통합 DDD | 중복 Aggregate와 BC 충돌을 필요한 범위에서 해결했다. |
| `technical_decisions` | 기술 결정 문서 작성 | 기술 선택은 기록했지만 provider wiring이 현재 범위인지 후속 범위인지 선언하지 않았다. |

### 4.3 계획·독립 검토·전달

| 경로 | 역할과 결과 | 평가 |
| --- | --- | --- |
| `implementation_planner` | 초기 36개 작업 계획 | 폭넓은 계약을 작성했지만 runnable endpoint/provider 검증의 적용 여부와 후속 처리 기준을 선언하지 않았다. |
| `plan_artifact_reviewer` | plan review 조정 | 두 차례 회귀를 유도한 점은 유효했다. |
| `independent_plan_review` | 독립 plan 검토 | 책임·트랜잭션·검증 누락을 발견했지만 운영 AI/API 완결성은 놓쳤다. |
| `delivery_coordinator` | 외부 저장소 없음 기록 | 적절 |

### 4.4 구현 executor

| 경로 | 역할과 결과 | 평가 |
| --- | --- | --- |
| `implementation_executor` | 초기 작업과 Docker blocker 처리 | blocker 분류는 적절했지만 agent 수명이 길었다. |
| `implementation_executor_resume` | 중단 상태 감사와 PLN-003A 재개 | 상태 복구는 했지만 동일 감사 반복 비용이 있었다. |
| `executor_pln003a` | PLN-003A부터 다수 작업을 연속 실행 | 가장 큰 컨텍스트 팽창 구간이다. 중단·프로세스 정리·재감사가 반복됐다. |
| `executor_pln011b` | runtime, E2E, 성능, migration, architecture 작업 | 검증·commit 정리는 양호했지만 여전히 한 agent 범위가 넓었다. |

### 4.5 최종 review와 repair

| 경로 | 역할과 결과 | 평가 |
| --- | --- | --- |
| `review_chg001` | 최초 51개, 최종 53개 명령 기반 review | 환경과 구현 결함을 찾아 repair를 유도했으나 최종 제품 동작 검증은 불충분했다. |
| `plan_repair_review` | blocked review를 PLN-014 계열로 계획화 | 적절 |
| `review_repair_plan` | repair plan 승인 조정 | 적절 |
| `artifact_review` | repair plan 독립 검토 | Failsafe 경로 누락을 찾아 보수시켰다. |
| `independent_recheck` | 수정된 repair plan 재승인 | 적절 |
| `executor_pln014` | Java 21 실행환경 정규화 | 적절 |
| `executor_pln014a` | UI lint/typecheck/build 복구 | 적절 |
| `executor_pln014b` | Vitest/Playwright 수집 경계 복구 | 적절 |
| `executor_pln014c` | runtime smoke 종료 코드 보수 | 스크립트 결함은 고쳤지만 smoke 범위가 health/OpenAPI/UI root에 그쳤다. |
| `executor_pln014d` | Failsafe 선택자 전파 복구 | 적절 |
| `executor_pln014e` | Failsafe classpath/property 복구 | 적절 |

### 4.6 Wiki와 PR

| 경로 | 역할과 결과 | 평가 |
| --- | --- | --- |
| `wiki_source_scan` | review ready 근거 수집 | review가 표시하지 않은 verification level과 deferred finding을 보완할 계약이 없었다. |
| `wiki_write` | 한국어 프로젝트 wiki 작성 | 절차상 적절 |
| `wiki_mkdocs` | MkDocs 설정과 script 생성 | 적절 |
| `wiki_install` | wiki 의존성 설치 | 적절 |
| `wiki_verify` | 링크·OpenAPI·strict build 검증 | 문서 검증은 적절하나 제품 기능 검증은 범위 밖이었다. |
| `wiki_commit` | wiki만 별도 한국어 commit | 역할 경계를 잘 지켰다. |
| `/root/changeset_pr` | build, diff guard, push, PR 생성 | 결과는 적절하다. orchestration 하위 한도 때문에 root가 호출한 것은 정본 호출 경로의 경미한 이탈이다. |

## 5. 주요 비효율

### 5.1 초기 요구사항 false-ready와 현재 보완 상태

최초 requirements agent는 제품 정책이 충분히 결정되지 않았는데도 `ready`를 선언했다. 이후 용어, 6개 UC, 일부 이벤트 스토밍까지 진행됐고 사용자가 “왜 요구사항 질문을 하나도 안 해?”라고 중단했다.

폐기 비용은 최소 5개 서브에이전트 세션과 최초 requirements, ubiquitous language, UC 6개, 이벤트 스토밍 일부다.

현재 Harness에는 이 문제를 직접 막는 보완이 이미 반영돼 있다.

- `requirements_interviewer.md`가 목표, 행위자, 범위, 성공·실패, 사업 정책, 비기능 요구사항의 결정 트리를 요구한다.
- `interview-protocol.md`가 7개 영역과 측정 가능한 acceptance signal을 점검한다.
- 모든 미확정 결정 해소 후 최종 요약에 대한 사용자 동의를 받기 전에는 requirements 문서를 쓰지 못한다.
- 현재 workflow 관련 회귀 테스트 20개가 통과했다.

따라서 5.1은 신규 구조 개선 과제로 다시 제안할 필요가 낮다. 다만 현재 테스트가 requirements readiness 문구 자체를 직접 고정하지는 않으므로, 위 세 조건을 검증하는 좁은 contract test를 추가하면 재발 방지 근거가 더 명확해진다.

### 5.2 대기 중심 오케스트레이션

협업 도구 호출 2,431회 중 `wait_agent` 1,433회와 `wait` 295회가 71.1%를 차지한다. 루트는 `wait_agent` 562회, orchestration agent는 858회를 호출했다.

이는 subagent 완료를 지나치게 짧은 간격으로 확인했거나, 한 agent를 장기간 유지하면서 매 메시지 경계를 추적한 결과다. 완료·질문·blocker 이벤트만 wake하도록 하고 cursor 기반 bounded wait를 사용해야 한다.

### 5.3 executor 재사용과 batch 경계

이 세션에서 executor를 오래 재사용한 선택 자체는 합리적이다. plan task마다 새 executor를 만들면 repository 구조, plan 계약, 실행 환경을 매번 다시 읽어야 하므로 context 초기화 비용이 더 커질 수 있다.

현재 Harness도 이 판단을 반영한다.

- planner는 의사결정 없이 연속 실행 가능한 작업을 같은 batch로 묶는다.
- executor는 같은 batch에 미완료 작업이 있으면 context를 유지한다.
- 단순 context 재로딩이나 작업별 commit 때문에 batch를 나누지 않는다.
- 유효한 verification evidence를 재사용하고 invalidated requirement만 다시 실행한다.

문제는 재사용 자체가 아니라 재사용 경계가 불명확했던 점이다. `executor_pln003a`와 `executor_pln011b`는 서로 다른 관심사와 환경 검증을 장기간 누적했고, 중단 뒤 상태 감사가 반복됐다.

따라서 executor를 plan item마다 교체하라는 기존 권고는 철회한다. 같은 batch와 같은 environment fingerprint에서는 재사용하고, 다음 경우에만 checkpoint 후 새 context 또는 새 executor로 전환하는 것이 적절하다.

- bounded context 또는 기술 영역이 크게 바뀜
- dependency나 environment fingerprint가 바뀜
- blocker·verification failure로 upstream 회귀함
- context compaction 뒤 현재 batch 근거를 안정적으로 복원할 수 없음
- 실행 중 프로세스와 미커밋 상태가 다음 batch에 영향을 줌

checkpoint에는 focused verification, scope guard, plan check, commit, `EvidenceEnvelope`, 남은 batch를 포함한다.

### 5.4 7개 서비스 구조와 ChangeSet 크기

1인용 초기 제품에 7개 BC를 독립 Spring Boot 서비스로 구현하면서 서비스별 DB/schema/account, OpenAPI, health, Swagger, contract, migration, runtime process 관리가 필요해졌다.

7개 서비스 선택 자체를 사후에 오류로 단정하기는 어렵다. 사용자가 선택했고 DDD 통합 결과에도 부합한다. Harness 관점의 문제는 이 범위를 한 ChangeSet에서 어느 검증 수준까지 완료할지 명시하지 않았다는 점이다.

MVP ChangeSet이라면 domain/application unit test와 정적 계약까지를 이번 완료 기준으로 두고, 실제 provider·live API·배포 통합은 후속 ChangeSet으로 분리할 수 있다. 반대로 “실행 가능한 제품”이 완료 기준이면 처음부터 live integration 작업과 환경을 plan에 포함해야 한다.

### 5.5 43개 미세 commit의 장단점

42개 plan 작업과 wiki를 43개 commit으로 분리한 것은 추적성과 rollback에는 좋다. 반면 scope guard, 계획 체크, commit 보고가 매 작업 반복됐다. 독립적으로 되돌릴 필요가 없는 같은 batch의 강결합 작업은 batch commit으로 묶을 수 있다.

## 6. 범위 밖 발견사항과 후속 전환 누락

아래 6.1~6.3은 이번 ChangeSet의 구현 범위를 MVP domain/application skeleton과 unit 중심 검증으로 해석하면 직접 blocker가 아닐 수 있다. 문제는 Harness가 이 항목들을 `out of scope`, `deferred`, `follow-up required` 중 무엇으로 판단했는지 기록하지 않고 `ready`만 선언했다는 점이다.

### 6.1 실제 AI provider가 없다

`ai-game-master-service/pom.xml`에는 `spring-ai-client-chat`만 있고 Ollama/OpenAI 등 model provider starter가 없다. 운영 코드에는 `ChatModel`을 주입받는 `SpringAiChatAdapter`가 있으나 실제 `ChatModel` bean, base URL, model name, API key 또는 local model 설정이 없다.

테스트는 fake `ChatModel`, WireMock, 즉시 응답 model을 사용하므로 실제 모델 호출, streaming, provider 변경, local model 연결은 이번 ChangeSet에서 증명되지 않았다.

이것이 plan 밖이라면 W7은 실패시킬 필요가 없다. 대신 후속 ChangeSet 후보나 GitHub Issue로 기록하고 사용자에게 “현재 완료 범위에는 실제 provider 연결이 포함되지 않는다”고 알려야 한다.

### 6.2 실제 embedding 구현이 없다

`EmbeddingPort`는 interface만 있고 `src/main`에 이를 구현하는 adapter가 없다. system test와 service test는 `FakeEmbedding` 또는 recording port를 사용한다.

따라서 pgvector 저장·검색 SQL은 존재하지만, 실제 embedding model로 벡터화하는 운영 경로는 이번 ChangeSet에서 검증되지 않았다. 이것도 의도된 MVP 범위 밖이라면 blocker가 아니라 명시적 후속 항목이어야 한다.

### 6.3 대부분의 공개 API endpoint가 없다

7개 서비스에는 다수의 domain/application class와 정적 OpenAPI 계약이 있지만, 실제 `@RestController`는 Identity Access의 인증 controller가 사실상 유일하다. UI는 여러 공개 API를 `fetch`하지만 이를 처리하는 backend route가 없다.

`OpenApiIntegrationTest`와 `verify-runtime.ps1`는 `/swagger-ui/index.html`, `/v3/api-docs`, `/actuator/health`, UI root를 확인한다. 이 smoke는 프로세스 기동·문서 endpoint 증거로는 유효하지만 업무 기능 live E2E 증거는 아니다. 부족한 endpoint 구현이 이번 범위 밖이라면 후속 항목으로 전환해야 한다.

### 6.4 E2E라는 이름과 실제 검증 수준이 다르다

Java system test는 주요 객체를 직접 조립하고 fake AI·fake embedding을 사용한다. Playwright는 UI 동작을 검증하지만 실제 7개 backend endpoint와 AI/RAG를 통과하는 live E2E는 아니다.

MVP ChangeSet에서 이 수준의 테스트만 요구하는 것은 허용할 수 있다. 문제는 이를 live E2E와 구분하지 않고 같은 `E2E pass`로 보고한 점이다.

> plan 42/42 완료. Java 21·Docker Desktop 환경에서 구체 검증 명령 53/53 exit 0.

명령 통과 자체는 사실이다. 다만 Harness는 다음 중 어떤 완료 수준인지 표시했어야 한다.

- `unit_ready`: domain/application unit와 정적 계약 통과
- `component_ready`: DB, fake provider, 단일 서비스 통합 통과
- `live_e2e_ready`: 실제 실행 서버, 실제 공개 API, 선택된 provider를 통한 사용자 여정 통과

모든 ChangeSet에 `live_e2e_ready`를 강제하는 것은 과도하다. 요구사항 또는 plan 단계에서 필요한 검증 수준을 사용자에게 확인하고, 선택하지 않은 상위 수준은 후속 항목으로 남기는 편이 적절하다.

## 7. 준수 위반 및 경미한 이탈

| 항목 | 심각도 | 판단 |
| --- | --- | --- |
| 최초 requirements false-ready | 높음 | 형식 status는 맞았지만 F1의 실질 완료 gate를 위반했다. 현재 Harness에는 직접 보완이 반영됐다. |
| W7의 검증 수준 미표시 | 높음 | unit/component 중심 결과를 `E2E pass`와 `ready`로만 표시해 live readiness로 오해할 수 있다. |
| 범위 밖 finding 미처리 | 높음 | blocker가 아닐 수 있는 구현 공백을 후속 ChangeSet, Issue 또는 사용자 고지로 전환하지 않았다. |
| Security W2/W6 skip | 중간 | 명시 규칙에는 맞지만 인증, 파일 업로드, AI, RAG가 있는 제품에서 control selector가 0개를 선택한 것은 재검토 가치가 있다. |
| C2를 root가 직접 호출 | 낮음 | orchestration 하위 agent 한도 회피를 위해 상위 root가 전용 agent를 호출했다. 결과·역할은 보존됐지만 정본 호출 규칙과 다르다. |
| PR 상태 `UNSTABLE` | 참고 | 세션의 PR 생성 목표는 완료됐지만 현재 GitHub PR은 OPEN, non-draft, merge state `UNSTABLE`이다. PR merge까지가 이 세션 목표였다는 근거는 없다. |

## 8. 잘 수행한 부분

- 초기 요구사항 문제를 숨기지 않고 Harness update와 ChangeSet reset 후 처음부터 다시 진행했다.
- v2 requirements는 한 번에 최대 3개 질문이라는 사용자 지시를 지켰다.
- UC별 event storming 입력을 격리했다.
- DDD 후보와 통합 DDD를 분리했다.
- plan을 독립 검토하고 blocker를 구현 전에 두 차례 보수했다.
- 구현을 work item별 commit으로 남겨 추적성을 확보했다.
- 최초 W7 blocker를 무시하지 않고 repair plan 6개를 추가했다.
- Java 21, UI script, Vitest 경계, runtime exit code, Failsafe classpath/selector 문제를 실제로 고쳤다.
- wiki source scan, 작성, build, 검증, commit 역할을 분리했다.
- PR 전에 ChangeSet 전용 산출물 금지 경로 diff guard를 수행했다.

## 9. 사용자 리뷰 평가

| 사용자 판단 | 평가 | 이유 |
| --- | --- | --- |
| 5.3 승인 턴 비효율은 제외 | 타당 | 인터랙티브 DDD의 승인 빈도는 선호와 위험 허용도의 문제이며, 이번 감사의 핵심 Harness 결함으로 보기 어렵다. 보고서에서 제외했다. |
| 5.1은 Harness 수정 후 필요성을 다시 판단 | 타당 | 현재 결정 트리, 최종 사용자 동의, 문서 작성 금지 규칙이 이미 반영됐다. 신규 권고 대신 좁은 회귀 테스트만 남기는 것이 맞다. |
| executor를 plan마다 새로 만들기보다 재사용 | 대체로 타당 | 같은 batch에서는 context 재사용이 더 효율적이다. 다만 무제한 재사용은 context 오염과 복구 비용을 키우므로 batch·fingerprint·blocker 경계가 필요하다. |
| 6.1~6.3은 앱 구현 범위 밖일 수 있음 | 타당 | MVP scope라면 직접 blocker가 아닐 수 있다. 핵심 결함은 발견사항을 후속 Issue/ChangeSet 또는 사용자 고지로 전환하는 절차가 없다는 점이다. |
| 매 ChangeSet에 실구현 live E2E는 과다 | 타당 | unit/component 수준도 MVP increment의 합리적인 완료 기준이다. 단, 그 결과를 live E2E ready라고 부르면 안 된다. |
| 더 엄밀한 E2E suite를 gate로 삼을지 물어야 함 | 타당 | 검증 비용과 신뢰 수준은 제품·릴리스 결정이다. requirements 또는 plan gate에서 사용자가 선택해야 한다. |
| 구현 부족보다 Harness 구조 불충분을 봐야 함 | 타당 | provider·embedding·endpoint 누락은 원인이라기보다 scope/verification/deferred-finding 계약 부족이 만든 결과다. |

종합하면 사용자 판단은 대부분 맞다. 유일한 보완점은 “unit test면 충분하다”를 모든 MVP의 보편 규칙으로 두지 않는 것이다. 외부 공개, 데이터 migration, 보안, 결제처럼 실패 비용이 큰 변경은 MVP여도 integration 또는 live E2E가 필요할 수 있다. 따라서 고정된 테스트 종류보다 ChangeSet별 `required verification level` 선언이 더 적절하다.

## 10. 개선 권고

### P0: ChangeSet별 검증 수준 선언

Requirements 또는 plan에서 다음을 명시하고 필요하면 사용자에게 질문한다.

1. 이번 ChangeSet의 목표 수준: `unit_ready | component_ready | live_e2e_ready`
2. 각 수준의 필수 probe와 실행 환경
3. 환경상 실행 불가능할 때 대체 evidence 허용 여부
4. 선택하지 않은 상위 수준의 후속 처리 방식

W7은 모든 ChangeSet에 live E2E를 강제하지 않고 선언된 수준을 정확히 검증한다. review와 PR에는 달성 수준을 그대로 표시한다.

### P0: 범위 밖 발견사항 disposition gate

reviewer가 필요한 기능 또는 검증 공백을 발견했지만 active plan 범위 밖이면 자동으로 현재 구현을 확장하지 않는다. 대신 모든 finding에 다음 disposition 중 하나를 강제한다.

- `accepted_scope`: 현재 완료 기준에 포함되지 않음을 사용자가 승인
- `follow_up_changeset`: 후속 ChangeSet 후보 기록
- `github_issue`: 권한과 repository가 있으면 Issue 생성
- `user_notified`: 외부 변경 없이 최종 응답과 PR body에 명시

미처리 finding이 있으면 W7은 `ready`가 아니라 `question` 또는 `ready_with_deferred_findings`를 반환해야 한다.

### P1: E2E 명칭과 suite 계층화

- unit: domain/application 단위
- component/integration: DB, fake provider, 단일 서비스 경계
- contract: OpenAPI/consumer-provider 정적 또는 실행 계약
- smoke: process, health, Swagger, UI root
- live E2E: 실행 서버의 실제 공개 endpoint와 선택된 외부/로컬 provider를 통과하는 사용자 여정

각 probe는 한 계층만 주장해야 한다. health/OpenAPI smoke와 fake 기반 component test를 `live E2E`로 합산하지 않는다.

### P1: OpenAPI와 구현 route 일치 검증

`live_e2e_ready` 또는 실제 API 제공이 현재 scope인 ChangeSet에만 강제한다. 정적 OpenAPI 문서 존재가 아니라 모든 operation이 실제 handler에 매핑되는지 검사하고, 대표 공개 endpoint를 실행 중 서버에 호출한다. scope 밖이면 후속 finding으로 기록한다.

### P1: Requirements readiness 회귀 계약

현재 구현된 결정 트리, 미확정 결정 해소, 최종 사용자 동의 규칙을 직접 검증하는 contract test를 추가한다. 기존 구조는 유지한다.

### P1: 보안 baseline 자동 선택

인증, 파일 업로드, AI, RAG, private data 중 하나라도 있으면 W2/W6을 자동 skip하지 말고 최소 baseline review를 실행하는 방안을 검토한다.

### P1: executor context 재사용 계약

- 같은 batch와 같은 fingerprint에서는 executor context를 재사용한다.
- task별 agent 재생성을 요구하지 않는다.
- batch 변경, 환경 변경, upstream 회귀, context 복원 불가 시에만 checkpoint 후 교체한다.
- commit, `EvidenceEnvelope`, invalidated requirement를 재개 정본으로 사용한다.

### P1: 대기 호출 축소

- cursor 기반 bounded wait 사용
- unchanged status polling 금지
- 완료 결과를 `EvidenceEnvelope`로 원자적 기록
- agent depth/slot을 시작 전에 예약

### P2: ChangeSet 크기와 후속 분할

한 ChangeSet에서 unit/component MVP까지만 완료할지, live integration까지 포함할지 먼저 정한다. 후자를 감당하기 어려우면 provider wiring, 업무 API, live E2E를 후속 ChangeSet으로 명시적으로 분할한다.

## 11. 최종 판정

세션은 **절차상 완료**됐다. PR 생성까지의 Harness 흐름도 최종적으로 연결됐다. 실제 AI provider, embedding adapter, 업무 HTTP endpoint가 없는 점은 이번 ChangeSet의 선언 범위에 따라 blocker일 수도, 정당한 후속 범위일 수도 있다. 세션에서는 그 구분을 명시하지 않았다.

따라서 다음 두 문장을 동시에 기록하는 것이 가장 정확하다.

1. **세션과 선언된 Harness 단계는 완료됐다.**
2. **Harness가 verification level과 deferred finding disposition을 선언하지 않아 완료 결과의 의미가 불명확했다.**

이 감사에서 가장 우선적으로 수정해야 할 대상은 앱 코드나 agent 수가 아니라 Harness의 scope·verification·follow-up 계약이다. 모든 ChangeSet에 live E2E를 강제할 필요는 없지만, 무엇을 검증했고 무엇을 후속으로 넘겼는지는 gate가 명확히 말해야 한다.
