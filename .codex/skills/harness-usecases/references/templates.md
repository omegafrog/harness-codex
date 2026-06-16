## Use Case Document Template

`docs/design/유스케이스.md` must follow this structure.

```markdown
# Use Case Document

## 1. Actor Definitions
### Main Actors
- ...

### Supporting Actors
- ...

## 2. High-Level Use Case List
### <Actor Group>
- UC-001. <Actor performs goal>

## 3. Use Case Details
## UC-001. <Actor performs goal>
**Actor**
- ...

**Supporting Actor**
- ...

**Goal**
- ...

**Preconditions**
- ...

**Main Flow**
1. ...

**Failure Flow**
- ...

**Result**
- ...

**Non-Functional Requirements**
- ...

---

## 4. System-Wide Non-Functional Requirements
### 4.1 Performance
- ...

### 4.2 Scalability
- ...

### 4.3 Availability
- ...

### 4.4 Data Consistency
- ...

### 4.5 Concurrency Control
- ...

### 4.6 Security
- ...

### 4.7 Failure Handling and Recovery
- ...

### 4.8 Auditability and Operability
- ...

## 5. Needs Confirmation
- ...
```

## Runtime Slice Templates

`docs/use-cases/<UC-ID>/use-case.md` must follow this structure.

```markdown
# <UC-ID>. <Actor performs goal>

## Actor
- ...

## Supporting Actor
- ...

## Goal
- ...

## Preconditions
- ...

## Main Flow
1. ...

## Failure Flow
- ...

## Result
- ...

## Non-Functional Requirements
- ...

## Needs Confirmation
- None
```

`docs/use-cases/<UC-ID>/e2e-goal.md` must follow this structure. It is a pre-implementation
business acceptance contract. Keep request/response payload examples, Playwright steps, fixtures,
test file names, commands, and actual pass/fail output out of this document; the planner/executor
records those details later in `docs/plans/active/<UC-ID>/verification.md` or the plan verification
result.

```markdown
# <UC-ID> E2E Goal

## Metadata
|Item|Value|
|---|---|
|Approval Status|approved|
|Approved by|user-confirmed requirements and use-case harvest|

## Goal
- ...

## Business Success Criteria
- ...

## Business Failure Criteria
- ...

## Observability Boundary
- Browser-visible UI: yes / no / needs confirmation
- API/runtime observable behavior: yes / no / needs confirmation
- Required user-visible evidence:

## Given
- ...

## When
- ...

## Then
- ...

## Out of Scope
- Implementation-specific commands, fixtures, API request/response examples, UI automation steps, and actual pass/fail output.
- These details belong in `docs/plans/active/<UC-ID>/verification.md` or the plan verification result after implementation.

## Needs Confirmation
- None
```

Even when a use case has no supporting actors, failure flow, or non-functional
requirements, keep the sections and write `- None` or `- Needs confirmation`.
When `Needs Confirmation` is `None`, write `Approval Status` as `approved`; do
not leave generated E2E goals in `pending` state.
