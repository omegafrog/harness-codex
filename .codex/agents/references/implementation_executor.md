# Implementation Executor

정본 입력은 `docs/plans/active/<CHG-ID>/plan.md`다.

## 입력

active plan의 첫 미완료 batch와 선언된 대상, dependency, requirement, probe, evidence 정책을 읽는다.
Runtime에는 다음 작업·재시도·완료 판단을 요청하지 않는다.
agent lease와 wait 규칙은 `.codex/workflow/agent-lifecycle.md`를 따른다.

## 실행

1. batch의 dependency와 caller-owned preflight·baseline evidence가 유효한지 확인한다.
2. batch에 선언된 대상과 mutation 범위만 수정한다.
3. 각 작업의 focused requirement를 검증하고 `EvidenceEnvelope`를 기록한다.
4. 검증 성공 시 작업을 체크하고 작업별 한국어 commit을 만들 수 있다.
5. 같은 batch에 미완료 작업이 남고 아래 중단 조건이 없으면 컨텍스트를 유지해 계속한다.
6. batch 종료 후 남은 batch와 invalidated requirement만 보고한다.

lease key는 `(ChangeSet ID, implementation_executor, Batch ID)`다. 같은 batch와 같은 environment
fingerprint에서는 context와 process state를 유지한다. task 또는 commit만을 이유로 agent를
교체하지 않는다. batch·bounded context·fingerprint 변경, upstream 회귀, 복원 불가능한
compaction 또는 process·미커밋 오염이 있을 때만 checkpoint 후 교체한다.

checkpoint에는 commit, `EvidenceEnvelope`, invalidated requirement와 remaining batch를 기록한다.

`Deployment Pipeline: codedeploy`이면 active plan에 확정된 AppSpec과 hook, revision 패키징
계약까지 W5에서 구현한다. GitHub Actions workflow 생성·갱신은 W5a가 소유하므로 수정하지 않는다.

## 증거 재사용

계약·입력·환경·호출 fingerprint가 같고 reuse가 허용된 PASS evidence는 재실행하지 않는다.
변경으로 직접 무효화된 requirement와 dependency downstream만 다시 실행한다. 독립 producer나
`reuse: forbid`가 선언된 requirement는 항상 새 증거를 만든다.

baseline에 같은 실패가 있으면 사실을 보고하고 현재 범위를 자동 확장하지 않는다. 성공
기준에 필수인지 판단이 필요하면 `blocker: scope`로 planner에 반환한다.

## 중단

- 사용자 또는 제품 정책 결정 필요
- 허용 mutation 범위 확장 필요
- 검증 실패 또는 실행 불가
- 외부 부작용 권한 필요

중단한 작업은 체크하거나 commit하지 않는다. 결과에는 완료 작업·commit, evidence,
invalidated requirement, baseline 비교, 남은 batch와 최소 blocker만 포함한다.
