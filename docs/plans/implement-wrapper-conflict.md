# Plan: implement-wrapper-conflict

- Issue: #483 (https://github.com/omegafrog/harness-codex/issues/483)
- Status: completed
- Dependencies: `implement-wrapper-scheduler`, `implement-wrapper-checkpoint`
- Product Spec: `docs/specs/product-spec.md`
- Architecture Spec: `docs/specs/architecture-spec.md`

## 구현 목적

병렬 plan 사이에 예상하지 못한 파일·Git 충돌이 발생했을 때 자동 병합으로 범위를 훼손하지 않고, 관련 실행을 중지한 뒤 메인 세션이 우선순위를 결정해 안전하게 재개하도록 한다.

## 구현 범위

- conflict detection/reporting contract
- 관련 plan execution slot 중단 규칙
- checkpoint의 `conflict-paused` 및 `priority-routed` orchestration state
- 메인 세션 priority decision 대기와 선택 plan 우선 재실행
- blocker 종류와 정확한 unblock condition 보고
- conflict/blocker contract tests

## 비범위

- 자동 merge
- 자동 priority 결정
- dependency/resource scheduler 자체
- 외부 권한·서비스·시드 데이터 제공

## 테스트 계약

- 정책/계약 테스트: conflict 발생 시 관련 plan이 중단되고 자동 merge하지 않는다.
- 정책/계약 테스트: main session의 priority decision 전에는 충돌 plan을 재개하지 않는다.
- 정책/계약 테스트: blocker 해결은 subagent가 담당하고 외부 차단만 `blocked`로 보고한다.
- `ui ~ entity` E2E 계약: UI/entity runtime 부재를 환경 차단으로 기록한다.

## 완료 조건

- 충돌 증거와 중단된 plan이 checkpoint에 기록된다.
- 메인 세션이 선택한 plan만 먼저 재개된다.
- 공식 plan status는 기존 다섯 상태만 사용한다.
- 테스트와 code review에 unresolved blocker가 없다.

## 검증 기록

- `python3 -m unittest tests.test_implement_wrapper_conflict -v` 통과
- `python3 -m unittest discover -s tests -v` 통과 (16 tests)
- `git diff --check` 통과
- 이 저장소에는 Python skill 계약 테스트만 있고 별도 타입체크 대상 런타임이 없으므로 typecheck는 적용할 수 없음
- `ui ~ entity` E2E는 UI/entity runtime과 backing entity service가 없어 실행 불가. 실행하려면 UI/entity runtime과 테스트 환경을 제공해야 하며, 이는 코드 blocker가 아닌 환경 차단이다.

## Code review 기록

- Fixed point: `origin/codex/implement-wrapper-plans` (`21b2485bd3a124b4e14d474645c5b1b7d6bb25ed`)
- Standards: 기존 Markdown skill 구조, checkpoint 상태 계약, 공식 plan status 규칙, unittest 계약 테스트 스타일을 read-only로 확인했으며 unresolved blocker 없음
- Spec: conflict evidence 기록, 관련 slot 중단, 자동 merge/priority 금지, main-session priority gate, 선택 plan 선행 재개, blocker unblock condition 보고, 기존 다섯 공식 상태 유지가 본 plan 범위와 일치하며 reconciliation 구현은 포함하지 않음
- 독립 Standards/Spec review subagent가 현재 runtime에 노출되지 않아 두 축을 수동 read-only 검토로 수행함
