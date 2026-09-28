---
name: frontend-implement
description: Implement one settled frontend design brief using the repository's existing design system, component primitives, and verification commands.
---

# frontend-implement

`frontend-design` workflow의 코드 작성과 correction만 담당한다.

## Inputs

- absolute `workspace_root`
- settled frontend design brief
- target routes/screens
- relevant source/component paths
- acceptance scenarios
- visual-review findings when this is a correction round

## Rules

1. `workspace_root`를 모든 명령의 cwd로 사용하고 repository root 일치를 확인한다.
2. design brief를 임의로 다시 설계하지 않는다. 방향 변경이 필요하면 blocker로 돌려보낸다.
3. 기존 token, primitive, shared component, layout pattern을 먼저 찾고 재사용한다.
4. 디자인 시스템이 있는데 page-local raw color, arbitrary spacing, inline style로 우회하지 않는다.
5. 새 component는 화면 전용 markup보다 재사용 가치가 있을 때만 shared layer로 올린다.
6. accessibility primitive가 이미 있으면 dialog/menu/popover/focus management를 직접 재구현하지 않는다.
7. responsive behavior를 구현한다. desktop-only CSS로 완료 처리하지 않는다.
8. 적용 가능한 loading, empty, error, disabled, focus-visible state를 구현한다.
9. animation은 state transition, spatial continuity, user feedback에 필요한 경우만 사용한다.
10. unrelated backend, workflow, tracker, spec, plan 파일을 수정하지 않는다.

## Implementation sequence

1. 현재 route/component tree와 shared UI를 확인한다.
2. design brief의 hierarchy를 semantic layout으로 옮긴다.
3. 가장 큰 structural layout부터 구현한다.
4. 기존 components와 variants를 연결한다.
5. interaction과 상태를 구현한다.
6. responsive layout을 구현한다.
7. typography, spacing, borders, surfaces를 tokens에 맞춰 조정한다.
8. project에 설정된 lint/typecheck/test를 실행한다.
9. project에 design-system lint가 설정돼 있으면 실행한다.
10. 수정 파일과 검증 결과를 보고한다.

## Correction round

visual reviewer finding을 받을 때는 finding별로 다음을 연결한다.

- visible symptom
- affected element/component
- root styling/layout cause
- minimal correction
- regression risk

screenshot에 보이는 증상을 숨기기 위한 viewport-specific magic number를 남발하지 않는다.

## Completion output

- files changed
- components/tokens reused
- new shared components, if any
- validation commands and results
- assumptions
- unresolved design blockers

이 skill은 commit, tracker update, PR 생성, visual acceptance 판정을 하지 않는다.
