# IMP-449: 실행 로그 기반 진화 루프의 평가·승격 통제

## 배경

반복된 Run Episode는 문제 발생 사실을 보여 주지만, 제안된 skill·instruction·policy가 문제를 해결한다는 증거는 아니다. 따라서 episode 패턴만으로 `replay=passed` 또는 canary 승격을 허용하면 ChangeSet 불변성 및 검증 우선 원칙을 훼손할 수 있다.

이 개선은 self-evolving agent 연구에서 공통적으로 요구하는 **경험 수집 → 후보 생성 → 별도 평가 → 제한적 적용 → 관찰 → 승격/롤백**을 harness의 ChangeSet-first 경계에 맞게 적용한다.

## 구현 계획

1. **관찰 계층 유지**
   - Run Episode와 failure fingerprint를 반복 패턴의 근거로 사용한다.
   - `environment_blocker`는 품질 개선 후보에서 계속 제외한다.

2. **후보 생성과 실행 분리**
   - `harness evolution improve`는 proposal, evaluation plan, `pending_evaluation` 상태만 생성한다.
   - 이 명령은 accepted guidance, component guidance, workflow, skill, validator, ChangeSet을 변경하지 않는다.

3. **평가 근거 강제**
   - `harness evolution replay`는 현재 후보 실행기가 없음을 명시적으로 기록하고 `blocked`를 반환한다.
   - isolated candidate materialization, deterministic evaluator command, baseline 대비 candidate 지표, reviewer approval 없이는 promotion할 수 없다.

4. **승격과 주입 분리**
   - `accepted`는 검토된 후보 상태일 뿐 runtime 적용 상태가 아니다.
   - prompt context에는 `stable` 또는 현재 runtime scope와 일치하는 `canary`만 들어갈 수 있다.
   - scope가 부족하면 canary는 주입하지 않는다. 누락된 context가 범위를 넓히는 일은 없다.
   - 현재 prompt builder는 step context만 전달하므로, work-item·ChangeSet·workflow type canary의 실제 주입은 후속 연결 작업 전까지 보수적으로 차단된다.

5. **장기 메모리 경계 유지**
   - completed ChangeSet과 completed work-item plan 근거가 있는 accepted learning만 `review_learning`으로 동기화한다.
   - active ChangeSet 및 원시 로그는 durable memory에 기록하지 않는다.

## 이번 변경의 완료 조건

- [x] `improve`가 proposal 생성 직후 자동 replay, accept, promote를 수행하지 않는다.
- [x] episode metadata만으로 replay가 `passed`가 되지 않는다.
- [x] promotion은 실제 evaluator가 기록한 `passed` 증거 없이는 차단된다.
- [x] accepted guidance는 promotion state가 없으면 prompt context에 주입되지 않는다.
- [x] scope가 부족하거나 일치하지 않는 canary는 prompt context에 주입되지 않는다.
- [x] 위 계약을 검증하는 회귀 테스트를 추가한다.

## 후속 구현

- isolated worktree에서 candidate asset을 materialize하는 evaluator adapter
- baseline/candidate 실행 명령·artifact checksum·비용·duration 비교
- prompt builder가 workflow, ChangeSet, work item type을 evolution context에 명시적으로 전달하는 연결
- promotion state를 `draft → evaluated → approved → canary → stable → rolled_back`으로 확장
- dashboard에 proposal, evaluation, scope, canary metric, rollback 이력 표시
