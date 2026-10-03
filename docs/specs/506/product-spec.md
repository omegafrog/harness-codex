# Product Spec — 506 Engineering Decision Layer

## 1. Problem and Context

기존 planning 및 implementation 흐름에 들어가기 전에, 사용자와 에이전트가 기술적 결정을 근거와 함께 정리하고 검토할 수 있는 Engineering Decision Layer가 필요하다. 현재 이 결정 단계가 없으면 요구사항과 목표, 대안, 근거, trade-off, 확장 경계가 하나의 추적 가능한 결과로 연결되지 않을 수 있다.

이 기능은 기존 downstream planning/implementation 흐름에 앞서 동작한다.

## 2. Goals and Desired Outcomes

- 결정과 관련된 시스템 특성을 파악하고, 해당 특성에 관련 있는 비기능 요구사항 질문만 제시한다.
- Current, Expected Growth, Architecture Boundary 목표를 필요한 범위에서 수집하고, 미확정 목표는 출처와 신뢰도를 포함한 정당화된 추정 또는 조사 결과로 다룬다.
- Code와 Infrastructure 결정을 분리해 요구사항 및 목표와 연결하고, 검토 가능한 근거·대안·trade-off·확장 경계를 남긴다.
- 지식 원칙과 evidence를 독립적인 근거 검토, 반대 근거 탐색, 사람의 승인과 함께 축적한다.
- 최종 architecture 및 ADR에 결정의 이유와 추적 정보를 포함해 downstream architecture context로 전달한다.

## 3. Users and Actors

| Actor | 책임 |
|---|---|
| 사용자 | Normal agent 흐름에서 결정을 내린다. Learning 흐름에서는 제안을 하고 방어한다. |
| Normal agent | 문제를 조사하고 대안을 제안하며 결정 검토 자료를 준비한다. 사용자를 대신해 결정하지 않는다. |
| Learning user | 결정을 제안하고 그 근거와 trade-off를 방어한다. |
| Reviewer | Learning 흐름에서 가정, 복잡성, 근거 없는 주장, 지표, 확장성, 운영 및 실패 처리를 검토하고 이의를 제기한다. 답을 대신 제시하지 않는다. |
| Researcher | 자료를 발견하고 출처를 분류한다. 원칙이나 결론을 만들지 않는다. |
| Human approver | Principle 후보의 승인 여부를 결정한다. |

## 4. Ubiquitous Language and Terminology

| Term | Definition |
|---|---|
| Engineering Decision Layer | 기존 planning/implementation 전에 결정 근거와 검토를 수행하는 workflow 단계 |
| System Characteristics | interaction, workload, state, consistency, availability, growth 특성. 관련 NFR 질문의 범위를 결정한다. |
| Current / Expected Growth / Architecture Boundary | 현재 목표, 예상 성장 목표, 아키텍처 경계 목표의 세 관점 |
| Decision | Code 또는 Infrastructure 범주에서 문제·제약·대안·근거·trade-off·선택·확장 경계를 기록한 결과 |
| Learning / Normal | 기본 모드인 Learning은 사용자가 제안을 방어하고 Reviewer가 이의를 제기하는 모드 / 사용자가 명시적으로 선택하거나 전환할 수 있는 Normal은 에이전트가 조사·제안하고 사용자가 결정하는 모드 |
| Source / Claim / Principle / Evidence | 조사 출처 / 출처의 특정 위치·맥락·한정 조건과 연결된 원자적 주장 / 조건과 예외가 명시된 재사용 가능한 지식 원칙 / 프로젝트 결정 또는 주장에 관련된 관찰·근거 |
| Code Validation Run / Decision Validation Run | 코드 정합성·회귀 동작을 확인하는 실행 / 특정 Architecture Decision의 명시된 조건을 검증하도록 설계한 실행 |
| Consensus | 명시된 적용 조건과 예외 범위 내에서 근거가 지지하는 합의 수준 |
| Architecture Boundary | 수치 또는 관찰 가능한 조건으로 표현한 확장·운영 경계. 그 자체로 용량 보장을 뜻하지 않는다. |

## 5. Core Use Cases

### UC-001 — Normal 결정 수립

사용자는 결정 필요성을 제시한다. 에이전트는 System Characteristics를 정리하고 관련 NFR 질문을 선택한다. Current, Expected Growth, Architecture Boundary 목표 중 해당하는 항목을 수집한다. 알 수 없는 값은 정당화된 추정 또는 조사로 해소하고 값, 단위, provenance, 신뢰도, rationale을 기록한다. 에이전트는 Code 및 Infrastructure 결정을 각각 문제, 제약, 대안, evidence, trade-off, 결정, scaling boundary로 정리하고 관련 requirement 및 target에 연결한다. 사용자가 결정한다. 채택되지 않은 대안은 기각 이유와 함께 남긴다.

다이어그램: [UC-001 유스케이스](diagrams/product/UC-001.usecase.svg), [UC-001 액티비티](diagrams/product/UC-001.activity.svg)

### UC-002 — Learning 결정 방어 및 검토

기본 workflow는 Learning이다. 사용자는 결정을 제안하고 방어한다. Reviewer는 발견한 새 연구 자료를 먼저 source, claims, context와 함께 사용자에게 제시해 자료 사용 승인을 받는다. 사용자가 거부한 자료는 제외하고 대체 자료를 찾거나 충분한 자료가 없으면 결정을 보류한다. 이 자료 사용 승인은 Principle 승인과 별도다. 이후 Reviewer는 가정, 복잡성, unsupported claims, metrics, scaling, operations, failure handling을 검토하고 이의를 제기하되 답을 제공하지 않는다. 검토는 요구사항, 목표, 대안, trade-off, evidence, boundary와 주요 이의에 대한 답변이 명시적인 체크리스트를 충족하는지 확인한다. Reviewer의 각 이의는 provenance를 포함한다. 사용자는 명시적으로 Normal을 선택하거나 Learning/Normal 간 전환할 수 있다.

다이어그램: [UC-002 유스케이스](diagrams/product/UC-002.usecase.svg), [UC-002 액티비티](diagrams/product/UC-002.activity.svg)

### UC-003 — Principle 후보 수집 및 승인

Researcher는 자료를 발견하고 분류한다. workflow는 출처 자격 확인, 자료 수집, 원자적 claim 추출, 독립 corroboration, 필수 counter-evidence 탐색, 원칙의 조건·예외·support·counter synthesis, review, human approval, publish 순서로 진행한다. `spec-me`는 Principle registry를 read-only로 사용한다. approved authoritative Principle만 권위 있는 참조로 사용하며 candidate/reviewed Principle은 참고용이다. 지식이 부족하면 조사 및 candidate evidence를 유도하되 Principle을 자동 등록하지 않는다.

다이어그램: [UC-003 유스케이스](diagrams/product/UC-003.usecase.svg), [UC-003 액티비티](diagrams/product/UC-003.activity.svg)

### UC-004 — 프로젝트 evidence 기록 및 사용

사용자는 loadtest, benchmark, incident, production metric, failure test와 같은 프로젝트 evidence를 기록한다. Harness 실행 출력에서 생성되는 관측도 목적을 명시해 자동 수집하고 로컬에 임시 보관한다. 코드 정합성·회귀를 확인하는 Code Validation Run과 특정 Decision 조건을 검증하는 Decision Validation Run을 구분한다. 전자는 Decision ID를 요구하지 않으며, 후자는 검증 대상 Decision ID를 명시한다. 사용자 확인을 거친 정규화 요약만 durable knowledge/evidence로 등록한다. raw plan journal과 checkpoint는 외부로 내보내지 않는다. evidence 저장이 실패하면 재시도할 수 있으며 execute/verify verdict는 별도로 보존한다. 저장되지 않은 evidence는 사용할 수 없다. durable 기록에는 환경, 관찰 결과, origin project 및 실행 목적에 따른 Decision 참조가 포함된다. 실행 목적은 실행 정의에서 가져오며 결과만 보고 추론하지 않는다. 자동 수집의 deduplication 및 provenance 세부 규칙은 이 Product Spec에서 결정하지 않는다. 다른 프로젝트로의 일반화는 자격이 확인되지 않은 채 허용되지 않는다. 실행 실패 또는 중단은 기록하되 유효한 측정 evidence와 구분한다.

다이어그램: [UC-004 유스케이스](diagrams/product/UC-004.usecase.svg), [UC-004 액티비티](diagrams/product/UC-004.activity.svg)

업무 상태 다이어그램: 해당 없음 — 명시적인 review gate와 전이 규칙으로 상태와 조건을 표현하며 별도 업무 상태 다이어그램의 독립 목적이 없다.

## 6. Business Rules and Invariants

- **BR-001 — 관련 질문만 수집:** System Characteristics에 근거해 관련된 NFR 질문만 선택한다.
- **BR-002 — 목표 범위:** Current, Expected Growth, Architecture Boundary 관점에서 MAU, DAU, concurrency, Average/Peak/Burst RPS, latency(p95/p99 포함), availability, data, jobs, RPO, RTO 중 관련 있는 값만 수집한다. 모든 지표를 강제하지 않는다.
- **BR-003 — 목표 provenance:** 목표값은 알려진 측정값과 사용자 제공값을 포함해 value, unit, provenance(`measured`, `business_requirement`, `user_supplied`, `estimated`, `external_reference`, `assumption`), confidence, rationale를 기록한다. 미확정 값은 정당화된 추정 또는 조사로 해소한다.
- **BR-004 — Architecture Boundary:** 경계는 숫자 또는 관찰 가능한 조건으로 표현한다. 경계만으로 수용량 보장을 만들어내지 않는다.
- **BR-005 — 결정 형식과 추적:** Code 및 Infrastructure 결정을 분리하고 Problem, Constraints, Options, Evidence, Tradeoffs, Decision, Scaling Boundary를 기록한다. 명시적인 requirement 및 target 링크와 rejected alternatives를 포함한다.
- **BR-006 — 역할 분리:** Normal agent는 조사하고 제안하며 사용자가 결정한다. Learning user는 제안하고 방어하며 Reviewer는 답을 대신하지 않고 이의를 제기한다.
- **BR-007 — Review acceptance:** 기본 workflow는 Learning이다. Reviewer가 새로 발견한 연구 자료는 source, claims, context와 함께 먼저 사용 승인을 받아야 한다. 사용자가 거부한 자료는 제외하며 대체 자료를 찾거나 결정 검토를 보류한다. 자료 사용 승인은 Principle 승인과 별개다. 체크리스트는 requirement, target, alternatives, tradeoffs, evidence, boundary, major objections answered를 각각 확인한다. Reviewer outcome은 `ACCEPTED`, `NEEDS_DEFENSE`, `NEEDS_EVIDENCE`, `NEEDS_REVISION` 중 하나다.
- **BR-008 — 출처 자격:** Source qualification은 authority, independence, recency, relevance, commercial_bias, primary_source를 다루며 선호도와 domain metadata를 추적한다. Claim은 그 출처의 특정 위치, 맥락, 한정 조건을 보존해 Source와 구분한다. 검색 tier 우선순위는 1 Formal Standards, 2 Industry Framework, 3 Primary Technical, 4 Established Expert, 5 Empirical, 6 Community다. Community 자료만으로 Principle을 지지할 수 없다.
- **BR-009 — Principle 품질 및 상태:** Principle은 적절한 `MUST`, `SHOULD`, `MAY` strength, consensus, applies_when, exceptions, supporting claims, contradicting claims를 포함한다. 조건과 예외 범위에 따라 strength와 consensus를 해석한다. 상태는 candidate, reviewed, approved, deprecated 중 하나다.
- **BR-010 — 승인 전제:** 독립 authority 수가 충분하지 않거나 counter-evidence가 해소되지 않은 Principle은 candidate로 유지하며 approval-ready로 취급하지 않는다. 독립성은 문서 수가 아니라 독립 authority 수로 판단한다. 충분한 material evidence가 없으면 결정을 연구/측정 대기 상태로 둔다.
- **BR-011 — 재검토:** 설계 또는 target이 변경되면 미해결 이의와 변경 영향이 있는 기존 accepted 주제를 다시 검토한다. Approved Knowledge object의 자체 내용이 변경되면 재검토한다. 참조된 evidence만 변경된 경우 기존 승인을 자동 무효화하지 않는다.
- **BR-012 — 모드 전환 및 이력:** Learning이 기본 모드다. 사용자는 Normal을 명시적으로 선택하거나 두 모드 간 전환할 수 있으며 이전 이력과 gate 결과를 보존한다.
- **BR-013 — Deprecated Principle:** deprecated Principle은 이를 참조한 과거 결정을 review-required로 표시하되 이력을 보존한다.
- **BR-014 — Evidence 경계:** 프로젝트 evidence는 환경, 관찰, origin project와 실행 목적에 따른 Decision 참조를 포함하며 출처 적격성 없이 프로젝트 간 일반화하지 않는다. Code Validation Run은 Decision ID 없이 기록할 수 있다. 특정 Decision 조건을 검증하는 Decision Validation Run은 검증 대상 Decision ID를 명시한다. 실행 목적은 실행 정의에서 선언하고 출력 결과로 추정하지 않는다. Harness 실행 출력 evidence는 로컬에 임시 보관하고 사용자 확인을 거친 정규화 요약만 durable knowledge/evidence로 등록한다. raw plan journal과 checkpoint는 내보내지 않는다. 저장 실패는 재시도 가능하고 execute/verify verdict와 별개로 기록한다. 저장되지 않은 evidence는 사용할 수 없다. 실패 또는 중단 execution 기록은 유효한 측정 evidence로 취급하지 않는다.
- **BR-015 — Reviewer 이의 provenance:** Architecture Reviewer 이의는 provenance를 포함하고 user claim → target → principle → evidence의 추적 경로를 제공한다.
- **BR-016 — `spec-me` 참조:** `spec-me`는 Principle registry를 수정하지 않는다. insufficient knowledge는 research/candidate evidence를 유도하며 Principle 자동 등록을 하지 않는다.
- **BR-017 — registry 범위:** registry는 프로젝트 로컬이다. 프로젝트 간 공유 또는 동기화는 범위에서 제외한다.
- **BR-018 — downstream 전달:** 최종 architecture/ADR은 rationale, target, principles, evidence, rejected options, tradeoffs, boundary를 포함해 downstream architecture context로 전달한다.
- **BR-019 — Worktree-local Knowledge 병합:** Knowledge 변경은 worktree-local이다. 동일 ID의 내용 또는 approval이 충돌하면 병합 시 사용자에게 보고하며 진행 중 workflow를 중단시키지 않는다.

## 6.1 Requirement 추적

| Requirement | 요구사항 | 연결 |
|---|---|---|
| REQ-001 | System Characteristics를 수집해 관련 NFR 질문만 선택한다. | UC-001, BR-001, AC-001 |
| REQ-002 | 관련 있는 Current, Expected Growth, Architecture Boundary 목표만 수집한다. | UC-001, BR-002, AC-002 |
| REQ-003 | 알려진 값과 추정/조사 값에 단위, provenance, confidence, rationale를 기록한다. | UC-001, BR-003, AC-003 |
| REQ-004 | Architecture Boundary는 수치 또는 관찰 가능한 조건이며 용량 보장을 함의하지 않는다. | UC-001, BR-004, AC-004 |
| REQ-005 | Code 및 Infrastructure 결정을 정해진 필드와 requirement/target trace로 분리 기록한다. | UC-001, BR-005, AC-004 |
| REQ-006 | Normal 및 Learning의 사용자, agent, Reviewer 역할을 분리한다. | UC-001, UC-002, BR-006, AC-005 |
| REQ-007 | 기본 Learning workflow에서 새 연구 자료의 사용 승인과 별도 Principle 승인, review checklist 및 objection provenance를 보존한다. | UC-002, UC-003, BR-007, BR-015, AC-006, AC-005 |
| REQ-008 | Source를 여섯 tier 우선순위와 qualification 기준에 따라 평가하고 Claim에 출처 위치·맥락·한정 조건을 보존한다. | UC-003, BR-008, AC-007 |
| REQ-009 | Principle 후보는 조건부 주장, supporting/contradicting claims 및 상태를 포함해 사람의 승인을 거친다. | UC-003, BR-009, AC-008, AC-009 |
| REQ-010 | material evidence 부족, 약한 독립성, 미해결 반대 근거 및 변경 시 review gate를 적용한다. | UC-002, UC-003, BR-010, BR-011, AC-009, AC-011 |
| REQ-011 | 모드 전환, Knowledge object 자체 내용 변경, Principle 폐기 후 이력 및 영향 결정의 review 필요성을 보존한다. | UC-002, BR-011, BR-012, BR-013, AC-011 |
| REQ-012 | 프로젝트 evidence를 기록하고 Harness 출력 evidence를 임시 수집·사용자 확인 후 정규화해 보존하며 저장 실패와 verdict를 분리한다. | UC-004, BR-014, AC-012 |
| REQ-013 | Reviewer 이의 및 근거를 user claim→target→principle→evidence 경로로 추적하고 registry를 프로젝트 로컬로 유지한다. | UC-002, BR-015, BR-017, AC-013 |
| REQ-014 | `spec-me`는 approved authoritative Principle만 권위 있게 사용하고 registry를 변경하거나 자동 등록하지 않는다. | UC-003, BR-016, AC-010 |
| REQ-015 | 최종 architecture/ADR에 결정 추적 정보를 담아 downstream architecture context로 전달한다. | UC-001, BR-018, AC-014 |
| REQ-016 | 정의된 결정 흐름은 유스케이스/액티비티 다이어그램과 일치한다. | UC-001–UC-004, AC-015 |
| REQ-017 | 동일 ID Knowledge 충돌은 병합 때 보고하고 진행 중 workflow는 중단하지 않는다. | UC-003, BR-019, AC-016 |

## 7. States and State Transitions

### Review outcome

| 상태 | 의미 |
|---|---|
| `ACCEPTED` | acceptance checklist의 모든 항목이 충족됨 |
| `NEEDS_DEFENSE` | 사용자 주장 또는 답변에 추가 방어가 필요함 |
| `NEEDS_EVIDENCE` | 결정을 뒷받침할 material evidence가 부족함 |
| `NEEDS_REVISION` | 설계나 target의 수정이 필요함 |

미해결 이의 또는 material evidence 부족이 있으면 결정 승인은 보류한다. 설계나 target 변경 시 미해결 이의와 영향받는 accepted 주제를 재검토한다.

### Principle state

| 상태 | 의미 |
|---|---|
| candidate | 근거가 수집 중이거나 독립성/반대 근거 문제가 남음 |
| reviewed | 검토되었으나 human approval 전 |
| approved | human approval을 받아 권위 있는 참조로 사용 가능 |
| deprecated | 신규 권위 참조로 사용하지 않으며 과거 참조 결정은 review-required |

candidate/reviewed는 권위 있는 지식으로 사용할 수 없다. Approved object 자체 내용이 바뀌면 다시 검토한다. 연결된 evidence만 바뀐 경우 기존 승인을 자동 무효화하지 않는다. deprecated 처리 시 기존 이력은 보존한다.

### Workflow modes

Learning이 기본 모드이며 사용자는 Normal을 명시적으로 선택할 수 있다. 두 모드 간 전환 시 전환 전후의 이력과 gate 결과를 보존한다.

### Worktree-local Knowledge changes

Knowledge 변경은 worktree-local로 진행한다. 동일 ID의 내용 또는 approval 충돌은 병합 시 보고하며 해당 workflow 진행 중에는 충돌로 중단하지 않는다.

## 8. Failures, Exceptions, and Boundary Conditions

- 필요한 material evidence가 없으면 결정은 조사 또는 측정 대기 상태에 머문다.
- counter-evidence가 해결되지 않거나 출처 간 독립성이 약하면 Principle은 candidate에 머문다.
- 실행이 실패하거나 중단된 경우 그 사실을 기록하되 valid measured evidence로 표시하지 않는다.
- 특정 목표 지표가 관련되지 않으면 수집을 요구하지 않는다. 알려진 목표도 provenance를 기록하며, 미확정이지만 관련된 목표는 추정/조사 provenance로 표시한다.
- architecture boundary는 수치 또는 관찰 가능한 조건으로 기록하며 용량 보장을 함의하지 않는다.
- `NEEDS_DEFENSE`, `NEEDS_EVIDENCE`, `NEEDS_REVISION` 상태는 해당 쟁점이 처리될 때까지 승인 gate를 통과하지 못한다.
- Principle 폐기 또는 target/design 변경 후에는 영향받는 결정의 재검토 필요성을 표시하고 과거 기록을 유지한다.
- 사용자가 research material 사용을 거부하면 해당 자료를 제외한다. 대체 자료를 얻지 못하면 결정을 보류한다.
- durable evidence 저장 실패는 실행 verdict와 별개다. 재시도할 수 있으며 아직 저장되지 않은 evidence는 근거로 사용할 수 없다.
- Approved Knowledge object의 자체 내용 변경은 재검토가 필요하지만 참조 evidence만의 변경은 승인을 자동 무효화하지 않는다.
- 동일 ID Knowledge 변경/approval 충돌은 병합 시 보고하며 진행 중 workflow를 중단하지 않는다.
- 프로젝트 간 registry 공유·동기화 및 근거 없는 evidence 일반화는 범위 밖이다.

## 9. Inputs and Outputs

### Inputs

- 결정 목적과 관련 사용자 요구사항
- System Characteristics: interaction, workload, state, consistency, availability, growth
- 관련 있는 Current, Expected Growth, Architecture Boundary 목표 및 값·단위·provenance·confidence·rationale
- Code 및 Infrastructure 문제, 제약, 옵션, 사용자 제안
- Source, Claim, Principle, Evidence 및 Reviewer objection과 provenance
- 프로젝트 evidence와 환경·관찰·origin project·decision references, Harness 실행 출력에서 수집된 evidence

### Outputs

- System Characteristics에 따라 선택된 NFR 질문 및 target 집합
- requirement 및 target과 연결된 Code 결정 및 Infrastructure 결정
- rejected alternatives, evidence, trade-offs, scaling boundary, review outcome 및 objection 이력
- 상태와 승인 이력을 가진 프로젝트 로컬 Principle registry 자료
- rationale, target, principles, evidence, rejected options, tradeoffs, boundary를 보존한 최종 architecture/ADR 입력

## 10. Scope and Non-goals

### In scope

- 기존 planning/implementation 전에 수행하는 Engineering Decision Layer
- Normal 및 Learning 결정 workflow와 review gates
- System Characteristics 기반 NFR 질문 및 관련 목표 수집
- Source/Claim/Principle/Evidence의 조사, 평가, human approval, project-local registry
- 프로젝트 evidence 기록 및 Harness 실행 출력 evidence의 임시 수집, 사용자 확인 후 정규화 요약의 durable 등록, downstream architecture/ADR 전달

### Out of scope

- 기존 downstream planning 및 implementation 흐름의 변경
- 프로젝트 간 registry 공유 또는 동기화
- Researcher가 Principle 또는 결론을 생성하는 행위
- `spec-me`의 Principle registry 쓰기 또는 자동 Principle 승인/등록
- 구현 slicing과 구현 단위 grouping은 to-ticket 단계에서 결정한다.

## 11. Priorities and Trade-offs

1. 근거와 추적성, 사람의 결정/승인, 반대 근거 검토를 결정의 완결성보다 우선한다. 근거가 부족하면 보류한다.
2. 목표 수집은 선택한 범위의 관련성을 따르며, 무관한 모든 metric의 강제 수집보다 System Characteristics에 맞는 질문을 우선한다.
3. Principle 재사용성은 조건·예외·출처 자격·독립 corroboration을 함께 기록하는 방식으로 확보한다. 검토되지 않은 지식은 권위 있게 사용하지 않는다.
4. 프로젝트 evidence는 출처 경계를 보존한다. 범용성을 위해 검증되지 않은 프로젝트 간 일반화를 하지 않는다.
5. implementation slicing과 grouping은 to-ticket 단계에서 결정한다.

## 12. Success Conditions and Acceptance Criteria

- **AC-001:** System Characteristics가 interaction, workload, state, consistency, availability, growth를 다루며 그에 관련된 NFR 질문만 선택된다.
- **AC-002:** Current, Expected Growth, Architecture Boundary 관점에서 관련 목표를 수집하고, 모든 지표를 일괄 강제하지 않는다. 관련 시 Average/Peak/Burst RPS 및 p95/p99 latency를 표현할 수 있다.
- **AC-003:** 알려진 측정값과 사용자 제공값 및 정당화된 estimate/research 값은 value, unit, 허용된 provenance 값, confidence, rationale를 포함한다.
- **AC-004:** Code와 Infrastructure 결정은 별도이며 Problem, Constraints, Options, Evidence, Tradeoffs, Decision, Scaling Boundary, requirement 및 target links, rejected alternatives를 갖는다.
- **AC-005:** Learning이 기본 모드다. 사용자가 Normal을 명시적으로 선택할 수 있다. Normal에서는 agent가 조사/제안하고 사용자가 결정한다. Learning에서는 사용자가 제안/방어하고 Reviewer는 답을 대신하지 않으며 objection에 provenance가 있다.
- **AC-006:** Reviewer의 신규 연구 자료는 source, claims, context와 함께 먼저 사용자에게 제시되고 사용 승인을 받는다. 거부 시 자료를 제외해 대안을 찾으며 대안이 없으면 결정을 보류한다. 이 승인은 Principle 승인과 별개다. Review checklist는 requirement, target, alternatives, tradeoffs, evidence, boundary, answered major objections를 각각 검증하고 네 가지 정의된 outcome을 사용한다.
- **AC-007:** Source 평가가 authority, independence, recency, relevance, commercial_bias, primary_source와 선호도/domain metadata를 다룬다. Claim은 출처 위치·맥락·한정 조건을 유지한다. 여섯 검색 tier를 정해진 우선순위로 사용하고 Community만을 Principle의 근거로 사용하지 않는다. independent authority 수를 문서 수와 구분한다.
- **AC-008:** Principle workflow가 discovery부터 human approval 및 publish까지 정해진 순서를 따르며 researcher는 자료 발견/분류만 수행한다.
- **AC-009:** Principle은 strength, consensus, applies_when, exceptions, supporting/contradicting claims, 상태를 보유한다. 약한 독립성 또는 미해결 counter-evidence가 있으면 candidate로 유지한다.
- **AC-010:** `spec-me`는 approved authoritative Principle만 권위 있는 지식으로 사용하고 candidate/reviewed는 참고용으로 취급한다. insufficient knowledge는 조사/candidate evidence를 촉발하며 자동 등록하지 않는다.
- **AC-011:** material evidence 부족은 결정 보류를 유발한다. 설계/target 변경 시 미해결 objection과 영향받는 accepted 주제를 다시 검토한다. Knowledge object 자체 내용 변경 시 재검토하고, 참조 evidence만 변경된 경우 승인을 자동 무효화하지 않는다. 모드 전환 및 deprecated Principle 처리에서 이력을 보존한다.
- **AC-012:** 프로젝트 evidence가 정의된 종류 중 하나로 기록될 때 환경, 관찰, origin project를 담는다. Harness 실행 출력은 실행 정의에 선언된 목적에 따라 Code Validation Run 또는 Decision Validation Run으로 구분해 로컬에 임시 수집한다. Code Validation Run은 Decision ID 없이 기록할 수 있고 Decision Validation Run은 검증 대상 Decision ID를 포함한다. 목적이나 Decision 참조를 관측 결과만으로 추론하지 않는다. 사용자 확인된 정규화 요약만 durable 등록한다. raw plan journal과 checkpoint는 내보내지 않는다. 저장 실패는 재시도 가능하고 execute/verify verdict와 별도이며 미저장 evidence는 사용할 수 없다. 실패/중단 execution은 유효 측정 evidence와 구별한다.
- **AC-013:** reviewer objection은 user claim→target→principle→evidence로 추적된다. 프로젝트 간 근거 없는 일반화 및 registry 공유/동기화는 발생하지 않는다.
- **AC-014:** 최종 architecture/ADR에 rationale, target, principles, evidence, rejected options, tradeoffs, boundary가 포함되어 downstream architecture context로 이어진다.
- **AC-015:** 결정 흐름은 `UC-001`–`UC-004` 유스케이스 및 액티비티 다이어그램에 대응한다. 독립 업무 검토 목적이 없는 business-state diagram은 생성하지 않는다.
- **AC-016:** 동일 ID Knowledge 내용 또는 approval 충돌은 worktree 병합 시 보고하고 진행 중 workflow는 충돌 때문에 중단하지 않는다.
