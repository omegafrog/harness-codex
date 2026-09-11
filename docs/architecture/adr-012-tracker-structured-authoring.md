# ADR-012: Tracker Structured Authoring 계약

- 상태: Accepted
- 결정일: 2026-09-11

## Context

Plan Set의 Issue, split plan의 child Issue, implementation PR은 같은 계획 세트를 서로 다른 tracker 문서로 표현한다. 사람이 작성하는 GitHub form/template와 deterministic renderer의 필드·섹션이 다르면 Issue 관계, 구현 범위, 검증 결과, closing reference가 drift할 수 있다.

## Decision

### Canonical input

GitHub Plan Set Issue form의 `structured-source`가 유일한 canonical 입력이다. YAML/JSON source는 `validatePlanSetSource`로 parse·validate한 뒤 `renderPlanSetIssue`에 전달한다. 실제 mutation 경계는 `preparePlanSetIssue`와 `trackerCreatePlanSetIssue`이며, 이 경계를 통과한 canonical title/body만 external tracker port에 전달한다. form의 나머지 입력은 사람이 확인하는 preview이며 별도 source로 사용하지 않는다.

Plan Set과 split plan은 각각 `.codex/schemas/tracker/plan-set.schema.yaml`, `.codex/schemas/tracker/split-plan.schema.yaml`의 versioned contract를 따른다. 구현 PR은 `.codex/schemas/tracker/implementation-pr.schema.yaml`을 따르며, `implemented_plans`가 모든 `child_issues`를 정확히 한 번씩 커버해야 한다.

### Implementation PR sections

`renderImplementationPr`와 `.github/pull_request_template.md`는 다음 순서와 이름을 공유한다.

1. `Summary`
2. `Plan Set`
3. `Implemented Plans`
4. `Key Changes`
5. `Verification`
6. `Review`
7. `Risks / Follow-ups`
8. `Plan-set Integrity`

Implementation PR은 plan set마다 정확히 하나만 만들며, `Plan-set Integrity`에서 모든 child Issue coverage와 single integration PR invariant를 표시한다.

### Closing references

Closing keyword는 implementation PR에서만 renderer가 생성한다. parent Issue와 모든 child Issue에 각각 한 줄의 `Closes #<number>`를 생성한다. Plan PR이나 Issue body에는 구현 완료를 의미하는 closing keyword를 넣지 않는다.

### Doctor boundary

`harness-codex-doctor`는 `.github/pull_request_template.md`가 정확히 하나의 ordered managed section을 갖는지, 여덟 개 canonical section이 그 영역 안에 있는지, parent/child closing reference 자리와 single integration PR invariant를 보존하는지 검사한다. 위반은 CI에서 수정 전까지 통과하지 않는다.

## Consequences

- 사람이 작성하는 GitHub authoring surface와 renderer output의 구조가 고정된다.
- 자유 형식 preview가 canonical tracker source를 덮어쓰지 않는다.
- plan coverage 또는 closing reference 누락을 mutation 전에 발견할 수 있다.
- 새로운 tracker 문서 종류를 추가하면 해당 schema, renderer, form/template, doctor contract를 함께 확장해야 한다.
