# Architecture Spec 작성·독립 리뷰 기준

독립 Spec 리뷰는 Architecture Spec만 대상으로 한다. Product Spec은 승인된 요구사항의 원문으로 읽고, Product 동작 자체를 다시 심사하지 않는다. Architecture 작성자와 Architecture reviewer는 이 기준 및 `.codex/internal-skills/ddd-design/references/model-continuity.md`, `.codex/internal-skills/testing-guidance/GUIDE.md`를 읽는다.

## 리뷰의 목적과 판정

승인된 Product 요구가 DDD 책임·규칙·데이터·기술·인프라 설계로 빠짐없이 이어지고, 각 핵심 결정이 추적 가능한 근거로 뒷받침되는지 평가한다. 형식 선호나 막연한 미래 위험을 찾지 않는다.

- `blocker`: 중요한 제품 규칙이나 사용 흐름을 구현할 수 없거나, 사용자에게 결정받지 않은 중대한 설계 선택이 진행을 막는다.
- `major`: 핵심 규칙의 owner/boundary가 잘못됐거나, 필수 데이터·기술·인프라 요소가 빠졌거나, 선택의 근거가 없어 요구 충족을 설명할 수 없다.
- `minor`: 구현 가능성과 승인 요구 충족에 영향을 주지 않는 개선 의견이다. 통과를 막지 않는다.
- 모든 blocker/major에는 Product requirement/use-case/rule ID, Architecture Spec 위치, 근거 자료, 구체적인 실패 또는 누락 시나리오, 영향이 있어야 한다. 같은 원인은 한 finding으로 묶는다.
- 막연한 가능성은 finding이 아니다. 요구·System Target·프로젝트 제약·확인된 source 중 하나와 연결되지 않는 성능/가용성/확장성 문제는 제기하지 않는다.

## 1. Product 요구에서 설계까지의 추적

각 핵심 Product requirement/use case/business rule/invariant와 수용 조건을 Architecture Spec의 owner, 동작, data, interface, infrastructure 및 검증으로 추적한다.

리뷰어는 특히 다음을 확인한다.

- Product가 지속 보존을 요구하면 어떤 상태/기록이 어디에 저장되는지, 누가 소유하고 어떤 수명·삭제·복구 규칙을 갖는지 명시돼 있다.
- Product가 검색·필터·정렬·관계 조회를 요구하면 필요한 조회 패턴과 관계·정합성 모델을 지원하는 데이터 저장소 및 query path가 정해져 있다.
- 요구를 만족시키는 데 database, object store, queue, cache, search, identity provider, model provider, scheduler 등 기술·인프라 capability가 필요하면 선택한 기존 자원 또는 신규 자원, 연결 지점, 운영·실패 조건이 Spec에 있다.
- 요구가 그런 capability를 필요로 하지 않으면 도입을 강제하지 않고 `해당 없음` 또는 기존 제공 요소 재사용 근거를 적는다.
- 선택한 기술이 요구를 실제로 지원하는 연결 경로가 설계돼 있다. 예: 업무 owner → repository/port → persistence adapter → database/schema/index/query → 실행 환경 및 설정.

예를 들어 영속 저장과 관계형 조건 조회가 Product 요구인데 DB 종류, persistence owner, schema/query path가 전혀 선택되지 않았다면 major다. 반대로 DB 제품명을 썼더라도 요구된 관계 조회·트랜잭션·복구를 뒷받침하는 근거와 설계 연결이 없으면 선택 완료로 보지 않는다.

## 2. DDD 분류 및 규칙 소유권

`.codex/internal-skills/ddd-design/references/model-continuity.md`와 현재 `CONTEXT-MAP.md`, durable model, source/ADR 기준으로 변경 영향 범위만 확인한다.

- Domain concept, capability, Aggregate, bounded context, code module, deployment service를 서로 다른 분류로 사용한다. Aggregate·기능 이름·기술 모듈만으로 새 bounded context를 만들지 않는다.
- 각 capability를 기존 bounded context에 우선 배치한다. 새 bounded context는 언어, 규칙, 상태·데이터 수명, consistency, 독립 변경 또는 translation 경계가 기존 owner와 맞지 않는 근거 및 더 약한 경계가 부족한 이유가 있을 때만 승격한다.
- Aggregate는 실제로 함께 일관성을 유지해야 하는 상태와 transaction을 기준으로 정하고, root가 invariant를 보호하는 유일한 변경 진입점인지 확인한다.
- 변경된 각 business rule/invariant는 Product ID → domain owner → enforcement method/function → 호출 경로와 금지된 우회 경로로 연결한다. Application/orchestration, persistence, UI가 domain decision을 대신 소유하거나 규칙이 중복되지 않는지 확인한다.
- Entity, Value Object, Domain Service는 identity, value semantics, 행위와 소유 책임에 따라 분류한다. 단일 Entity/Value Object가 자연스럽게 소유하지 않는 판단만 Domain Service에 둔다.
- Context 간 data 접근, translation, 통신, consistency, failure 책임을 설명한다. 기존 모델이 충분한데 새 owner·계층·서비스를 추가하면 그 필요와 비용을 묻는다.

## 3. 비즈니스 로직 단위 테스트 명세

Architecture Spec의 verification contract가 구현자에게 단위 테스트로 설명할 business behavior를 전달하는지 확인한다. 테스트 계획이 테스트 수·파일 수를 채우는지 평가하지 않는다.

변경되는 각 핵심 domain rule에 대해 적어도 다음 연결을 찾는다.

`UC/BR/AC ID → owner/domain behavior → 조건·행위 → 기대 업무 결과 → 단위 테스트 사례`

- 사례는 정상 동작, 업무상 경계, 업무 규칙에 따른 거부 중 의미 있는 분기를 설명한다.
- 테스트 대상은 소유 모듈의 business decision, 계산, state transition, invariant, 업무상 refusal이다.
- 외부 의존성은 모킹한다. 기대값은 사용자에게 보이는 임의의 문구보다 도메인 결과와 상태를 표현한다.
- 자료형 오류, 일반 parser/serializer/framework wiring, getter/setter, mock 호출 횟수, 단순 위임, 모든 입력 조합을 테스트하도록 요구하지 않는다.
- test file, framework, 구현 전에 불필요한 API signature를 Architecture Spec에서 고정하지 않는다. 기존 프로젝트 실행·테스트 표준을 따를 만큼만 정한다.
- 요구에 business rule이 없거나 변경되지 않으면 새 단위 테스트를 강요하지 않고 그 이유를 연결한다.

## 4. 기술·인프라 선택과 근거의 연결

기술이나 인프라를 선택할 때 Architecture Spec은 결론만 나열하지 않고 다음 근거 사슬을 기록해야 한다.

`Product requirement / System Target → 필요한 capability·제약 → 검토한 선택지 → 근거 자료 → 장단점·거부 사유 → 선택 → 구현 owner·경계 → 검증 방법`

각 적용 가능한 선택에서 확인한다.

- 사용한 근거가 구체적으로 연결돼 있다: project constraint/승인 ADR, user-managed standard, 측정 결과, 공식 기술 문서, 정확한 source ID 또는 URL과 관련 section/version/date/locator.
- 근거가 선택 기준을 실제로 뒷받침한다. 출처를 링크만 하고 특정 선택에 어떤 주장을 지지하는지 설명하지 않는 것은 부족하다.
- 비교 후보는 요구를 만족할 현실적인 대안으로 한정하고, 선택 및 주요 기각 사유·trade-off를 적는다. 근거 없는 조합식 비교를 만들지 않는다.
- 프로젝트 고유 요구와 workload가 성능·용량을 요구하면 metric, 단위, 대표 부하, 목표 출처/신뢰도 및 확인 방법을 연결한다. 수치가 미정이면 owner와 결정 시점을 기록하며 임의 숫자를 만들지 않는다.
- 필요한 capability가 기존 인프라에 이미 제공되는지 확인한다. 기존 제공 요소를 재사용하면 그 사실과 접근 경로를 증거로 남긴다.
- 구체 기술을 선택해야 하는데 미선택이면, 그 공백이 implementation을 막는지 판정한다. 막지 않는 조사 항목은 owner와 해결 시점을 가진 명시적 open item으로 남긴다.

### 필수 capability 완전성 점검

Product Spec과 System Targets를 아래 capability 관점으로 대조하되, 적용되는 요구가 있을 때만 선택을 요구한다.

| 요구에서 찾을 신호 | Architecture Spec에서 연결돼야 할 결정 |
|---|---|
| 상태·기록을 세션/작업 이후에도 보존 | DB/object storage 또는 기존 저장소, data owner, schema/key, 보존·삭제, write/read/recovery path |
| 관계·조건·정렬 기반 조회 | 적합한 storage/query model, 관계·index, consistency, query owner와 검증 사례 |
| 업무 rule의 동시 변경·멱등성 | transaction/locking/versioning/idempotency owner와 partial-failure behavior |
| 비동기 처리·순서·재시도 요구 | queue/broker 또는 기존 task system, delivery/ordering/retry/dedup ownership |
| 파일·대용량 blob 요구 | object/file storage, metadata owner, access/retention/failure path |
| 외부 identity/payment/AI/notification 의존 | provider 또는 기존 capability, port/adapter, timeout/failure/isolation/config/secrets |
| 보안·규제·운영 요구 | identity/authorization, secret handling, logging/metrics/tracing/alerting 및 환경 설정 |
| 명시된 workload·성장 조건 | runtime/DB/deployment capacity decision, measurable target, evidence와 verification |

요구에 persistence가 있는데 DB/storage 설계가 없거나, 요구된 query shape를 현재/선택 storage가 지원하는 설명이 없거나, 필수 외부 의존성이 설계에서 빠지면 major finding으로 보고한다.

## 5. 검토하지 않을 것

- Product Spec의 의도·우선순위·기능 범위를 다시 승인하는 일. Architecture가 승인된 동작을 구현할 수 없게 만든 구체적인 충돌만 지적한다.
- 해당 요구·System Target·프로젝트 제약에 연결되지 않은 기술 취향, 강한 분리 경계, 추상화, 모든 품질 속성에 대한 독립 설계.
- 소스에 아직 없는 설계라는 이유만으로 finding을 만드는 일. source는 현행 사실과 project constraints를 확인하는 근거다.
- 직접 변경되지 않는 기존 도메인 전체를 재검토하거나 과거 용어/구조를 일괄 정리하도록 요구하는 일.
- 문장 스타일, 표 모양, 다이어그램 미관, method/class 수준 세부사항, 테스트 수량을 승인 조건으로 삼는 일.
- business behavior와 무관한 자료형 오류, framework/infrastructure wiring, serializer 및 mock 상호작용 테스트의 추가를 요구하는 일.

## 6. 리뷰 반복 제한

작성자는 위 기준으로 Architecture Spec과 evidence chain을 자체 점검한 뒤 한 번 제출한다. 독립 reviewer는 blocker/major를 관련 경로별로 합쳐 한 번에 반환한다. 작성자는 관련 finding을 한 차례에 수정·반박하고, 새 reviewer는 그 수정과 직접적인 회귀만 한 번 재검토한다. 여전히 중요한 결정을 내릴 수 없으면 추가 finding loop를 만들지 않고 사용자 결정으로 반환한다. 변경 snapshot에 영향이 없으면 재리뷰하지 않는다.

## 참고 자료

- 프로젝트 DDD: `.codex/internal-skills/ddd-design/GUIDE.md`, `references/model-continuity.md`
- 프로젝트 단위 테스트 의도: `.codex/internal-skills/testing-guidance/GUIDE.md`
- Microsoft, [Designing a microservice domain model](https://learn.microsoft.com/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/microservice-domain-model): entity/aggregate behavior와 invariant ownership.
- Microsoft, [Infrastructure persistence layer design](https://learn.microsoft.com/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/infrastructure-persistence-layer-design): domain model unit test와 database integration test의 분리, aggregate consistency boundary.
- SEI, [ATAM](https://www.sei.cmu.edu/library/atam-method-for-architecture-evaluation/): business driver에 연결한 품질 시나리오와 architecture trade-off/risk 평가.
