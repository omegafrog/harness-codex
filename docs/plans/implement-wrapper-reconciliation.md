# Plan: implement-wrapper-reconciliation

- Issue: #484 (https://github.com/omegafrog/harness-codex/issues/484)
- Status: planned
- Dependencies: `implement-wrapper-scheduler`, `implement-wrapper-checkpoint`, `implement-wrapper-conflict`
- Product Spec: `docs/specs/product-spec.md`
- Architecture Spec: `docs/specs/architecture-spec.md`

## 구현 목적

wrapper가 `implement`의 구현·검증 책임을 침범하지 않으면서, 완료·차단 결과를 정확히 전달하고 dependent plan과 GitHub `ready-for-agent` label이 기존 plan-status 규칙과 일치하도록 연결한다.

## 구현 범위

- wrapper-to-`implement` completion/report contract
- review가 끝나지 않으면 완료하지 않는 gate 위임
- 공식 plan status 보호
- completed plan 이후 dependent plan 재평가
- `ready-for-agent` label과 plan status 정합성 확인
- reconciliation/status contract tests

## 비범위

- 구현 코드 직접 수정
- 자동 merge 또는 priority 결정
- 새로운 공식 plan status
- GitHub Issue tracker 규칙 자체 변경

## 테스트 계약

- 정책/계약 테스트: unresolved review/blocker가 있으면 plan을 `completed`로 처리하지 않는다.
- 정책/계약 테스트: 완료 후 dependency-free plan만 `ready-for-agent`가 된다.
- 정책/계약 테스트: wrapper는 구현 코드와 plan 완료 상태를 직접 수정하지 않는다.
- `ui ~ entity` E2E 계약: UI/entity runtime 부재를 환경 차단으로 기록한다.

## 완료 조건

- subagent 결과가 기존 `implement` completion contract를 따른다.
- dependent plan status와 `ready-for-agent` label 정합성 검증이 가능하다.
- 전체 plan graph에서 최소 하나의 실행 가능 plan이 정확히 보고된다.
- 테스트와 code review에 unresolved blocker가 없다.
