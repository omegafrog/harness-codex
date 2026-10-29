<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

내부 절차를 호출할 때 공개 스킬 검색 대신 해당 GUIDE를 읽는다: [frontend-figma](../frontend-figma/GUIDE.md).

# frontend-implement

## 실행 모델과 반환

기본 `model_tier`는 `implementation`이며 `agents.implementation_model`와 `agents.implementation_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [공통 skill 실행 계약](../skill-execution/GUIDE.md)에 따라 caller가 실제 model·effort를 resolve하여 subagent spawn에 전달한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

`frontend-design` workflow의 코드 작성과 correction만 담당한다.

## Inputs

- absolute `workspace_root`
- settled frontend design brief
- optional Figwright handoff: file/session identity, authoritative root node id, Figma screenshot evidence, mapping/design-system gaps
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
8. 적용 가능한 loading, empty, error, disabled, focus-visible, pending, success, retry, validation state와 오류 복구 경로를 구현한다. 비동기 작업은 중복 제출을 막고 결과를 전달한다.
9. animation은 state transition, spatial continuity, user feedback에 필요한 경우만 사용하고 `prefers-reduced-motion`을 존중한다.
10. Figwright handoff가 있으면 `.codex/internal-skills/frontend-figma/GUIDE.md`의 Mode B를 먼저 적용해 Figma 구조와 mapping을 grounding한다.
11. Figma screenshot을 보고 spacing/color를 추측하지 않는다. `get_design_context`, `component_map`, `token_map`, `icon_map` evidence를 우선한다.
12. Figma-first flow에서는 application code만 수정하고 Figma canvas를 다시 설계하지 않는다.
13. unrelated backend, workflow, tracker, spec, plan 파일을 수정하지 않는다.
14. `frontend-design`의 **UI Copy Restraint**를 따른다. UI가 이미 보여주는 상태·규칙을 설명 문장으로 반복하지 말고, 요청되지 않은 helper text, subtitle, description, hint를 추가하지 않는다.
15. UX 모호성을 설명 문구로 덮지 않는다. interaction이나 visual hierarchy를 고쳐서 해결한다: “Do not solve UX ambiguity by adding explanatory copy. Fix the interaction or visual hierarchy instead.”
16. 게임 HUD와 일반 component의 기본 설명 문장 예산은 0개다. 상태는 시각 요소, 숫자, 아이콘, 짧은 label로 표현한다. 접근성 이름과 필수 오류·안전 정보는 유지한다.
17. 접근성 기대사항을 markup/interaction에 반영한다: semantic controls와 이름, 연결된 field label, 키보드 조작, 눈에 보이는 focus, 상태를 색상만으로 전달하지 않기, 확대/reflow, dialog 종료 후 focus 복구. 아이콘 전용 control은 accessible name을 제공한다.
18. 필수 안내와 입력 요건을 tooltip/hover에만 두지 않는다. tooltip은 보충 정보에 한해 keyboard-accessible하게 구현한다.
19. 테스트는 화면이나 component 수대로 만들지 않는다. design brief의 acceptance scenario 및 이 UI가 소유한 사용자 관찰 가능 동작과 상태를 검증한다. 공통 인증·입력 validation을 다른 module이 소유하면 그 구현을 중복 검증하지 말고, 이 UI가 그 결과를 올바르게 표시·처리하는 계약만 확인한다.

## Implementation sequence

1. 현재 route/component tree와 shared UI를 확인한다.
2. Figwright handoff가 있으면 target file/root node를 확인하고 design context + component/token/icon mapping을 수집한다.
3. design brief의 hierarchy를 semantic layout으로 옮긴다.
4. 가장 큰 structural layout부터 구현한다.
5. 기존 components와 variants를 연결한다.
6. interaction과 상태를 구현한다.
7. responsive layout을 구현한다.
8. typography, spacing, borders, surfaces를 tokens에 맞춰 조정한다.
9. project에 설정된 lint/typecheck/test를 실행한다.
10. project에 design-system lint가 설정돼 있으면 실행한다.
11. 수정 파일과 검증 결과를 보고한다.

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
- Figwright mappings used / unresolved mapping gaps when applicable
- authoritative Figma root node id when applicable
- new shared components, if any
- validation commands and results
- assumptions
- unresolved design blockers

이 skill은 commit, tracker update, PR 생성, visual acceptance 판정을 하지 않는다.

## 테스트·서비스 실행 전제

일반 단위·회귀 검증은 프로젝트 `docs/agents/EXEC.md`의 명령을 해당 언어의 기본 CLI로 실행한다. `harness-exec`와 `execution.json`은 명시적 사용자 흐름 E2E에만 사용하며, 그 외 profile을 만들거나 runner로 감싸지 않는다. 실제 E2E에서는 실행 인자·필수 환경·설정 검사와 dependency readiness를 확인하고 receipt를 보고한다.
