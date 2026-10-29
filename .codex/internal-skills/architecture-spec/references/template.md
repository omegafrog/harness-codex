# Architecture Spec

# 1. Design Scope

## 1.1 Target

| 항목                    | 대상            |
| --------------------- | ------------- |
| Product Spec          | `<path>`      |
| Use Cases             | `<use cases>` |
| Domain                | `<domain>`    |
| Bounded Contexts      | `<contexts>`  |
| Existing Services     | `<services>`  |
| External Dependencies | `<systems>`   |
| Affected Data         | `<data>`      |

## 1.2 Product Spec Mapping

| Product Spec 항목      | Architecture 요소                  |
| -------------------- | -------------------------------- |
| `<use case>`         | `<domain flow / program flow>`   |
| `<business rule>`    | `<aggregate / domain component>` |
| `<invariant>`        | `<owner / enforcement point>`    |
| `<state transition>` | `<command / event / component>`  |
| `<failure case>`     | `<error handling / recovery>`    |
| `<persistence / query / external capability>` | `<data owner / technology / infrastructure / query path>` |

---

## 1.3 기존 모델 기준과 변경량

| 기존 Context / Aggregate·모델 | 소유 코드 / 공개 operation | 현재 invariant·transaction | 재사용 또는 변경 | 근거 commit / source / 모델 문서 |
|---|---|---|---|---|
| `<기존 모델 또는 확인되지 않음>` | `<file:line>` | `<현재 사실>` | `<기존 확장 또는 새 경계가 필요한 이유>` | `<refs>` |

현재 구현과 승인 target을 구분한다. `CONTEXT-MAP.md` 및 연결된 모델·ADR·다이어그램을 확인하고, 문서/코드 불일치를 기록한다. 새 경계 없이 기존 owner를 확장하는 안부터 평가한다.

# 2. Domain Flow

변경되는 항목만 작성한다. 단순 CRUD·조회 또는 기존 operation 확장에는 적용되지 않는 DDD 타입/이벤트/계층을 만들지 않고 `해당 없음 — 근거`를 적는다. 모든 예제 행은 구현 요소 생성 지시가 아니다.

## 2.1 Event Storming Flow

```plantuml
@startuml
title <Use Case> Domain Flow

start

:<Actor>;
:<Command>;

if (<Command accepted?>) then (yes)
    :<Aggregate>;
    :<Business Rule>;
    :<State Transition>;
    :<Domain Event>;

    if (<Policy triggered?>) then (yes)
        :<Policy>;
        :<Follow-up Command>;
        :<Follow-up Aggregate>;
        :<Follow-up Domain Event>;
    endif

    if (<Read Model update required?>) then (yes)
        :<Read Model Update>;
    endif

    if (<External interaction required?>) then (yes)
        :<External System Interaction>;
    endif

    :<Result>;
else (no)
    :<Rejection>;
endif

stop
@enduml
```

## 2.2 Commands

| Command     | Actor     | Target                  | Input     | Preconditions  | Result             |
| ----------- | --------- | ----------------------- | --------- | -------------- | ------------------ |
| `<command>` | `<actor>` | `<aggregate / context>` | `<input>` | `<conditions>` | `<event / result>` |

## 2.3 Domain Events

| Domain Event | Producer      | Trigger       | Payload     | Consumers     |
| ------------ | ------------- | ------------- | ----------- | ------------- |
| `<event>`    | `<aggregate>` | `<condition>` | `<payload>` | `<consumers>` |

## 2.4 Policies

| Policy     | Trigger Event | Decision | Emitted Command | Owner       |
| ---------- | ------------- | -------- | --------------- | ----------- |
| `<policy>` | `<event>`     | `<rule>` | `<command>`     | `<context>` |

## 2.5 Read Models

| Read Model     | Consumer              | Source            | Fields     | Owner       |
| -------------- | --------------------- | ----------------- | ---------- | ----------- |
| `<read model>` | `<actor / component>` | `<events / data>` | `<fields>` | `<context>` |

## 2.6 External Interactions

| External System | Trigger             | Input     | Output     | Failure     |
| --------------- | ------------------- | --------- | ---------- | ----------- |
| `<system>`      | `<command / event>` | `<input>` | `<output>` | `<failure>` |

## 2.7 Hotspots

| Hotspot         | Options     | Decision     |
| --------------- | ----------- | ------------ |
| `<uncertainty>` | `<options>` | `<decision>` |

---

# 3. DDD Architecture

## 3.1 Bounded Contexts

| Bounded Context | Responsibility     | Ubiquitous Language | Owned Model    | Owned Data |
| --------------- | ------------------ | ------------------- | -------------- | ---------- |
| `<context>`     | `<responsibility>` | `<terms>`           | `<aggregates>` | `<data>`   |

Bounded Context는 기능 이름이나 Aggregate 수에 맞춰 생성하지 않는다. 먼저 capability를 기존 context에 배치하고, 기존 context의 언어·비즈니스 규칙·데이터 lifecycle·일관성 경계로 소유할 수 없을 때만 새로운 Bounded Context로 승격한다.

## 3.1.1 Boundary Decisions

| Capability     | Owner Context | Candidate Boundary                                                        | Chosen Boundary | Why Not Weaker?          | Why Not Stronger?          |
| -------------- | ------------- | ------------------------------------------------------------------------- | --------------- | ------------------------ | -------------------------- |
| `<capability>` | `<context>`   | Domain Type / Aggregate / Internal Capability / Bounded Context / External | `<boundary>`    | `<insufficient reason>`  | `<unnecessary cost/reason>` |

새로운 Bounded Context가 선택되면 `Why Not Weaker?`에 기존 context 내부 capability로 둘 수 없는 이유를 적는다. 이름이 분명하거나 도메인 로직이 존재한다는 사실만으로는 승격 근거가 되지 않는다.

## 3.2 Context Map

```plantuml
@startuml
title Context Map

rectangle "<Upstream Context>" as upstream
rectangle "<Downstream Context>" as downstream
rectangle "<External System>" as external

upstream --> downstream : <Published Language / API / Event>
external --> downstream : <ACL / Adapter>

@enduml
```

| Upstream    | Downstream  | Relationship                                                              | Contract     | Translation              |
| ----------- | ----------- | ------------------------------------------------------------------------- | ------------ | ------------------------ |
| `<context>` | `<context>` | Customer/Supplier / Conformist / ACL / Shared Kernel / Published Language | `<contract>` | `<ACL / adapter / none>` |

## 3.3 Aggregates

| Aggregate     | Root     | Responsibility     | Commands     | Events     | Invariants     |
| ------------- | -------- | ------------------ | ------------ | ---------- | -------------- |
| `<aggregate>` | `<root>` | `<responsibility>` | `<commands>` | `<events>` | `<invariants>` |

Aggregate 경계는 Bounded Context 경계를 자동으로 의미하지 않는다.

## 3.4 Entities

| Entity     | Aggregate     | Identity     | Responsibility     | State     |
| ---------- | ------------- | ------------ | ------------------ | --------- |
| `<entity>` | `<aggregate>` | `<identity>` | `<responsibility>` | `<state>` |

## 3.4.1 Class Diagram

클래스·Aggregate·Value Object·Domain Service의 책임과 의존 관계를 구현 대상 기준으로 표현한다. 변경 대상이 없으면 `해당 없음`과 근거를 적는다. 다이어그램은 독립 `.puml` 원본으로 작성하고 생성된 SVG를 아래 링크에 연결한다.

원본: `docs/specs/<plan-set-id>/diagrams/architecture/<context>.class.puml`
SVG: `docs/specs/<plan-set-id>/diagrams/architecture/<context>.class.svg`

## 3.5 Value Objects

| Value Object     | Aggregate     | Values     | Validation      | Behavior     |
| ---------------- | ------------- | ---------- | --------------- | ------------ |
| `<value object>` | `<aggregate>` | `<values>` | `<constraints>` | `<behavior>` |

## 3.6 Domain Services

| Domain Service | Responsibility     | Input     | Output     | Collaborators    |
| -------------- | ------------------ | --------- | ---------- | ---------------- |
| `<service>`    | `<responsibility>` | `<input>` | `<output>` | `<domain types>` |

## 3.7 Business Rule Ownership

| Business Rule | Owner                                              | Enforcement Point |
| ------------- | -------------------------------------------------- | ----------------- |
| `<rule>`      | Aggregate / Entity / Value Object / Domain Service | `<method>`        |

변경된 규칙은 Product rule/invariant ID를 유지하고 실제 method/function을 지정한다. application의 업무 판단, setter·직접 저장·공유 mutable state를 통한 우회와 중복 enforcement를 금지하는 경로 및 검증 방법을 기록한다. 단일 객체가 소유할 수 없는 판단을 domain service로 둘 때는 이유를 적는다.

## 3.8 Aggregate State Transitions

변경되는 상태 보유 operation은 아래 표에 정상·중복/재시도·경쟁 저장·부분 실패·재시작·취소/복구 경로를 함께 기록한다. 단순 무상태 조회 등 적용되지 않는 경로는 근거를 적는다. 기존 전이·실패 표를 확장해 한 곳에서 관리한다.

| 현재 상태·사건 | 허용 전이·거부 조건·발행 event | 규칙 owner·최종 저장의 원자적 조건 | 실패 후 보존 상태 | 재시도·복구 주체와 다음 허용 명령 | 요구 ID·검증 사례 |
|---|---|---|---|---|---|
| `<state / command / competing writer / restart>` | `<next state / guard>` | `<method / transaction / CAS / version>` | `<durable state / external result>` | `<owner / recovery input / next command>` | `<UC/BR/AC / observable oracle>` |

예약·잠금·version을 도입하거나 변경할 때는 이미 시작한 writer, 예약 중 허용할 하위 처리, 외부 성공 뒤 로컬 저장 실패, 미확인 상태 복구, 해제 후 새 작업 시작을 같은 표에서 대조한다. 재시도 횟수 소진 뒤 도달 가능한 복구·종료 상태를 명시한다. 중대한 미결정은 Architecture 결정 단계에서 해결한 뒤 reviewer에 넘긴다. 이 표의 의미적 완전성은 작성자·reviewer가 판단한다.

## 3.8.1 State Diagram

Aggregate 또는 핵심 도메인 객체의 모든 허용 상태, 전이 트리거, guard 조건, 결과 이벤트를 표현한다. 상태가 없으면 `해당 없음`과 근거를 적는다.

원본: `docs/specs/<plan-set-id>/diagrams/architecture/<concept>.state.puml`
SVG: `docs/specs/<plan-set-id>/diagrams/architecture/<concept>.state.svg`

## 3.9 Repository Boundaries

| Repository     | Aggregate     | Operations     | Consistency Boundary |
| -------------- | ------------- | -------------- | -------------------- |
| `<repository>` | `<aggregate>` | `<operations>` | `<boundary>`         |

---

# 4. Program Design

## 4.1 Program Structure

```plantuml
@startuml
title Program Structure

component "<Entry Component>" as entry
component "<Application Component>" as application
component "<Domain Component>" as domain
interface "<Output Port>" as outputPort
component "<Adapter>" as adapter

entry --> application
application --> domain
application --> outputPort
adapter ..|> outputPort

@enduml
```

## 4.2 Major Components and Responsibilities

| Component     | Responsibility     | Input     | Output     | Dependencies     | Must Not Do                  |
| ------------- | ------------------ | --------- | ---------- | ---------------- | ---------------------------- |
| `<component>` | `<responsibility>` | `<input>` | `<output>` | `<dependencies>` | `<forbidden responsibility>` |

## 4.3 Application Flow

```plantuml
@startuml
title <Use Case> Program Flow

start

:<Entry Component>;
:<Application Component>;

if (<Input valid?>) then (yes)
    :<Load Required State>;
    :<Domain Operation>;

    if (<Domain operation succeeded?>) then (yes)
        :<Persist State>;

        if (<External effect required?>) then (yes)
            :<Call Output Port>;
        endif

        :<Return Success>;
    else (no)
        :<Convert Domain Failure>;
        :<Return Failure>;
    endif
else (no)
    :<Return Validation Failure>;
endif

stop
@enduml
```

## 4.4 Component Call Contracts

| Order | Caller     | Callee     | Operation     | Input     | Output     | Failure     |
| ----: | ---------- | ---------- | ------------- | --------- | ---------- | ----------- |
|     1 | `<caller>` | `<callee>` | `<operation>` | `<input>` | `<output>` | `<failure>` |

## 4.5 Major Types

| Type     | Kind                                                     | Responsibility     | State     | Dependencies     |
| -------- | -------------------------------------------------------- | ------------------ | --------- | ---------------- |
| `<type>` | Application Service / Domain Type / Port / Adapter / DTO | `<responsibility>` | `<state>` | `<dependencies>` |

## 4.6 Type Design

### `<TypeName>`

| 항목                 | 정의                         |
| ------------------ | -------------------------- |
| Kind               | `<kind>`                   |
| Responsibility     | `<responsibility>`         |
| Dependencies       | `<dependencies>`           |
| Must Not Depend On | `<forbidden dependencies>` |

#### State

| Field     | Type     | Meaning     | Constraint     |
| --------- | -------- | ----------- | -------------- |
| `<field>` | `<type>` | `<meaning>` | `<constraint>` |

#### Behavior

| Method     | Input     | Output     | Responsibility     | State Change     |
| ---------- | --------- | ---------- | ------------------ | ---------------- |
| `<method>` | `<input>` | `<output>` | `<responsibility>` | `<state change>` |

#### Invariants

| Invariant     | Enforcement Point        |
| ------------- | ------------------------ |
| `<invariant>` | `<method / constructor>` |

## 4.7 Interfaces and Function Signatures

### `<InterfaceName>`

```java
interface <InterfaceName> {
    <Output> <method>(<Input> input);
}
```

| 항목             | 정의                 |
| -------------- | ------------------ |
| Responsibility | `<responsibility>` |
| Caller         | `<caller>`         |
| Implementer    | `<implementer>`    |
| Input          | `<input>`          |
| Output         | `<output>`         |
| Preconditions  | `<conditions>`     |
| Postconditions | `<conditions>`     |
| Errors         | `<errors>`         |
| Side Effects   | `<side effects>`   |
| Idempotency    | `<idempotency>`    |

## 4.8 Error Propagation

```plantuml
@startuml
title Error Propagation

start

:<Failure Point>;
:<Source Error>;

if (<Domain failure?>) then (yes)
    :<Domain Error>;
else (no)
    :<Infrastructure Error Conversion>;
    :<Application Error>;
endif

if (<Retryable?>) then (yes)
    :<Retry Decision>;
else (no)
    :<Failure Result>;
endif

stop
@enduml
```

| Failure Point | Source Error | Converted Error | Handler     | Result     |
| ------------- | ------------ | --------------- | ----------- | ---------- |
| `<component>` | `<error>`    | `<error>`       | `<handler>` | `<result>` |

## 4.9 State Transition Implementation

| State Transition | Domain Owner  | Method     | Persistence Point        | Published Event |
| ---------------- | ------------- | ---------- | ------------------------ | --------------- |
| `<A → B>`        | `<aggregate>` | `<method>` | `<repository / adapter>` | `<event>`       |

## 4.10 Dependency Rules

### Allowed Dependencies

| Source     | Target     | Contract             |
| ---------- | ---------- | -------------------- |
| `<source>` | `<target>` | `<interface / port>` |

### Forbidden Dependencies

| Source     | Forbidden Target |
| ---------- | ---------------- |
| `<source>` | `<target>`       |

---

# 5. Technical Architecture

## 5.1 Boundary Mapping

Bounded Context, internal capability, code module, deployment service를 1:1로 매핑하지 않는다. 각 capability에는 필요한 격리를 만족하는 가장 약한 경계를 선택한다.

| Bounded Context | Internal Capability | Code Boundary                 | Deployment Unit | Boundary Rationale     |
| --------------- | ------------------- | ----------------------------- | --------------- | ---------------------- |
| `<context>`     | `<capability>`      | Package / Module / Process    | `<runtime>`     | `<why this strength>`  |

## 5.2 Boundary Promotion Decisions

| Candidate     | Owner Context | Chosen Boundary                                  | Why Not Weaker?         | Why Not Stronger?        | Introduced Cost                    |
| ------------- | ------------- | ------------------------------------------------ | ----------------------- | ------------------------ | ---------------------------------- |
| `<candidate>` | `<context>`   | Package / Module / Bounded Context / Service     | `<insufficient reason>` | `<unnecessary reason>`   | `<contract/build/runtime overhead>` |

새 module 또는 service는 기능 이름을 물리적 경계로 옮기기 위해 만들지 않는다. Package보다 module이 필요한 이유, module보다 service가 필요한 이유를 각각 증명한다. 미래 MSA 추출 가능성은 소유권과 seam을 보존하는 근거이지 모든 capability를 service 형태로 미리 만드는 근거가 아니다.

## 5.3 System Interaction Flow

```plantuml
@startuml
title System Interaction Flow

start

:<Caller Component / Deployment Unit>;
:<Provider Component / Deployment Unit>;

if (<Synchronous interaction?>) then (yes)
    :<API / Internal Call Request>;
    :<Response>;
else (no)
    :<Publish Message>;
    :<Consume Message>;
endif

if (<Storage access required?>) then (yes)
    :<Database / Cache>;
endif

if (<External system required?>) then (yes)
    :<External Adapter>;
    :<External System>;
endif

:<Result>;

stop
@enduml
```

## 5.4 Synchronous Communication

변경된 연결마다 현재 경로와 선택 근거를 source/ADR/System Target으로 연결한다. 내부 public API 직접 호출, 동기 원격 호출, 비동기의 대안과 선택 이유를 기록한다. 같은 프로세스의 호출에 broker나 network API를 자동 추가하지 않는다. commit/publish 경계와 transaction 참여·부분 실패·복구 책임은 선택한 방식에 맞춰 명시한다.

| Caller     | Provider     | Protocol               | Operation     | Request     | Response     | Timeout     |
| ---------- | ------------ | ---------------------- | ------------- | ----------- | ------------ | ----------- |
| `<caller>` | `<provider>` | HTTP / gRPC / Internal | `<operation>` | `<request>` | `<response>` | `<timeout>` |

## 5.5 API Contracts

### `<METHOD /path>`

#### Request

```json
{
  "<field>": "<value>"
}
```

#### Response

```json
{
  "<field>": "<value>"
}
```

#### Errors

| Condition     | Status / Code     | Response     |
| ------------- | ----------------- | ------------ |
| `<condition>` | `<status / code>` | `<response>` |

#### Properties

| Property       | Value          |
| -------------- | -------------- |
| Authentication | `<mechanism>`  |
| Authorization  | `<policy>`     |
| Idempotency    | `<key / none>` |
| Timeout        | `<duration>`   |
| Compatibility  | `<strategy>`   |

## 5.6 Asynchronous Communication

| Producer     | Consumer     | Channel                    | Message     | Delivery                     | Ordering  |
| ------------ | ------------ | -------------------------- | ----------- | ---------------------------- | --------- |
| `<producer>` | `<consumer>` | `<topic / queue / stream>` | `<message>` | at-most-once / at-least-once | `<scope>` |

## 5.7 Message Contracts

### `<MessageName>`

```json
{
  "messageId": "<id>",
  "aggregateId": "<id>",
  "version": "<version>",
  "occurredAt": "<timestamp>",
  "payload": {}
}
```

| Property           | Value        |
| ------------------ | ------------ |
| Message ID         | `<field>`    |
| Aggregate ID       | `<field>`    |
| Schema Version     | `<version>`  |
| Idempotency Key    | `<field>`    |
| Ordering Key       | `<field>`    |
| Duplicate Handling | `<behavior>` |
| Failure Handling   | `<behavior>` |
| Compatibility      | `<strategy>` |

## 5.8 Data Ownership

| Data     | Owner                 | Storage     | Key / Schema     | Readers     | Writers     |
| -------- | --------------------- | ----------- | ---------------- | ----------- | ----------- |
| `<data>` | `<context / service>` | `<storage>` | `<key / schema>` | `<readers>` | `<writers>` |

## 5.9 Schema Changes

| Target                     | Action                | Schema Change | Migration     | Compatibility     |
| -------------------------- | --------------------- | ------------- | ------------- | ----------------- |
| `<table / key / document>` | Add / Modify / Delete | `<change>`    | `<migration>` | `<compatibility>` |

## 5.10 Consistency Model

| Operation     | Consistency       | Source of Truth | Synchronization | Recovery     |
| ------------- | ----------------- | --------------- | --------------- | ------------ |
| `<operation>` | Strong / Eventual | `<source>`      | `<mechanism>`   | `<strategy>` |

## 5.11 Infrastructure Dependencies

각 requirement에 필요한 저장·조회·비동기·파일·외부 provider capability를 기존 자원 재사용 또는 신규 infrastructure로 빠짐없이 연결한다.

| Requirement / Target | Required Capability | Selected Existing / New Dependency | Owner / Query or Call Path | Evidence / Decision | Failure / Operations |
| -------------------- | ------------------- | ---------------------------------- | ------------------------- | ------------------- | -------------------- |
| `<REQ / UC / BR / target>` | `<persist / relational query / queue / blob / provider>` | `<technology / existing platform capability>` | `<domain owner → port/repository → adapter → schema/query/runtime>` | `<source ID or exact URL + locator; decision ID>` | `<consistency / recovery / config / readiness>` |

관계 데이터와 질의 조건이 Product 요구에 있으면 저장소 종류, 관계/schema, query path와 검증 사례를 적는다. 해당 capability가 불필요하면 그 근거를 기록한다.

## 5.12 External Dependency Isolation

| External Dependency | Port     | Adapter     | Internal Model | Conversion Point |
| ------------------- | -------- | ----------- | -------------- | ---------------- |
| `<dependency>`      | `<port>` | `<adapter>` | `<model>`      | `<converter>`    |

## 5.13 File and Module Structure

각 영향받는 deployment unit의 현재/target을 구분하고, 같은 프로세스 유지 또는 분리 배포의 근거를 연결한다. 독립 scaling·release·장애 격리·규제 등 확인된 요구가 없으면 현재 모듈형 모노리스 배포를 유지하는 안부터 검토한다. 추출 조건은 관찰 가능한 trigger/System Target으로 남기며, 수치를 추측하지 않는다.

### Existing Structure

```text
<existing structure>
```

### Target Structure

```text
<target structure>
```

### File Change Map

| Path     | Action                | Type / Component | Responsibility     |
| -------- | --------------------- | ---------------- | ------------------ |
| `<path>` | Add / Modify / Delete | `<type>`         | `<responsibility>` |

---

# 6. Runtime Design

## 6.1 Runtime Flow

```plantuml
@startuml
title Runtime Flow

start

:<Receive Request / Event>;

if (<Duplicate execution?>) then (yes)
    :<Return Existing Result / Ignore>;
    stop
endif

:<Acquire Lock / Begin Transaction>;
:<Load State>;
:<Execute Operation>;

if (<Operation succeeded?>) then (yes)
    :<Persist State>;
    :<Commit Transaction>;
    :<Publish External Effect>;
else (no)
    :<Rollback Transaction>;

    if (<Retryable?>) then (yes)
        :<Schedule Retry>;
    else (no)
        :<Failure Handling>;
    endif
endif

:<Release Lock>;

stop
@enduml
```

## 6.2 Concurrent Access

| Shared Resource | Concurrent Actors | Conflict                                  |
| --------------- | ----------------- | ----------------------------------------- |
| `<resource>`    | `<actors>`        | Race / Duplicate / Lost Update / Ordering |

## 6.3 Concurrency Control

| Target     | Control Unit | Strategy                                  | Owner     | Timeout     |
| ---------- | ------------ | ----------------------------------------- | --------- | ----------- |
| `<target>` | `<unit>`     | Lock / Atomic Operation / Optimistic Lock | `<owner>` | `<timeout>` |

## 6.4 Ordering

| Operation     | Ordering Scope                    | Ordering Key | Enforcement   |
| ------------- | --------------------------------- | ------------ | ------------- |
| `<operation>` | Global / Aggregate / Event / User | `<key>`      | `<mechanism>` |

## 6.5 Transaction Boundaries

| Transaction     | Owner     | Operations     | Commit Condition | Rollback Condition |
| --------------- | --------- | -------------- | ---------------- | ------------------ |
| `<transaction>` | `<owner>` | `<operations>` | `<commit>`       | `<rollback>`       |

## 6.6 Idempotency

| Operation     | Idempotency Key | Detection Point         | Duplicate Result |
| ------------- | --------------- | ----------------------- | ---------------- |
| `<operation>` | `<key>`         | `<component / storage>` | `<result>`       |

## 6.7 Partial Failure

| Failure Situation | Persisted State | External State | Recovery     |
| ----------------- | --------------- | -------------- | ------------ |
| `<failure>`       | `<state>`       | `<state>`      | `<recovery>` |

---

# 7. Error Handling and Recovery

## 7.1 Failure and Recovery Flow

```plantuml
@startuml
title Failure and Recovery Flow

start

:<Failure Detected>;
:<Classify Failure>;

if (<Retryable?>) then (yes)
    :<Retry with Backoff>;

    if (<Retry succeeded?>) then (yes)
        :<Resume Processing>;
    else (no)
        :<Retry Exhausted>;
        :<Compensation / Recovery>;
    endif
else (no)
    if (<Compensation required?>) then (yes)
        :<Compensation>;
    endif

    :<Failure Result>;
endif

stop
@enduml
```

## 7.2 Error Classification

| Error     | Category                                        | Retryable | Handler     | Caller Result |
| --------- | ----------------------------------------------- | --------- | ----------- | ------------- |
| `<error>` | Validation / Domain / Conflict / Infrastructure | Yes / No  | `<handler>` | `<result>`    |

## 7.3 Retry Policy

| Operation     | Retry Condition | Max Attempts | Backoff      | Exhausted Result |
| ------------- | --------------- | -----------: | ------------ | ---------------- |
| `<operation>` | `<condition>`   |    `<count>` | `<strategy>` | `<result>`       |

## 7.4 Compensation

| Failure     | Trigger     | Compensation | Compensation Failure |
| ----------- | ----------- | ------------ | -------------------- |
| `<failure>` | `<trigger>` | `<action>`   | `<follow-up>`        |

## 7.5 Recovery

| Failure     | Recovery Point | Recovery Input | Recovery Action |
| ----------- | -------------- | -------------- | --------------- |
| `<failure>` | `<point>`      | `<input>`      | `<action>`      |

## 7.6 Rollback

| Target                             | Rollback Strategy | Data Handling | Compatibility     |
| ---------------------------------- | ----------------- | ------------- | ----------------- |
| `<application / schema / message>` | `<strategy>`      | `<handling>`  | `<compatibility>` |

---

# 8. Security

## 8.1 Authentication and Authorization

| Entry Point     | Authentication | Authorization | Failure    |
| --------------- | -------------- | ------------- | ---------- |
| `<entry point>` | `<mechanism>`  | `<policy>`    | `<result>` |

## 8.2 Input Validation

| Input     | Validation     | Sanitization     | Size Limit |
| --------- | -------------- | ---------------- | ---------- |
| `<input>` | `<validation>` | `<sanitization>` | `<limit>`  |

## 8.3 Sensitive Data

| Data     | Storage Protection | Transport Protection | Log Policy  |
| -------- | ------------------ | -------------------- | ----------- |
| `<data>` | `<protection>`     | `<protection>`       | `<masking>` |

## 8.4 Secrets

| Secret     | Storage     | Consumer     | Rotation     |
| ---------- | ----------- | ------------ | ------------ |
| `<secret>` | `<storage>` | `<consumer>` | `<rotation>` |

---

# 9. Observability

## 9.1 Logs

| Component     | Event     | Level               | Context         |
| ------------- | --------- | ------------------- | --------------- |
| `<component>` | `<event>` | INFO / WARN / ERROR | `<identifiers>` |

## 9.2 Metrics

| Metric     | Type                        | Labels     | Trigger Point |
| ---------- | --------------------------- | ---------- | ------------- |
| `<metric>` | Counter / Gauge / Histogram | `<labels>` | `<component>` |

## 9.3 Tracing

| Span     | Parent     | Attributes     | Error Condition |
| -------- | ---------- | -------------- | --------------- |
| `<span>` | `<parent>` | `<attributes>` | `<condition>`   |

## 9.4 Alerts

| Alert     | Condition     | Severity           | Action     |
| --------- | ------------- | ------------------ | ---------- |
| `<alert>` | `<condition>` | Warning / Critical | `<action>` |

---

# 10. Change Boundaries

## 10.1 Allowed Changes

| Target                       | Allowed Change |
| ---------------------------- | -------------- |
| `<module / file / contract>` | `<change>`     |

## 10.2 Forbidden Changes

| Target                       | Forbidden Change |
| ---------------------------- | ---------------- |
| `<module / file / contract>` | `<change>`       |

## 10.3 Conditional Changes

| Target     | Condition     | Required Decision |
| ---------- | ------------- | ----------------- |
| `<target>` | `<condition>` | `<decision>`      |

---

# 11. Verification Requirements

## 11.1 Domain Verification

| UC / BR / AC | Domain Owner / Behavior | Business Condition / Action | Expected Business Result | Unit Test Intent |
| ------------ | ----------------------- | --------------------------- | ------------------------ | ---------------- |
| `<ID>`       | `<aggregate/entity/value object/domain service>` | `<meaningful rule branch>` | `<domain result / next state / business refusal>` | `<independent example; external dependencies mocked>` |

단위 테스트 사례는 업무 판단·행위·결과를 실행 가능한 명세로 표현한다. 일반적인 자료형 오류, framework/serialization/wiring, 단순 위임, mock 호출 횟수는 이 표에 포함하지 않는다. 해당 business rule이 없는 항목에는 테스트를 강제하지 않는다.

## 11.2 Program Verification

| Target                       | Verification     |
| ---------------------------- | ---------------- |
| `<component responsibility>` | `<verification>` |
| `<call contract>`            | `<verification>` |
| `<interface signature>`      | `<verification>` |
| `<dependency rule>`          | `<verification>` |

## 11.3 Technical Contract Verification

| Contract                                 | Test Level             | Verification     |
| ---------------------------------------- | ---------------------- | ---------------- |
| `<API / message / persistence contract>` | Integration / Contract | `<verification>` |

## 11.4 Runtime Verification

| Condition                                             | Execution Model | Expected Result |
| ----------------------------------------------------- | --------------- | --------------- |
| `<concurrency / transaction / idempotency condition>` | `<execution>`   | `<result>`       |

## 11.5 Recovery Verification

| Failure     | Injection Method | Expected Recovery |
| ----------- | ---------------- | ----------------- |
| `<failure>` | `<method>`       | `<recovery>`      |

## 11.6 Agent Verifier Criteria

### Domain

* [ ] Capability와 Bounded Context가 구분되어 있음
* [ ] 새 Bounded Context가 weaker boundary로 충분하지 않은 근거를 가짐
* [ ] Bounded Context 책임 준수
* [ ] Aggregate 경계 준수
* [ ] 비즈니스 규칙 소유권 준수
* [ ] 상태 전이 및 불변식 준수

### Program Design

* [ ] 주요 컴포넌트 책임 일치
* [ ] 인터페이스와 함수 시그니처 일치
* [ ] 호출 흐름 일치
* [ ] 오류 전파 방식 일치
* [ ] 의존성 규칙 준수

### Technical Architecture

* [ ] Bounded Context / capability / code boundary / deployment unit 매핑 일치
* [ ] 새 module 또는 service 경계가 weaker boundary로 충분하지 않은 근거를 가짐
* [ ] API와 메시지 계약 준수
* [ ] 데이터 소유권 준수
* [ ] 외부 의존성 격리
* [ ] 파일과 모듈 구조 일치

### Runtime

* [ ] 동시성 제어 준수
* [ ] 트랜잭션 경계 준수
* [ ] 순서 보장 준수
* [ ] 멱등성 준수
* [ ] 실패 복구 준수

### Scope

* [ ] 허용된 변경 범위 준수
* [ ] 금지된 변경 없음
* [ ] 불필요한 구조 변경 없음

### Evidence

* 실행 명령:
* 테스트 결과:
* 변경 파일:
* Architecture 위반:
* Contract 위반:
* 미검증 항목:
* Human Review 항목:

---

# 12. Alternatives and Trade-offs

| Decision     | Option     | Advantages     | Disadvantages     | Result                 |
| ------------ | ---------- | -------------- | ----------------- | ---------------------- |
| `<decision>` | `<option>` | `<advantages>` | `<disadvantages>` | Adopt / Reject / Defer |

---

# 13. Risks and Open Questions

## 13.1 Risks

| Risk     | Impact              | Probability         | Mitigation     |
| -------- | ------------------- | ------------------- | -------------- |
| `<risk>` | High / Medium / Low | High / Medium / Low | `<mitigation>` |

## 13.2 Open Questions

| Question     | Blocking | Resolution     |
| ------------ | -------- | -------------- |
| `<question>` | Yes / No | `<resolution>` |
## Architecture 다이어그램 계약

- 구조 모델이 적용되면 독립적인 `docs/specs/<plan-set-id>/diagrams/architecture/<context>.class.puml`과 같은 basename의 `.svg`를 만든다. 원본에는 관련 요구사항 또는 유스케이스 ID를 기록한다.
- 클래스 다이어그램의 클래스·컴포넌트·인터페이스·열거형 이름, 메서드·변수·상수 명, 타입, 매개변수, 반환 타입, 전체 시그니처는 원문 그대로 작성한다. 이를 번역하거나 한글 음역·변환하지 않는다. visibility 심볼과 타입·제네릭·연산자·관계 심볼도 코드 및 PlantUML 원문 그대로 유지하고, 한글은 note 또는 관계 라벨 같은 설명 텍스트에만 사용한다.
- 설계 상태(design-state)는 설계 책임의 상태 전이가 Product 업무 상태와 다른 목적을 가질 때만 `<concept>.state.puml`과 `.svg`로 만든다. 같은 상태 모델이면 중복하지 않고 `해당 없음 — Product business-state와 동일한 목적`을 기록한다.
- `.puml`가 유일한 편집 원본이며 문서에는 생성된 SVG 링크만 둔다. 렌더·링크·내용 일치 검토가 완료 조건이고, 렌더 실패는 완료를 막는다.
- Product 단계의 클래스 다이어그램은 이 계약에 포함되지 않는다.
