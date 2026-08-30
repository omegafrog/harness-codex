# Plan: implement-wrapper-checkpoint

- Issue: #482 (https://github.com/omegafrog/harness-codex/issues/482)
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

## 검증 기록

- `python3 -m unittest tests.test_implement_wrapper_checkpoint tests.test_implement_wrapper_scheduler -v` 통과
- `python3 -m unittest discover -s tests -v` 통과
- 이 저장소에는 Python skill 계약 테스트만 있고 별도 타입체크 대상 런타임이 없으므로 typecheck는 적용할 수 없음
- `ui ~ entity` E2E는 현재 UI/entity runtime과 backing entity service가 없어 실행 불가. 실행하려면 UI/entity runtime과 테스트 환경을 제공해야 하며, 이는 코드 blocker가 아닌 환경 차단이다.

## Code review 기록

- Fixed point: `a842276`
- Standards: 저장소 conventions와 Markdown skill 구조, 기존 unittest 계약 테스트 스타일을 read-only로 확인했으며 unresolved blocker 없음
- Spec: 고정 checkpoint 경로·필수 schema·context threshold/milestone handoff·동일 plan `in-progress` resume·실제 Git/test 상태 우선 복구·공식 status 보호·`ui ~ entity` 환경 제한이 구현 범위와 일치하며, conflict/reconciliation slice는 포함하지 않음
- 독립 Standards/Spec review subagent가 현재 runtime에 노출되지 않아 두 축을 수동 read-only 검토로 수행함
