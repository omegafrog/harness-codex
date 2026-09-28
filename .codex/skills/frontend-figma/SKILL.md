---
name: frontend-figma
description: Use Figwright as the Figma bridge for frontend-design: build native Figma UI from a design brief/reference, ground implementation from Figma context, and compare Figma against browser output.
---

# frontend-figma

`frontend-design` workflow가 Figma를 사용할 때 따르는 Figwright 전용 adapter contract다.

이 skill은 **Figma Agent / Figma Make / official Dev Mode MCP를 전제로 하지 않는다.**
Codex가 로컬 Figwright MCP server + Figwright Figma plugin을 통해 Figma canvas를 직접 읽고 쓴다.

Figwright가 연결되지 않았으면 Figma 작업을 성공했다고 주장하지 않는다. `frontend-design`의 code-first fallback으로 돌아간다.

## Required bridge

Figwright의 실제 MCP tool catalog가 source of truth다. 연결된 client에 노출된 tool 이름/arguments를 우선한다.

최소한 다음 capability가 필요하다.

- connection health: `ping`
- file routing when multiple files are open: `list_files`, `use_file`
- Figma inventory: variables, components, styles
- native canvas write: frame/text/shape/instance/layout/style/variable operations
- grounding: `get_design_context`
- project joins: `component_map`, `token_map`, `icon_map`
- Figma render evidence: `get_screenshot`

`design_diff`는 incremental re-sync에 사용한다. 초기 one-shot 구현에서 baseline artifact를 무조건 만들지 않는다.

## Mode A — Design brief/reference → Figma

`frontend_designer`가 사용한다.

### 1. Verify connection

1. `ping`으로 Figwright plugin/server 연결을 확인한다.
2. 여러 Figma file이 열려 있다는 응답을 받으면 `list_files`를 호출한다.
3. user가 target file을 지정했다면 `use_file`로 해당 file/session을 claim한다.
4. target file이 불명확하면 임의로 선택하지 않는다.
5. 이후 handoff를 위해 file name/session identity를 기록한다.

Figma URL만으로 file을 fetch할 수 있다고 가정하지 않는다. Figwright는 plugin이 연결된 열린 file을 대상으로 작업한다.

### 2. Inventory before write

native node를 만들기 전에 현재 Figma file의 system을 읽는다.

- variables / collections: color, spacing, radius, typography
- local components and variants
- shared paint/text/effect styles
- existing layout/naming conventions

프로젝트 코드의 token/component system도 함께 조사한다.

우선순위:

1. existing Figma component / variable / style
2. existing project component / token values
3. design brief의 명시 값
4. 일관된 scale에서 새 값 생성

기존 값이 있는데 임의의 hex/px를 만들지 않는다.

### 3. Build native design

사용자 reference image/screenshot은 **visual intent**로 사용한다. screenshot 자체를 canvas에 붙여서 완료하지 않는다.

가능한 경우:

- related children은 Auto Layout
- HUG/FILL/FIXED sizing을 의미에 맞게 사용
- existing component는 instance로 재사용
- existing variables/styles를 bind
- 새 component/token은 실제로 시스템에 없는 경우만 생성
- top-level placement 외에는 absolute positioning을 최소화

Reference가 이미지라면 Codex가 hierarchy/layout/density/typography/action emphasis를 먼저 해석한 뒤 native Figma structure로 재구성한다.

### 4. Figma self-review

작성한 root frame/node를 `get_screenshot`으로 확인한다.

최소 확인:

- clipping / overflow
- alignment
- spacing rhythm
- typography hierarchy
- primary action emphasis
- reference image/design brief와의 방향 일치

문제가 있으면 Figma를 수정하고 screenshot을 다시 확인한다.

### 5. Produce Figma handoff

implementation agent에 다음을 전달한다.

- Figwright 사용 여부
- claimed Figma file name/session identity
- authoritative root frame/node id
- design brief
- reused Figma components/variables/styles
- newly created design-system assets, if any
- Figma screenshot evidence
- unresolved Figma/design-system gaps

root node id가 없으면 "Figma source of truth"로 handoff하지 않는다.

## Mode B — Figma → implementation grounding

`frontend_implementation_agent`가 사용한다.

Authoritative root node를 기준으로:

1. `get_design_context`를 full detail + component dedupe 방식으로 읽는다.
2. `component_map`으로 Figma component ↔ project component 후보를 확인한다.
3. `token_map`으로 Figma variable/style ↔ project token을 확인한다.
4. icon이 있으면 `icon_map`을 먼저 사용한다.
5. image asset이 실제로 필요하면 Figwright가 제공하는 original asset export capability를 사용한다.
6. project framework/styling convention에 맞게 구현한다.

Rules:

- screenshot을 보고 px/hex를 추측하지 않는다. 구조/값은 design context가 우선한다.
- high-confidence component mapping은 재사용한다.
- ambiguous mapping은 실제 code context를 확인한 후 선택한다.
- mapped token은 raw value 대신 project reference를 사용한다.
- unmapped gap은 숨기지 말고 보고한다.
- Figma artboard width를 root fixed width로 그대로 옮기지 않는다. responsive behavior는 project와 다른-width evidence를 기준으로 설계한다.

## Mode C — Browser ↔ Figma review

`frontend_visual_reviewer`가 사용한다.

1. authoritative Figma root node의 screenshot을 가져온다.
2. 같은 user flow/state/viewport의 browser screenshot을 캡처한다.
3. 다음을 직접 비교한다.
   - overall hierarchy
   - major layout ratios
   - spacing rhythm
   - typography roles
   - component treatment
   - action emphasis
   - important states
4. DOM/accessibility tree만으로 fidelity pass를 선언하지 않는다.
5. finding에는 browser evidence와 Figma evidence를 함께 적는다.

pixel-perfect duplication 자체가 목표는 아니다. responsive/runtime constraints 때문에 달라져야 하는 부분과 실제 fidelity regression을 구분한다.

## Incremental re-sync

기존 구현이 있고 Figma가 변경된 후 다시 sync하는 요청이면 `design_diff`를 우선 고려한다.

- 기존 baseline이 프로젝트에 이미 존재하면 delta를 읽고 affected code만 수정한다.
- baseline을 새로 만들면 repository policy에 맞는지 확인한다.
- 사용자가 요청하지 않았고 project가 `.figwright/snapshots/`를 관리하지 않는다면 tracked artifact를 자동 추가하지 않는다.
- Figma mapping 문서(`docs/figma-component-map.md`, `docs/figma-token-map.md`)는 실제 render로 검증한 mapping만 기록한다.

## Failure / fallback

다음 상황에서는 Figwright path를 중단하고 명시적으로 보고한다.

- `ping` 실패
- plugin이 target Figma file에 연결되지 않음
- 여러 file 중 target을 결정할 근거가 없음
- required read/write capability가 client에 노출되지 않음
- Figma write가 실패했는데 결과를 검증할 수 없음

사용자가 Figma-first를 명시적으로 요구했다면 임의로 code-first 구현을 계속하지 않는다.
Figma가 optional인 일반 `frontend-design` 요청이면 design brief를 유지한 채 code-first fallback으로 진행할 수 있다.

## Boundary

- Figma Agent / Figma Make를 호출하지 않는다.
- official Figma MCP 기능이나 seat 조건을 Figwright 기능으로 오인하지 않는다.
- application source 수정은 `frontend_implementation_agent`가 담당한다.
- Figma write는 design 단계에서만 수행한다.
- visual reviewer는 Figma와 application source를 수정하지 않는다.
