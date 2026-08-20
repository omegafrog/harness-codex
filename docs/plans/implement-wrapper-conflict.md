# Plan: implement-wrapper-conflict

- Issue: #483 (https://github.com/omegafrog/harness-codex/issues/483)
- Status: planned
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
