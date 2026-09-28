---
name: frontend-visual-review
description: Run the implemented frontend in a real browser and review visual hierarchy, responsive behavior, interaction states, and usability without editing source code.
---

# frontend-visual-review

`frontend-design` workflow의 독립적인 browser-based visual/UX review를 담당한다.

source code를 수정하지 않는다.

## Inputs

- absolute `workspace_root`
- settled frontend design brief
- optional Figwright handoff: file/session identity and authoritative root node id
- exact route(s) and user flow
- acceptance scenarios
- `docs/agents/EXEC.md` and project execution instructions

## Execution

1. `workspace_root`와 `git rev-parse --show-toplevel` 일치를 확인한다.
2. `docs/agents/EXEC.md`와 대상 frontend의 실행 지침을 읽는다.
3. 기존 project command로 필요한 app/server를 시작한다. 실행 방법을 추측해 repository 설정을 바꾸지 않는다.
4. 실제 browser automation/screenshot capability를 사용한다. Playwright가 project 또는 environment에 준비되어 있으면 우선 사용한다.
5. design brief의 primary user flow를 실제로 수행한다.
6. target viewport가 지정되어 있지 않으면 최소 다음 범주를 확인한다.
   - desktop: 약 1440px width
   - compact desktop/laptop: 약 1280px width
   - narrow mobile: 약 390px width
7. Figwright handoff가 있으면 `.codex/skills/frontend-figma/SKILL.md`의 Mode C를 적용해 authoritative Figma root node의 `get_screenshot` 결과와 같은 state/viewport의 browser screenshot을 비교한다.
8. 각 핵심 화면과 중요한 interaction state에서 실제 render를 시각적으로 검사한다.
9. 종료 시 이 run이 시작한 process와 임시 artifact를 정리하고 git status를 확인한다.

DOM snapshot이나 accessibility tree만 보고 visual pass를 선언하지 않는다.

## Review dimensions

### Visual hierarchy
- 사용자가 첫 2~3초 안에 primary task와 current state를 파악할 수 있는가
- primary action이 secondary/destructive action보다 명확한가
- 모든 section이 동일한 visual weight를 가져 hierarchy가 죽지 않았는가

### Layout and density
- information density가 task 성격과 맞는가
- unnecessary card nesting이 없는가
- alignment, rhythm, whitespace가 일관적인가
- sidebar/header/content 비율이 자연스러운가

### Typography
- heading/body/metadata 역할이 구분되는가
- line length와 wrapping이 읽기 좋은가
- font size 차이만으로 모든 hierarchy를 해결하지 않았는가

### Components and surfaces
- 같은 역할의 control이 같은 모습과 behavior를 가지는가
- borders, radius, shadow, surface contrast가 일관적인가
- decorative styling이 information hierarchy를 방해하지 않는가

### Interaction
- hover/focus/pressed/disabled 상태가 구분되는가
- keyboard navigation과 focus visibility가 합리적인가
- destructive action이 실수하기 쉬운 위치/강조로 배치되지 않았는가
- interaction 후 system status가 보이는가

### States
적용 가능한 loading, empty, error, disabled state를 실제로 확인한다.

### Responsive
- horizontal overflow / clipped content / overlapping control이 없는가
- 좁은 화면에서 단순 축소가 아니라 priority에 맞게 재배치되는가
- touch target이 지나치게 작지 않은가

### Reference fidelity
- dominant reference에서 추출한 원칙을 따르는가
- 여러 reference의 표면 스타일이 뒤섞여 일관성이 깨지지 않았는가
- Figwright handoff가 있으면 browser hierarchy/layout ratio/spacing/type/component treatment/action emphasis가 authoritative Figma screenshot과 합리적으로 일치하는가
- responsive/runtime constraint 때문에 의도적으로 달라진 부분과 fidelity regression을 구분했는가

## Findings

각 finding은 다음 형태로 보고한다.

- Severity: BLOCKER | MAJOR | MINOR
- Route / viewport
- Element or component
- Observed problem
- Why it hurts usability or visual quality
- Concrete correction direction
- Evidence: browser screenshot/state description
- Figma evidence: authoritative node/screenshot when Figwright is used

### Severity

- BLOCKER: 주요 flow를 사용할 수 없거나 content/action이 가려짐, 심각한 responsive/accessibility failure
- MAJOR: flow는 되지만 hierarchy, interaction, layout, readability가 명확히 품질 기준에 미달
- MINOR: polish 수준의 일관성/spacing/visual refinement

취향만 다른 문제를 BLOCKER/MAJOR로 올리지 않는다. design brief와 user goal을 기준으로 판단한다.

## Completion output

- executed commands
- routes / flows exercised
- viewports inspected
- state coverage
- Figma root node / comparison evidence when Figwright is used
- findings grouped by severity
- artifact cleanup result
- PASS only when BLOCKER and MAJOR are zero

reviewer는 source, tests, specs, plans, tracker, configuration을 수정하지 않는다.
