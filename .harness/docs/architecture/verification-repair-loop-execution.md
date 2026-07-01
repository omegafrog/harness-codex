# Verification Repair Loop 실행 시나리오

이 문서는 Work Item 내부의 `execute → verify → repair → execute → verify` 흐름을 실제 런타임 엔진에서 확인한 시나리오를 설명합니다.

## 실행 목적

검증 실패가 `implementation_failure`로 분류되었을 때, 런타임이 작업을 멈추는 대신 같은 Work Item을 수정 구현 단계로 되돌리는지 확인합니다.

## 준비 상태

임시 Work Item `UC-001`에 다음 상태를 만들었습니다.

- active plan 존재
- verification report에 `implementation_failure` 기록
- 실패한 gate: `focused-token-test`
- 실패 명령: `test -f .harness/repaired`
- 미충족 의무: `token validation must pass`

## 실제 실행 순서

```text
1. execute-work-item
   - 첫 구현 시도는 `.harness/retry-started`만 생성한다.

2. verify-work-item
   - `.harness/repaired`가 없어서 실패한다.

3. remediate-work-item
   - active plan에 Runtime Remediation을 추가한다.
   - repair-brief.json을 작성한다.

4. execute-work-item
   - 재시도에서는 `.harness/repaired`를 생성한다.

5. verify-work-item
   - 검증이 통과한다.
```

## 확인한 산출물

- `.harness/runs/run-repair-e2e/work-items/UC-001/verification/repair-brief.json`
  - failure fingerprint
  - failed gates
  - failed commands
  - unmet obligations
  - re-verification order
- `docs/plans/active/UC-001/plan.md`
  - `## Runtime Remediation`
  - repair brief 경로
  - 재검증 순서

## 실행 결과

- Run status: `SUCCEEDED`
- Retry count: `1`
- 첫 검증 실패 후 수정 구현과 재검증이 수행됨
- 전체 runtime·workflow regression CI 통과
