# Plan: implement-wrapper-scheduler

- Issue: #481 (https://github.com/omegafrog/harness-codex/issues/481)
- Status: ready-for-agent
- Dependencies: none
- Product Spec: `docs/specs/product-spec.md`
- Architecture Spec: `docs/specs/architecture-spec.md`

## 구현 목적

메인 세션이 승인된 plan을 안전하게 서브에이전트에게 위임할 수 있도록 `implement-wrapper`의 기본 실행 경계를 만든다. plan 의존성과 공유 자원을 기준으로 실행 가능성을 판단하고, 하나의 plan에는 동시에 하나의 서브에이전트만 배정하며, 독립 plan은 병렬 실행할 수 있게 한다.

## 구현 범위

- 공개 skill `.codex/skills/implement-wrapper/SKILL.md`
- 필요한 경우 내부 skill `.codex/internal-skills/implement-wrapper/SKILL.md`
- plan index와 개별 plan의 dependency/resource를 읽는 규칙
- plan별 단일 execution slot 규칙
- 독립 plan 병렬 spawn/wait 규칙
- `.codex/skills/implement/SKILL.md`로 위임하는 prompt contract
- scheduler 및 slot contract tests

## 비범위

- checkpoint handoff/resume
- conflict priority routing
- 구현 코드 직접 수정
- GitHub Issue 생성·label 동기화

## 테스트 계약

- 정책/계약 테스트: dependency-free plan만 `ready-for-agent` 후보가 되고, dependency plan은 대기한다.
- 정책/계약 테스트: 하나의 plan에 동시에 두 subagent를 spawn하지 않는다.
- 정책/계약 테스트: 독립 plan은 병렬 실행 후보가 된다.
- `ui ~ entity` E2E 계약: 현재 저장소에는 UI/entity runtime이 없으므로 실행 불가 사실과 환경 차단 조건을 plan 결과에 기록한다.

## 완료 조건

- 지정 plan에 대해 `implement` subagent를 정확히 하나 실행할 수 있다.
- dependency/resource 판단이 불확실하면 순차 실행한다.
- prompt에 plan 경로, spec 경로, `implement` skill 경로가 포함된다.
- `python3 -m unittest discover -s tests -v`와 plan-specific contract tests가 통과한다.
- code review에서 unresolved blocker가 없다.
