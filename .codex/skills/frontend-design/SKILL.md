---
name: frontend-design
description: Build or materially redesign user-facing web UI through a standalone reference-first design, implementation, browser review, and correction workflow.
---

# frontend-design

프런트엔드 화면을 새로 만들거나 기존 UI/UX를 크게 개선할 때 사용하는 독립 workflow다.

이 skill은 `implement`, `implement-wrapper`, `code-review`, `e2e-test`의 하위 단계가 아니다. 해당 workflow를 호출하거나 tracker 상태를 변경하지 않는다. 프런트엔드 작업은 이 skill의 자체 design → implementation → visual review → correction loop로 완료한다.

## Scope

다음 작업에 사용한다.

- 새 page, view, app shell, dashboard, editor, form flow 구현
- 기존 화면의 layout, visual hierarchy, interaction, responsive UX 재설계
- 디자인 시스템을 따르는 component/page 구현
- Figma 또는 외부 reference를 코드로 옮기는 작업
- "기능은 동작하지만 UI/UX가 좋지 않다"는 문제 개선

단순 copy 변경, 눈에 보이지 않는 frontend infrastructure, backend-only 변경에는 사용하지 않는다.

## Model routing

`.codex/harness.yaml`에서 실제 model ID와 reasoning effort를 resolve한다.

- Design direction / reference synthesis: `agents.high_performance_model`
- Implementation / correction: `agents.implementation_model`
- Visual / UX review: `agents.high_performance_model`

literal config key를 agent에 전달하지 않는다. 필요한 값이 없으면 `setup`이 필요하다고 보고하고 시작하지 않는다.

## Workspace contract

1. caller가 전달한 절대 `workspace_root`를 사용한다.
2. 모든 repository 명령은 해당 경로를 cwd로 사용한다.
3. 시작 전에 다음 preflight를 실행한다.

   ```bash
   node .codex/scripts/harness-workspace-preflight.mjs --expected-root <workspace_root> --json
   ```

4. `valid: true`, `cwd`, `git_root`, `worktree_registered`를 확인한다.
5. 현재 branch, HEAD, porcelain status를 기록한다.
6. user-owned dirty changes를 덮어쓰지 않는다. 관련 파일에 충돌 가능성이 있으면 해당 파일은 blocker로 보고한다.
7. 이 workflow는 새 worktree, tracker ticket, PR을 자동 생성하지 않는다.

## Inputs

우선순위대로 사용한다.

1. 사용자의 현재 요청과 명시된 화면/flow
2. 사용자 제공 Figma frame, screenshot, design reference
3. ticket-scoped Product Spec이 명시되어 있으면 해당 요구사항
4. `docs/design/DESIGN.md`가 있으면 project visual language
5. 기존 frontend source, design tokens, shared components, Storybook
6. 외부 reference discovery를 할 수 있는 web/browser/design 도구

현재 구현은 target behavior의 근거가 아니라 current-state evidence다.

## Phase 1 — Current UI inventory

디자인 결정을 내리기 전에 현재 frontend를 조사한다.

- framework와 styling approach
- token/theme source
- shared primitives와 reusable components
- existing layout/navigation conventions
- Storybook/component docs 존재 여부
- current responsive strategy
- configured lint/typecheck/test commands
- design-system linter 존재 여부
- Figma/Code Connect 등 design source 연결 여부

기존 component와 token을 재사용할 수 있는데 새 primitive를 만들지 않는다.

## Phase 2 — Reference-first design

시각 방향을 모델의 일반적인 취향에서 바로 생성하지 않는다.

가능하면 관련 interaction/problem을 해결한 실제 제품 reference 3~5개를 조사한다. 단순히 "예쁜 사이트"가 아니라 이번 화면과 동일하거나 가까운 작업을 해결하는 사례를 고른다.

각 reference에서 다음만 추출한다.

- information architecture / layout
- hierarchy와 density
- navigation pattern
- component treatment
- typography rhythm
- interaction / state behavior
- responsive behavior

한 개를 **dominant visual direction**으로 선택하고 나머지는 보조 influence로만 사용한다. 서로 다른 제품의 표면 스타일을 무작위로 섞지 않는다.

외부 reference 검색 도구가 없으면 reference를 꾸며내지 않는다. 사용자 제공 reference와 기존 제품 UI를 사용하고, external reference evidence가 없다는 점을 design brief에 명시한다.

## Phase 3 — Frontend design brief

구현 전에 아래 항목을 확정한다. 이 brief는 agent handoff에 그대로 전달한다. 사용자가 별도 문서화를 요청하지 않는 한 tracked 문서를 새로 만들지 않아도 된다.

- User goal and primary task
- Screen/flow scope
- Dominant reference and supporting influences
- Existing design-system assets to reuse
- Visual character
- Information hierarchy
- Layout model and responsive behavior
- Typography roles
- Surface/border/shadow rules
- Spacing/density rules
- Primary / secondary / destructive action hierarchy
- Loading / empty / error / disabled states
- Keyboard/focus/accessibility expectations
- Explicit anti-patterns
- Acceptance scenarios

### Default anti-patterns

Product context가 명시적으로 요구하지 않는 한 다음을 피한다.

- app UI를 marketing landing page처럼 만드는 oversized hero
- 의미 없는 gradient / glow / blob
- card 안의 card를 반복하는 nested surface
- 모든 element에 큰 radius를 적용하는 방식
- 정보 구조 없이 icon + title + subtitle card를 반복하는 방식
- raw color와 임의 spacing을 화면별로 추가해 design system을 우회하는 방식
- desktop screenshot만 맞추고 narrow viewport를 방치하는 방식
- loading / error / empty / disabled / focus 상태 누락
- hover만으로 의미를 전달하는 interaction

## Phase 4 — Implementation

`multi_agent_v1.spawn_agent`로 `agent_type="frontend_implementation_agent"`를 fresh context로 호출한다.

전달해야 하는 것:

- absolute `workspace_root`
- user request
- settled frontend design brief
- relevant source/component paths
- target routes/screens
- acceptance scenarios
- resolved implementation model ID / reasoning effort

구현 agent는 `frontend-implement` skill을 사용한다.

## Phase 5 — Browser visual review

구현 후 `agent_type="frontend_visual_reviewer"`를 fresh context로 호출한다.

전달해야 하는 것:

- absolute `workspace_root`
- frontend design brief
- exact routes / user flow
- project execution instructions
- resolved high-performance model ID / reasoning effort

reviewer는 `frontend-visual-review` skill을 사용하고 source를 수정하지 않는다.

DOM 또는 accessibility tree만으로 visual quality를 통과시키지 않는다. 실제 browser render와 screenshot inspection이 필요하다.

## Phase 6 — Correction loop

visual reviewer가 BLOCKER 또는 MAJOR finding을 보고하면 fresh `frontend_implementation_agent`에 findings와 screenshot evidence를 전달해 수정한다. 이후 visual review를 다시 실행한다.

기본적으로 correction round는 최대 3회다.

- 같은 문제가 반복되면 blind retry를 멈추고 원인을 보고한다.
- design brief 자체가 잘못된 경우 implementation agent가 임의로 방향을 바꾸지 않는다. frontend designer 단계로 돌아가 brief를 수정한다.
- MINOR finding만 남았고 acceptance scenario가 모두 통과하면 완료 가능하되 남은 항목을 보고한다.

## Design-system enforcement

프로젝트가 가진 시스템을 우선 사용한다.

- existing components / tokens / variants를 우선 재사용
- token이 존재하는데 raw color, arbitrary spacing, inline style로 우회하지 않음
- shadcn 기반 프로젝트면 registry와 existing components를 먼저 확인
- Base UI / Radix / React Aria 등 primitive library가 있으면 interaction semantics를 재구현하지 않음
- project에 design-system lint command가 설정돼 있으면 반드시 실행
- `@shadcn/lint`가 이미 설정돼 있으면 해당 repository가 정의한 command를 실행하고 violation을 해결
- 새로운 dependency를 단지 "더 예쁘게 보이기 위해" 자동 추가하지 않음

## Optional integrations

도구가 실제로 연결되어 있을 때만 사용한다.

- Figma: selected frame, variables, components, Code Connect를 authoritative design evidence로 사용
- Storybook: component API, variants, states, stories를 확인하고 기존 component를 재사용
- Playwright: user flow, responsive viewport, screenshot inspection에 사용
- Agentation / equivalent annotation tooling: 사용자가 특정 DOM element에 남긴 feedback을 correction evidence로 사용
- visual regression service: 기존 baseline이 있는 프로젝트에서 regression 확인

연결되지 않은 도구를 있다고 가정하지 않는다.

## Completion criteria

다음을 모두 만족해야 완료다.

- reference 또는 기존 design evidence에 근거한 일관된 visual direction이 존재한다.
- agreed user flow가 실제 브라우저에서 동작한다.
- target desktop과 narrow viewport에서 overflow, clipping, broken wrapping이 없다.
- hierarchy, spacing, typography, action emphasis가 design brief와 일치한다.
- loading / empty / error / disabled 중 해당되는 상태가 구현되어 있다.
- keyboard/focus/accessibility 요구사항 중 적용 가능한 항목이 검증됐다.
- configured lint/typecheck/test가 통과한다.
- configured design-system lint가 있으면 통과한다.
- final visual review에 unresolved BLOCKER/MAJOR가 없다.
- 테스트/스크린샷 artifact가 tracked 또는 staged 상태로 남지 않는다.

## Final report

- workspace root
- implemented routes/screens
- dominant reference direction
- reused design-system assets
- validation commands
- browser viewports / flows reviewed
- visual review rounds
- remaining MINOR findings
- blockers, if any

tracker, 기존 implementation plan status, PR은 변경하지 않는다.
