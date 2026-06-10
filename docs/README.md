# Harness Document Structure

## 0. Quick install for a new repository

새 빈 프로젝트에서는 GitHub의 installer를 내려받아 런타임 파일과 최소 문서 구조를 한 번에 초기화할 수 있다.

```bash
curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash
```

기본 동작:

- `harness_codex/`, `.harness/`, `.codex/`, `tests/runtime`를 현재 프로젝트에 설치한다.
- `venv`를 만들고 `pip`, `pytest`, `pyyaml`을 설치한다.
- 프로젝트 루트에 짧은 실행 래퍼 `./harness`를 생성한다.
- `ARCHITECTURE.md`, `docs/design/요구사항.md`, `docs/design/유스케이스.md`, `.codex/repository-settings.md`, `.codex/test-gate.yaml`가 없으면 생성한다.
- `./harness --help` smoke test를 실행한다.

기존 파일은 기본적으로 덮어쓰지 않는다. 다시 설치하며 덮어쓰려면 다음처럼 실행한다.

```bash
curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash -s -- --force
```

특정 ref나 대상 디렉터리를 지정할 수도 있다.

```bash
curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/scripts/install-harness-codex.sh | bash -s -- --ref main --target /path/to/project
```

After installation, start with repository context and the first runtime stage.

```bash
./harness init \
  --description "New project managed by harness-codex runtime"

./harness requirements-definition CHG-YYYYMMDD-001 \
  --title "initial runtime setup" \
  --idea "initial runtime setup" \
  --plan
```

## 1. Agent Context Bootstrap

New repositories that use this harness should bootstrap repo-local agent context before
running the staged ChangeSet workflow.

```bash
./harness init --description "<repo description>"
```

The bootstrap creates a short `AGENTS.md` and cold-path context files under
`docs/agent/`. If an existing root `AGENTS.md` is not harness-managed, the
bootstrap preserves it and records that decision in `docs/agent/session-state.md`.

`harness requirements-definition` runs this bootstrap when it creates the initial
ChangeSet state.

## 2. 목적

이 문서는 ChangeSet과 유스케이스 slice 기반 실행 구조를 정의한다.
목표는 구현 요청마다 변경 의도와 영향을 명시하고, planner/executor가 전체
`docs/design/**`를 매번 다시 분석하지 않고 승인된 유스케이스 범위만 읽도록
입력 경계를 고정하는 것이다.

## 3. 표준 구조

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
      index.md
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
    plans/
      verification.md
```

`docs/templates/**`는 새 문서를 만들 때 복사해서 사용하는 기준이다.
`docs/changes/active`, `docs/changes/completed`, `docs/plans/active`,
`docs/plans/completed`는 실제 실행 상태를 표현한다.

## 4. ChangeSet 규칙

ChangeSet은 하나의 구현 요청 또는 문서 변경 요청을 나타낸다.
각 ChangeSet은 다음 내용을 반드시 포함한다.

- 변경 전 의도와 변경 후 의도 (`Before` / `After`)
- 변경되는 문서 목록
- 영향받는 work item 목록 (`use_case`, `maintenance`)
- 유스케이스별 E2E 목표 변경 여부
- maintenance별 verification goal 변경 여부
- planner/executor가 읽을 입력 범위
- 명시적으로 제외되는 범위

새 변경은 `docs/changes/active/<CHG-ID>.md`에 생성한다.
모든 영향 유스케이스의 plan이 완료되고 검증이 통과하면 같은 파일을
`docs/changes/completed/<CHG-ID>.md`로 이동한다.

## 5. 유스케이스 Slice 규칙

`docs/use-cases/<UC-ID>/`는 특정 유스케이스를 구현 가능한 단위로 좁힌
executor-facing 문서 집합이다.

- `index.md`: slice 문서의 상태, 승인 여부, 추적 링크
- `use-case.md`: 액터 목표, 사전조건, 기본/예외 흐름, 결과
- `event-storming.md`: 해당 UC에 필요한 command/event/policy/system slice
- `ddd-design.md`: 해당 UC 구현에 필요한 도메인/aggregate/service/BC 결정
- `technical-decisions.md`: 해당 UC 구현에 필요한 세부 기술 결정
- `docs/use-cases/<UC-ID>/e2e-goal.md`: pre-implementation business acceptance contract,
  including observable success/failure criteria and Given/When/Then
- `docs/use-cases/<UC-ID>/affected-files.md`: 예상 변경 파일과 금지 파일

유스케이스 slice가 존재하면 planner와 executor는 우선 이 디렉터리의 문서를
입력으로 사용한다. 공통 설계가 필요할 때만 `docs/design/**`를 보조 입력으로
참조한다.

## 6. Maintenance Slice 규칙

`docs/maintenance/<MAINT-ID>/`는 특정 유스케이스로 표현하기 어려운
리팩토링, 버그 수정, 테스트 보강, 인프라 변경, 문서 정리 같은 유지보수성
작업을 실행 가능한 단위로 좁힌 executor-facing 문서 집합이다.

Maintenance ID는 `MAINT-001`처럼 `MAINT-` 접두사와 3자리 숫자를 사용한다.
하나의 ChangeSet 안에서 유스케이스 slice와 maintenance slice는 함께 나열될 수
있고, planner/executor는 ChangeSet의 work item 순서를 따른다.

- `index.md`: maintenance slice 문서의 상태, 관련 ChangeSet, 문서 목록
- `change-intent.md`: 변경 의도, 배경, Before/After, 포함/제외 범위
- `affected-files.md`: 예상 변경 파일, 테스트 파일, 금지 파일
- `technical-decisions.md`: 필요한 경우의 구현 결정과 보류 결정
- `verification-goal.md`: 완료 판정 기준과 검증 명령

새 maintenance slice는 `docs/maintenance/<MAINT-ID>/` 아래에 생성하며,
필수 문서는 `docs/maintenance/<MAINT-ID>/change-intent.md`,
`docs/maintenance/<MAINT-ID>/affected-files.md`,
`docs/maintenance/<MAINT-ID>/verification-goal.md`다.
`docs/maintenance/<MAINT-ID>/technical-decisions.md`는 구현 결정이 필요한
경우에 사용한다.

Maintenance slice는 이벤트 스토밍이나 UC E2E goal을 요구하지 않는다.
대신 `verification-goal.md`가 구현 완료와 병합 가능 여부의 기준이 된다.
계획 파일은 `docs/plans/active/<MAINT-ID>/plan.md`에 생성하고, 완료 후
`docs/plans/completed/<MAINT-ID>/plan.md`로 이동한다.

## 7. Canonical Design 관계

`docs/design/**`는 전체 제품/도메인 수준의 canonical 문서다.
`docs/use-cases/<UC-ID>/**`는 특정 유스케이스 실행을 위한 slice 문서다.
`docs/maintenance/<MAINT-ID>/**`는 canonical 문서를 직접 대체하지 않고,
특정 유지보수성 변경에 필요한 실행 범위와 검증 기준만 기록한다.

- canonical 문서가 전체 진실의 원천이다.
- UC slice는 canonical 문서에서 해당 UC에 필요한 부분과 ChangeSet의 delta를
  실행 가능한 형태로 좁힌다.
- maintenance slice는 canonical 변경이 필요한 경우 ChangeSet에 그 필요성을
  명시하고, 승인되지 않은 canonical 문서 변경을 임의로 수행하지 않는다.
- slice와 canonical 문서가 충돌하면 executor loop에서 임의로 해결하지 않는다.
  `DOCUMENT_DELTA_CONFLICT` 또는 `UPSTREAM_DESIGN_CONFLICT`로 분류하고 상위
  문서 수정 단계로 되돌린다.
- 전체 `docs/design/이벤트 스토밍.md`는 summary/index로 유지할 수 있지만,
  UC 구현 계획의 직접 입력은 `docs/use-cases/<UC-ID>/event-storming.md`다.

## 8. Plan 이동 규칙

유스케이스별 plan은 `docs/plans/active/<UC-ID>/plan.md`에 생성한다.
Maintenance별 plan은 `docs/plans/active/<MAINT-ID>/plan.md`에 생성한다.
Verification evidence can be recorded in the same directory as `verification.md`.
For use-case work, keep `e2e-goal.md` stable after approval and record implementation-specific
test suite details, fixtures, request/response examples, UI steps, commands, and actual pass/fail
evidence in `docs/plans/active/<UC-ID>/verification.md` or the plan verification result.

다음 조건을 모두 만족할 때만 plan을 completed로 이동한다.

- `plan.md`의 모든 체크박스가 완료됨
- `docs/use-cases/<UC-ID>/e2e-goal.md` 또는
  `docs/maintenance/<MAINT-ID>/verification-goal.md`의 성공 기준 충족
- repository test gate의 required stage가 모두 PASS
- 검증 결과가 `plan.md` 또는 `verification.md`에 기록됨

완료된 plan은 `docs/plans/completed/<UC-ID>/plan.md`로 이동한다.
Maintenance plan은 `docs/plans/completed/<MAINT-ID>/plan.md`로 이동한다.
미완료, 실패, 차단 상태의 plan은 active에 남긴다.

검증 실패는 work item 유형에 맞춰 `implementation failure`, `scope conflict`,
`environment blocker`, `verification goal unclear`로 분류한다.

## 9. 런타임 CLI

로컬 런타임은 ChangeSet 아래 work item을 조회하고 실행 상태를
`.harness/runs/<run-id>/`에 저장한다.

```bash
./harness changes list
./harness changes show <CHG-ID>
./harness requirements-definition <CHG-ID>
./harness ubiquitous-language-definition <CHG-ID>
./harness use-case-definition <CHG-ID>
./harness event-storming <CHG-ID> --uc <UC-ID>
./harness ddd-architecture-definition <CHG-ID> --uc <UC-ID>
./harness technical-decisions <CHG-ID> --uc <UC-ID>
./harness plan-writing <CHG-ID> --uc <UC-ID> --plan|--preview|--apply
./harness implementation <CHG-ID> --plan|--preview|--apply
./harness stages list <CHG-ID>
./harness artifacts show <CHG-ID> <stage>
./harness artifacts accept <CHG-ID> <stage>
./harness resume <run-id>
./harness report <run-id>
./harness dashboard
```

`--plan` and `--preview` show scope and ordering without file changes or external
commands. `--apply` runs the selected stage and writes state/report/dashboard
projections.

## 10. Codex Prompt Prefix와 런타임 아티팩트

OpenAI/Codex 호출 비용 최적화는 응답 캐시가 아니라 **prompt prefix 재사용**에
맞춘다. 런타임은 에이전트 prompt를 항상 같은 섹션 순서로 조립한다.

```text
[stable] Runtime Instruction
[stable] Repository Source of Truth
[stable] Agent Instruction
[stable] Skill Body
[stable] Workflow Definition
[stable-ish] Repository Settings
[volatile] ChangeSet Summary
[volatile] Work Item Slice
[volatile] Current Execution Payload
```

규칙은 다음과 같다.

- stable 섹션은 ChangeSet, work item, run id, 로그보다 항상 앞에 둔다.
- optional 문서가 없어도 섹션 헤더는 유지하고 `<not found>`로 기록한다.
- file traversal은 정렬된 고정 순서를 사용한다.
- run id, temporary path, verifier output, diff, 로그는 stable prefix 앞에 두지 않는다.

에이전트 호출 시 런타임은 step-local 파일과 run-root snapshot을 함께 남긴다.

```text
.harness/runs/<RUN-ID>/
  prompt-<STEP-ID>.md
  response-<STEP-ID>.json
  stdout-<STEP-ID>.log
  stderr-<STEP-ID>.log
  usage-<STEP-ID>.json
  steps/<STEP-ID>/
    prompt.md
    command.json
    stdout.txt
    stderr.txt
    final-message.md
    result.json
```

`usage-<STEP-ID>.json`은 provider가 usage metadata를 제공하면 token 값을 저장한다.
노출되지 않는 값, 예를 들어 `cached_prompt_tokens`, 는 값을 추정하지 않고 `null`로
남긴다. 이 런타임 아티팩트는 source of truth가 아니라 재현, resume, audit, 디버깅을
위한 실행 증거다.
