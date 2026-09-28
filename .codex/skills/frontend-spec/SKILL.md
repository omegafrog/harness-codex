---
name: frontend-spec
description: Define a frontend screen or flow before Figma or implementation by producing a durable design package with screen behavior, visual direction, references, component/state contracts, and Storybook coverage.
---

# frontend-spec

프런트엔드 화면을 Figma로 그리거나 코드로 구현하기 **전에** 사용하는 독립 design-spec workflow다.

이 skill의 결과는 구현물이 아니라 `docs/design/<screen-id>/`의 **Frontend Design Package**다.

- Figma를 작성하지 않는다.
- application source를 수정하지 않는다.
- Storybook story를 구현하지 않는다.
- tracker / implementation plan / PR 상태를 변경하지 않는다.
- 이후 `frontend-design`이 이 package를 authoritative design input으로 사용한다.

## Scope

다음에 사용한다.

- 새 page / view / app shell / dashboard / editor / form flow의 화면 설계
- 기존 화면의 큰 UX / information architecture 재설계
- screenshot / reference image를 근거로 디자인 방향을 구체화
- Figma-first 작업 전에 화면·상태·component contract를 확정
- Storybook에 어떤 component/state story가 필요한지 설계

단순 copy 수정이나 작은 CSS polish에는 사용하지 않는다.

## Model routing

`.codex/harness.yaml`에서 high-performance model과 reasoning effort를 resolve한다.

이 단계는 제품 맥락, reference 해석, information hierarchy, interaction/state contract를 함께 결정하므로 lightweight writer로 낮추지 않는다.

## Workspace contract

1. caller가 전달한 절대 `workspace_root`를 사용한다.
2. 모든 repository 명령은 해당 경로를 cwd로 사용한다.
3. 시작 전에 다음 preflight를 실행한다.

   ```bash
   node .codex/scripts/harness-workspace-preflight.mjs --expected-root <workspace_root> --json
   ```

4. `valid: true`, `cwd`, `git_root`, `worktree_registered`를 확인한다.
5. 현재 branch / HEAD / porcelain status를 기록한다.
6. user-owned dirty changes를 덮어쓰지 않는다.
7. design package 외 application source, tests, workflow config, tracker를 수정하지 않는다.

## Input precedence

다음 순서로 근거를 사용한다.

1. 사용자의 현재 요청과 직접 설명
2. 사용자가 제공한 screenshot / image / Figma screenshot / reference URL
3. 명시적으로 전달된 Product Spec / ticket requirement
4. project-wide `docs/design/DESIGN.md`
5. 현재 frontend의 navigation / layout / component / token / Storybook evidence
6. 가능한 경우 외부 product reference research

현재 구현은 **current-state evidence**다. 사용자가 바꾸려는 UX를 기존 코드가 우연히 그렇게 되어 있다는 이유로 유지하지 않는다.

## Output location

screen/flow마다 stable kebab-case `screen-id`를 정하고 다음 package를 만든다.

```text
docs/design/<screen-id>/
├── frontend-design-spec.md
├── visual-direction.md
├── ui-contract.md
└── references/              # optional; 실제 asset을 안전하게 materialize할 수 있을 때만
```

이미지가 대화/외부 도구에만 있고 repository asset으로 materialize할 수 없으면 가짜 파일 경로를 만들지 않는다. 대신 `visual-direction.md`에 source와 역할을 기록한다.

`docs/design/DESIGN.md`는 project-wide design language다. 사용자가 명시적으로 요청하지 않는 한 이 screen-specific workflow가 자동 수정하지 않는다.

## Phase 1 — Screen scope and current-state inventory

먼저 다음을 확인한다.

- target route / entry point
- primary user
- primary task
- secondary tasks
- upstream/downstream flow
- desktop / mobile importance
- existing route/component tree
- existing design tokens / primitives / shared layout
- current Storybook coverage
- known UX pain points
- states that already exist in behavior/API but are visually missing

현재 화면 screenshot이 있으면 문제를 구체적으로 기록한다. 단순히 "별로다"라고 쓰지 않는다.

예:

- primary action과 secondary action visual weight가 동일함
- map보다 metadata panel이 더 많은 공간을 차지함
- loading 중 action composer가 enabled 상태라 중복 submit 위험
- mobile에서 inspector가 content 아래로 밀려 primary task를 가림

## Phase 2 — Reference evidence

### Reference roles

reference를 다음 역할로 분리한다.

- **Primary reference**: 전체 visual / information-density 방향을 결정하는 하나의 dominant reference
- **Supporting reference**: 특정 layout / interaction / component behavior만 차용
- **Anti-reference**: 명시적으로 피할 패턴

가능하면 동일하거나 가까운 task를 해결하는 real product reference 3~5개를 조사하되, reference 숫자를 채우기 위해 관련 없는 제품을 넣지 않는다.

각 reference에는 반드시 다음을 쓴다.

- source
- evidence type: screenshot | URL | Figma | current product
- use: 가져올 원칙
- avoid: 가져오지 않을 표면/branding/pattern
- target area: 어느 screen/component에 영향이 있는지

사용자가 제공한 이미지를 실제로 보지 못했으면 봤다고 주장하지 않는다.

## Phase 3 — `frontend-design-spec.md`

이 문서는 **화면/flow가 무엇을 해야 하는가**를 정의한다.

필수 섹션:

### Context

- screen id / route
- user goal
- primary task
- secondary tasks
- success condition
- out of scope

### Information hierarchy

화면에서 중요한 정보를 1순위부터 정렬한다.

예:

1. current scene / map
2. immediate action
3. GM/system response
4. party status
5. history / secondary tools

### Screen inventory

한 flow에 여러 화면이 있으면 screen/state 단위로 나눈다.

예:

- Session / Default
- Session / Turn Processing
- Session / Combat
- Session / Connection Error
- Mobile / Inspector Open

### Layout contract

desktop / compact desktop / mobile에서 영역 관계를 설명한다.

ASCII wireframe을 사용해도 되지만 px-perfect mockup으로 위장하지 않는다.

### User flow

행동 → feedback → state transition을 기록한다.

예:

```text
Select token
  -> token selected
  -> inspector updates
  -> available actions update
```

### Behavior and state requirements

적용 가능한 상태:

- default
- loading
- empty
- error
- disabled
- selected
- focused
- submitting
- streaming
- disconnected
- destructive confirmation

### Accessibility / input

- keyboard
- focus order / focus-visible
- touch target
- screen-reader-relevant labels/state
- hover-only information 금지

### Acceptance scenarios

실제 browser에서 검증 가능한 사용자 시나리오로 쓴다.

## Phase 4 — `visual-direction.md`

이 문서는 **어떤 디자인 언어를 적용할 것인가**를 정의한다.

필수 섹션:

### Visual character

3~6개의 구체적인 성격을 사용한다.

좋은 예:

- dense tactical workspace
- restrained dark neutral surfaces
- low-decoration high-information UI
- map-first spatial hierarchy

나쁜 예:

- modern
- pretty
- premium
- clean

단독으로 쓰지 않는다.

### Reference board

Primary / Supporting / Anti-reference를 위 규칙에 따라 정리한다.

reference image가 repository에 실제 존재하면 상대 경로로 embed한다.
외부 URL/대화 attachment만 존재하면 source를 설명하고 가짜 asset을 만들지 않는다.

### Hierarchy

- strongest visual anchor
- primary / secondary / destructive action treatment
- metadata treatment
- selection / active treatment

### Typography roles

구체 font family를 근거 없이 발명하기보다 role을 먼저 정의한다.

- page/screen title
- section label
- body
- metadata
- code/numeric/stat

project typography token이 있으면 재사용한다.

### Surface / border / radius / elevation

UI의 depth model을 정한다.

### Spacing and density

- compact / balanced / spacious
- repeated spacing rhythm
- control density
- panel padding expectations

### Color semantics

brand palette보다 semantic role을 우선한다.

- background
- surface
- elevated surface
- text primary / secondary
- accent
- destructive
- warning / success
- focus

### Motion

상태 변화 / spatial continuity / feedback에 필요한 motion만 정의한다.

### Explicit anti-patterns

이번 화면에서 피해야 할 디자인을 적는다.

기본 후보:

- oversized marketing hero
- gratuitous gradient/glow/blob
- nested cards
- large radius everywhere
- icon + title + subtitle 반복 카드
- raw design token bypass
- desktop screenshot only
- hover-only meaning

## Phase 5 — `ui-contract.md`

이 문서는 **Figma component / React component / Storybook story 사이의 계약**이다.

### Screen-state matrix

예:

| Screen state | Main content | Primary action | Secondary panel | Feedback |
| --- | --- | --- | --- | --- |
| Default | live content | enabled | visible | idle |
| Loading | stale/skeleton | disabled | visible | progress |
| Error | recoverable content | retry | preserved | error message |

### Component inventory

각 component마다 다음을 정의한다.

- responsibility
- required data
- user actions
- variants
- states
- responsive behavior
- accessibility expectations
- reuse candidate from existing code/Figma, if known

### Storybook coverage contract

Storybook 자체를 설계서로 사용하지 않는다.

대신 `ui-contract.md`에서 구현 후 필요한 stories를 정의한다.

예:

```text
ActionComposer
- Default
- Focused
- WithLongText
- Submitting
- Disabled
- Error
- NarrowViewport
```

story는 **실제 구현 component의 rendered state**를 검증하는 산출물이다.

다음은 screen-level E2E/browser flow로 검증하고 component story로 억지로 분해하지 않는다.

- routing
- multi-step navigation
- backend streaming orchestration
- cross-component end-to-end state transition

### Figma mapping contract

후속 `frontend-design`이 Figwright로 만들 때 어떤 단위를 Figma component/variant로 승격할지 명시한다.

- repeated reusable control → component
- meaningful state axis → variant/property
- semantic repeated values → variable/style candidate
- page-specific one-off layout → frame/section, 무조건 component화하지 않음

## Decision status

material decision에는 필요하면 상태를 붙인다.

- SETTLED
- PARTIAL
- UNRESOLVED
- NOT_APPLICABLE

다음 항목의 중요한 `UNRESOLVED`가 남으면 package를 READY로 선언하지 않는다.

- primary task
- information hierarchy
- primary user flow
- major screen states
- responsive priority
- dominant visual direction
- component/state boundary

사소한 spacing 숫자나 exact shadow 값은 Figma 단계에서 정할 수 있으므로 이 단계에서 과도하게 질문하지 않는다.

## Package completion

package가 완료되려면:

- 세 문서가 모두 존재한다.
- 서로 screen/state/component 이름이 충돌하지 않는다.
- Primary reference가 하나이거나, reference가 없다는 사실과 대체 evidence가 명시되어 있다.
- user flow와 state가 `ui-contract.md`의 component/state와 연결된다.
- Storybook coverage가 component state 중심으로 정의돼 있다.
- desktop/mobile 또는 해당 제품의 주요 responsive strategy가 정의돼 있다.
- material `UNRESOLVED`가 없다.
- Figma/code를 아직 구현하지 않았다.

## Handoff to `frontend-design`

완료 후 다음 정보를 전달한다.

- absolute `workspace_root`
- package directory: `docs/design/<screen-id>/`
- package status: READY
- target route(s)
- reference evidence summary
- existing design-system reuse candidates
- explicit Figma-first 여부

후속 호출 예:

```text
$frontend-design

docs/design/adventure-session/ package를 authoritative design input으로 사용해.
Figwright를 사용해서 Figma-first로 진행해.
```

`frontend-design`은 READY package가 있으면 같은 문제를 처음부터 다시 디자인하지 않고 package를 검증·소비한다.
