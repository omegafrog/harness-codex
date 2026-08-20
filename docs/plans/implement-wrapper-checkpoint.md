# Plan: implement-wrapper-checkpoint

- Issue: #482 (https://github.com/omegafrog/harness-codex/issues/482)
- Status: ready-for-agent
- Dependencies: `implement-wrapper-scheduler`
- Product Spec: `docs/specs/product-spec.md`
- Architecture Spec: `docs/specs/architecture-spec.md`

## 구현 목적

경량 컨텍스트의 서브에이전트가 장시간 구현하면서 품질을 잃지 않도록, plan 진행 상태를 보존하고 새 서브에이전트가 같은 plan을 안전하게 재개할 수 있는 checkpoint·handoff 계약을 만든다.

## 구현 범위

- `docs/plans/.runtime/<plan-id>/checkpoint.md` 고정 경로
- checkpoint schema와 orchestration state
- context threshold 및 milestone 기반 handoff 규칙
- 동일 plan slot의 새 subagent resume prompt
- checkpoint와 실제 Git/test 상태 대조 및 실제 상태 우선 복구
- checkpoint contract tests

## 비범위

- dependency/resource scheduler 자체
- conflict priority routing
- 공식 plan status 확장
- 구현 코드 직접 수정

## 테스트 계약

- 정책/계약 테스트: checkpoint path와 schema가 prompt에 포함된다.
- 정책/계약 테스트: handoff 후 동일 plan이 `in-progress`로 resume된다.
- 정책/계약 테스트: checkpoint와 Git/test 상태가 다르면 실제 상태를 우선한다.
- `ui ~ entity` E2E 계약: UI/entity runtime 부재를 환경 차단으로 기록한다.

## 완료 조건

- checkpoint 파일의 필수 필드와 handoff 사유가 정의된다.
- 새 subagent가 checkpoint 경로를 읽고 작업을 이어갈 수 있다.
- checkpoint는 `.gitignore` 대상이며 공식 plan status를 대체하지 않는다.
- 테스트와 code review에 unresolved blocker가 없다.
