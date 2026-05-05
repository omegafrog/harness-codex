# Harness Document Structure

## 1. 목적

이 문서는 ChangeSet과 유스케이스 slice 기반 실행 구조를 정의한다.
목표는 구현 요청마다 변경 의도와 영향을 명시하고, planner/executor가 전체
`docs/design/**`를 매번 다시 분석하지 않고 승인된 유스케이스 범위만 읽도록
입력 경계를 고정하는 것이다.

## 2. 표준 구조

```text
docs/
  changes/
    active/
      CHG-YYYYMMDD-NNN.md
    completed/
      CHG-YYYYMMDD-NNN.md

  use-cases/
    UC-001/
      index.md
      use-case.md
      event-storming.md
      ddd-design.md
      technical-decisions.md
      e2e-goal.md
      affected-files.md

  maintenance/
    MAINT-001/
      change-intent.md
      affected-files.md
      technical-decisions.md
      verification-goal.md

  plans/
    active/
      UC-001/
        plan.md
        verification.md
    completed/
      UC-001/
        plan.md
        verification.md

  templates/
    changes/
      change-set.md
    use-cases/
      index.md
      use-case.md
      event-storming.md
      ddd-design.md
      technical-decisions.md
      e2e-goal.md
      affected-files.md
```

`docs/templates/**`는 새 문서를 만들 때 복사해서 사용하는 기준이다.
`docs/changes/active`, `docs/changes/completed`, `docs/plans/active`,
`docs/plans/completed`는 실제 실행 상태를 표현한다.

## 3. ChangeSet 규칙

ChangeSet은 하나의 구현 요청 또는 문서 변경 요청을 나타낸다.
각 ChangeSet은 다음 내용을 반드시 포함한다.

- 변경 전 의도와 변경 후 의도 (`Before` / `After`)
- 변경되는 문서 목록
- 영향받는 유스케이스 목록
- 유스케이스별 E2E 목표 변경 여부
- planner/executor가 읽을 입력 범위
- 명시적으로 제외되는 범위

새 변경은 `docs/changes/active/<CHG-ID>.md`에 생성한다.
모든 영향 유스케이스의 plan이 완료되고 검증이 통과하면 같은 파일을
`docs/changes/completed/<CHG-ID>.md`로 이동한다.

## 4. 유스케이스 Slice 규칙

`docs/use-cases/<UC-ID>/`는 특정 유스케이스를 구현 가능한 단위로 좁힌
executor-facing 문서 집합이다.

- `index.md`: slice 문서의 상태, 승인 여부, 추적 링크
- `use-case.md`: 액터 목표, 사전조건, 기본/예외 흐름, 결과
- `event-storming.md`: 해당 UC에 필요한 command/event/policy/system slice
- `ddd-design.md`: 해당 UC 구현에 필요한 도메인/aggregate/service/BC 결정
- `technical-decisions.md`: 해당 UC 구현에 필요한 세부 기술 결정
- `docs/use-cases/<UC-ID>/e2e-goal.md`: Given/When/Then 완료 기준과 검증 명령
- `docs/use-cases/<UC-ID>/affected-files.md`: 예상 변경 파일과 금지 파일

유스케이스 slice가 존재하면 planner와 executor는 우선 이 디렉터리의 문서를
입력으로 사용한다. 공통 설계가 필요할 때만 `docs/design/**`를 보조 입력으로
참조한다.

## 5. Canonical Design 관계

`docs/design/**`는 전체 제품/도메인 수준의 canonical 문서다.
`docs/use-cases/<UC-ID>/**`는 특정 유스케이스 실행을 위한 slice 문서다.

- canonical 문서가 전체 진실의 원천이다.
- UC slice는 canonical 문서에서 해당 UC에 필요한 부분과 ChangeSet의 delta를
  실행 가능한 형태로 좁힌다.
- slice와 canonical 문서가 충돌하면 executor loop에서 임의로 해결하지 않는다.
  `DOCUMENT_DELTA_CONFLICT` 또는 `UPSTREAM_DESIGN_CONFLICT`로 분류하고 상위
  문서 수정 단계로 되돌린다.
- 전체 `docs/design/이벤트 스토밍.md`는 summary/index로 유지할 수 있지만,
  UC 구현 계획의 직접 입력은 `docs/use-cases/<UC-ID>/event-storming.md`다.

## 6. Maintenance 작업 규칙

리팩토링, 버그 수정, 테스트 보강, 인프라 변경처럼 유스케이스 slice가 아닌
작업은 `maintenance` work item으로 실행한다.

- ChangeSet에는 `use_case`와 `maintenance` work item을 함께 기록할 수 있다.
- maintenance 입력은 `docs/maintenance/<MAINT-ID>/change-intent.md`,
  `affected-files.md`, `verification-goal.md`를 필수로 사용한다.
- `technical-decisions.md`는 필요할 때만 둔다.
- plan 경로는 유스케이스와 동일하게 `docs/plans/active/<MAINT-ID>/plan.md`를
  사용하고, 완료 시 `docs/plans/completed/<MAINT-ID>/plan.md`로 이동한다.
- 검증 실패는 `implementation failure`, `scope conflict`,
  `environment blocker`, `verification goal unclear`로 분류한다.

## 7. Plan 이동 규칙

유스케이스별 plan은 `docs/plans/active/<UC-ID>/plan.md`에 생성한다.
maintenance plan은 `docs/plans/active/<MAINT-ID>/plan.md`에 생성한다.
검증 증거는 같은 디렉터리의 `verification.md`에 기록할 수 있다.

다음 조건을 모두 만족할 때만 plan을 completed로 이동한다.

- `plan.md`의 모든 체크박스가 완료됨
- `docs/use-cases/<UC-ID>/e2e-goal.md`의 성공 기준 충족
- repository test gate의 required stage가 모두 PASS
- 검증 결과가 `plan.md` 또는 `verification.md`에 기록됨

완료된 plan은 `docs/plans/completed/<UC-ID>/plan.md`로 이동한다.
미완료, 실패, 차단 상태의 plan은 active에 남긴다.

## 8. 런타임 CLI

로컬 런타임은 ChangeSet 아래 work item을 조회하고 실행 상태를
`.harness/runs/<run-id>/`에 저장한다.

```bash
harness changes list
harness changes show <CHG-ID>
harness run-change <CHG-ID> --plan|--preview|--apply
harness run-use-case <CHG-ID> <UC-ID> --plan|--preview|--apply
harness run-work-item <CHG-ID> <WORK-ITEM-ID> --plan|--preview|--apply
harness stages list <CHG-ID>
harness artifacts show <CHG-ID> <stage>
harness artifacts accept <CHG-ID> <stage>
harness run-stage <CHG-ID> <stage> --plan|--preview|--apply
harness resume <run-id>
harness report <run-id>
harness dashboard
```

`--plan`과 `--preview`는 파일 변경이나 외부 명령 실행 없이 범위와 실행 순서만
보여준다. `--apply`는 `.harness/workflows/changeset-use-case-workflow.yaml`을
로드해 runner 경계까지 진입하고 state/report/dashboard projection을 남긴다.
