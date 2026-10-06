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
2. 명시적으로 전달된 READY Frontend Design Package (`docs/design/<screen-id>/`의 `frontend-design-spec.md`, `visual-direction.md`, `ui-contract.md`)
3. 사용자 제공 Figma frame, screenshot, design reference
4. 사용자가 Figwright/Figma-first를 요구했는지와 target Figma file 정보
5. ticket-scoped Product Spec이 명시되어 있으면 해당 요구사항
6. `docs/design/DESIGN.md`가 있으면 project visual language
7. 기존 frontend source, design tokens, shared components, Storybook
8. 외부 reference discovery를 할 수 있는 web/browser/design 도구

현재 구현은 target behavior의 근거가 아니라 current-state evidence다.

## Frontend Design Package contract

사용자가 `$frontend-spec`이 만든 package directory를 전달하면 세 문서를 모두 읽고 package status/consistency를 확인한다.

- `frontend-design-spec.md`: screen/flow, hierarchy, layout, interaction, acceptance scenario
- `visual-direction.md`: dominant reference, visual language, anti-patterns
- `ui-contract.md`: screen-state matrix, component/state/Storybook/Figma mapping contract

package가 READY이고 material conflict가 없으면 해당 결정을 **authoritative design input**으로 사용한다.

- 같은 reference research를 처음부터 반복하지 않는다.
- primary task / hierarchy / dominant visual direction / component-state boundary를 임의로 재설계하지 않는다.
- 현재 코드/Figma와 충돌하는 구현상 제약은 blocker 또는 adaptation으로 보고한다.
- package에 material `UNRESOLVED`가 있으면 Figma/code 구현으로 넘어가지 않는다.
- package를 수정해야 할 수준의 design change는 `frontend-spec` 단계로 돌려보낸다.

READY package가 없는 즉석 UI 요청은 아래 Phase 1~3의 기존 design-brief 경로를 사용한다.

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
- Figwright MCP/plugin 연결 여부와 target Figma file
- 기타 Figma/design source 연결 여부

기존 component와 token을 재사용할 수 있는데 새 primitive를 만들지 않는다.

## Phase 2 — Reference-first design

READY Frontend Design Package가 있으면 이 단계는 package의 `visual-direction.md`를 검증·소비하는 단계다. package가 없을 때만 아래 reference discovery를 새로 수행한다.

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

READY Frontend Design Package가 있으면 세 문서를 handoff brief로 정규화하되 제품/디자인 결정을 다시 만들지 않는다.

package가 없으면 구현 전에 아래 항목을 확정한다. 이 brief는 agent handoff에 그대로 전달한다. 사용자가 별도 문서화를 요청하지 않는 한 tracked 문서를 새로 만들지 않아도 된다.

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
- UI copy inventory and microcopy budget

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

### UI Copy Restraint

UI는 설명서가 아니다. **시각적으로 전달할 수 있는 상태를 설명 문장으로 되풀이하지 않는다.**

- 사용자가 이미 UI 상태를 보고 알 수 있는 내용을 텍스트로 설명하지 않는다.
- 시스템 규칙, 행동 가능 여부, 상태 변화를 장문의 안내문으로 풀어 쓰지 않는다.
- 명시적으로 요구되지 않은 helper text, subtitle, description, hint를 만들지 않는다.
- “친절하게 설명하기 위해” 문구를 추가하거나 기존 UI에 없는 카피를 발명하지 않는다.
- 버튼이나 아이콘의 의미를 바로 옆 문장으로 다시 설명하지 않는다. 게임 HUD를 튜토리얼 문구로 채우지 않는다.
- 설명을 더해 UX 모호성을 해결하지 않는다. interaction이나 visual hierarchy를 고친다.

> Do not solve UX ambiguity by adding explanatory copy. Fix the interaction or visual hierarchy instead.

표현은 다음 우선순위를 따르고, 낮은 단계의 텍스트를 쓰기 전에 시각 상태나 더 짧은 표현으로 해결할 수 있는지 확인한다.

1. 시각적 상태
2. 숫자, 아이콘, 게이지
3. 짧은 label
4. 필요한 경우에만 tooltip
5. 꼭 필요한 경우에만 helper text

일반적인 게임 HUD와 component에서는 label을 1~4단어, 버튼을 1~3단어로 유지하고, 상태는 가능하면 단어나 숫자로 표현한다. 설명 문장은 기본 예산 0개다. 설명이 유용해 보이더라도 사용자가 명시적으로 요구하지 않았다면 추가하지 않는다. 단, 접근성 이름과 오류·안전 등 사용자의 올바른 행동에 필수인 정보는 생략하지 않는다.

예를 들어 행동 규칙을 두 문장으로 설명하지 말고 `행동 ●`, `이동 4/6`, `보조 행동 ●`처럼 상태를 보여준다. 세부 설명이 정말 필요하면 기본 화면을 문장으로 채우지 말고 tooltip을 검토한다.

## Phase 3.5 — Figwright / Figma authoring

Figwright MCP가 연결되어 있고 사용자가 Figma-first 작업을 요구했거나 Figma를 authoritative design source로 사용하기로 한 경우, 구현 전에 `.codex/skills/frontend-figma/SKILL.md`의 **Mode A**를 실행한다.

흐름:

1. Figwright `ping`으로 local MCP server + Figma plugin 연결을 확인한다.
2. 여러 Figma file이 열려 있으면 `list_files` / `use_file`로 target file을 명시적으로 claim한다.
3. existing Figma variables/components/styles와 project tokens/components를 조사한다.
4. design brief와 사용자 reference를 native Figma frame/Auto Layout/component/variable 구조로 작성한다.
5. `get_screenshot`으로 Figma 자체를 시각 검토하고 필요한 correction을 수행한다.
6. authoritative root frame/node id와 file/session identity를 **Figwright handoff**로 만든다.

Figwright가 연결되어 있지 않으면 Figma를 수정했다고 주장하지 않는다.

- 사용자가 Figma-first를 **필수**로 요청했다면 blocker로 중단한다.
- Figma가 optional인 일반 frontend 작업이면 기존 code-first path로 진행할 수 있다.

Figma Agent / Figma Make / official Dev Mode MCP를 이 단계의 전제로 사용하지 않는다. 이 workflow의 Figma bridge는 Figwright다.

## Phase 4 — Implementation

`multi_agent_v1.spawn_agent`로 `agent_type="frontend_implementation_agent"`를 fresh context로 호출한다.

전달해야 하는 것:

- absolute `workspace_root`
- user request
- settled frontend design brief
- source Frontend Design Package path/status when present
- Figwright handoff when present: file/session identity, authoritative root node id, Figma screenshot evidence, mapping/design-system gaps
- relevant source/component paths
- target routes/screens
- acceptance scenarios
- resolved implementation model ID / reasoning effort

구현 agent는 `frontend-implement` skill을 사용한다. Figwright handoff가 있으면 `.codex/skills/frontend-figma/SKILL.md`의 **Mode B**로 Figma design context / component_map / token_map / icon_map을 먼저 grounding한 뒤 코드를 작성한다.

## Phase 5 — Browser visual review

구현 후 `agent_type="frontend_visual_reviewer"`를 fresh context로 호출한다.

전달해야 하는 것:

- absolute `workspace_root`
- frontend design brief
- Figwright handoff when present: file/session identity and authoritative root node id
- exact routes / user flow
- project execution instructions
- resolved high-performance model ID / reasoning effort

reviewer는 `frontend-visual-review` skill을 사용하고 source를 수정하지 않는다. Figwright handoff가 있으면 `.codex/skills/frontend-figma/SKILL.md`의 **Mode C**에 따라 authoritative Figma screenshot과 실제 browser screenshot을 비교한다.

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

- Figwright: Figma-first 요청에서는 local MCP/plugin bridge로 native Figma design을 작성하고, `get_design_context`, component/token/icon mapping, screenshot evidence를 구현·검증에 사용
- Other Figma tooling: 사용자가 별도로 명시한 경우에만 보조 evidence로 사용; Figwright 기능과 혼동하지 않음
- Storybook: component API, variants, states, stories를 확인하고 기존 component를 재사용
- Playwright: user flow, responsive viewport, screenshot inspection에 사용
- Agentation / equivalent annotation tooling: 사용자가 특정 DOM element에 남긴 feedback을 correction evidence로 사용
- visual regression service: 기존 baseline이 있는 프로젝트에서 regression 확인

연결되지 않은 도구를 있다고 가정하지 않는다.

## Completion criteria

다음을 모두 만족해야 완료다.

- reference 또는 기존 design evidence에 근거한 일관된 visual direction이 존재한다.
- Figma-first 요청이면 Figwright로 작성·검증된 authoritative Figma root node와 handoff가 존재한다.
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
- Figwright/Figma status, claimed file, authoritative root node id when used
- reused design-system assets
- validation commands
- browser viewports / flows reviewed
- visual review rounds
- remaining MINOR findings
- blockers, if any

tracker, 기존 implementation plan status, PR은 변경하지 않는다.
