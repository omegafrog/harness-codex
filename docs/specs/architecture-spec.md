# Architecture Spec

## 1. Design Scope

| 항목 | 대상 |
| --- | --- |
| Product Spec | `docs/specs/product-spec.md` |
| Use Cases | UC-01 ~ UC-06 |
| Domain | 에이전틱 plan 구현 orchestration |
| Bounded Contexts | 별도 DDD bounded context를 두지 않음 |
| Existing Services | `implement`, `code-review`, `to-ticket` skills |
| External Dependencies | subagent runtime, Git, GitHub Issue/label 규칙 |
| Affected Data | `docs/plans/<plan-id>.md`, `docs/plans/plans.md`, `docs/plans/.runtime/<plan-id>/checkpoint.md` |

## 2. Product Spec Mapping

| Product Spec 항목 | Architecture 요소 |
| --- | --- |
| UC-01 Plan 위임 실행 | wrapper가 plan별 subagent를 spawn하고 subagent가 `implement` 실행 |
| UC-02 독립 plan 병렬 실행 | dependency/resource 판정과 plan별 실행 슬롯 |
| UC-03 Blocker 해결 반복 | subagent의 `implement` blocker/review loop |
| UC-04 Context Handoff 및 재개 | checkpoint writer와 동일 plan 재개 prompt |
| UC-05 Plan 충돌 라우팅 | wrapper의 conflict pause 및 main-session priority decision |
| UC-06 Plan 완료 판정 | subagent의 기존 `implement` completion/review contract |

## 3. Execution Flow

```text
Main Session
  -> load plans.md and linked plans
  -> select approved executable plans
  -> evaluate dependencies and shared resources
  -> spawn at most one subagent per plan slot
  -> wait / inspect reports
       |-- context handoff -> checkpoint -> resume same plan slot
       |-- implementation blocker -> subagent continues or reports blocked
       |-- unexpected conflict -> pause related slots -> main priority routing
       `-- completed -> release slot and recalculate next plans
```

## 4. Responsibility Boundaries

| Component | Responsibility | Must Not Do |
| --- | --- | --- |
| `implement-wrapper` skill | plan scheduling, dependency/resource gating, spawn/wait, handoff/resume, conflict routing | implementation code 수정, plan 완료 상태 직접 갱신 |
| `implement` skill | one plan implementation lifecycle | another implementation subagent spawn |
| checkpoint record | resumable execution memory | official plan status 대체 |
| main session | priority and user-facing coordination | 충돌 자동 병합, 구현 직접 수정 |
| `code-review` skill | implementation fixed-point review | orchestration scheduling |

wrapper는 구현을 대체하지 않는다. 서브에이전트 prompt에 기존 `.codex/skills/implement/SKILL.md`를 사용하도록 명시하고, 서브에이전트가 테스트·typecheck·commit·code-review·plan status reconciliation을 담당한다.

## 5. Scheduling and State

wrapper는 plan 문서에 제시된 dependency와 shared resource를 사용한다. dependency가 모두 `completed`이고 shared resource 충돌이 없을 때만 병렬 실행한다. 판단이 불확실하면 순차 실행한다. 동일 plan slot에 두 subagent가 동시에 존재하지 않도록 한다.

공식 ticket status는 GitHub mode에서 Project `Planned`, `In Progress`, `Blocked`, `Done`이고, local-markdown mode에서 `planned`, `in-progress`, `blocked`, `completed`다. `handoff-required`, `conflict-paused`, `priority-routed`는 checkpoint orchestration state로만 표현한다.

| State | Owner | Storage |
| --- | --- | --- |
| Official ticket status | `implement` subagent | setup이 선택한 tracker |
| Active execution slot | wrapper | runtime orchestration state |
| Handoff/conflict state | wrapper + subagent | gitignored checkpoint |
| Priority decision | main session | checkpoint and report |

## 6. Wrapper-to-Implement Contract

wrapper가 subagent prompt에 전달하는 정보:

- 저장소 작업 경로
- 정확한 plan 문서 경로와 `docs/plans/plans.md` backlink
- Product/Architecture Spec 경로
- `.codex/skills/implement/SKILL.md` 사용 지시
- checkpoint 경로 `docs/plans/.runtime/<plan-id>/checkpoint.md`
- 신규 실행인지 `in-progress` 재개인지
- dependency/resource 관계와 직전 보고

subagent는 지정 plan 하나만 수행한다. handoff 후 새 subagent는 checkpoint, plan, spec, 실제 Git/test 상태를 대조하고 실제 상태를 우선해 재개한다.

## 7. Checkpoint Design

경로는 `docs/plans/.runtime/<plan-id>/checkpoint.md`로 고정한다. `docs/plans/.runtime/`는 `.gitignore`에 포함하되, wrapper prompt에 상대 경로를 매번 명시해 새 subagent가 읽도록 한다.

```yaml
plan_id: <plan-id>
orchestration_state: running | handoff-required | conflict-paused | priority-routed
attempt: <integer>
last_completed_step: <text>
changed_files: []
tests:
  - command: <command>
    result: passed | failed | not-run
    evidence: <short evidence>
blocker:
  kind: none | code | environment | decision | conflict
  summary: <text>
  unblock_condition: <text>
next_action: <text>
handoff_reason: context-threshold | milestone | conflict | retry
updated_at: <timestamp>
```

subagent는 컨텍스트 잔여량이 안전 임계치 아래로 내려가거나 주요 milestone이 끝났을 때 checkpoint를 기록한다. blocker 해결 중에도 위험 수준이면 시도·실패 원인·다음 시도를 기록하고 종료한다. wrapper는 동일 plan slot을 새 subagent로 재개한다.

## 8. Conflict and Failure Handling

| 상황 | 처리 | 공식 plan status |
| --- | --- | --- |
| 코드/테스트 실패 | subagent가 범위 안에서 원인 분석·수정·재검증 | `in-progress` |
| 외부 결정/권한/환경 필요 | unblock condition 보고 후 중단 | `blocked` |
| 컨텍스트 handoff | checkpoint 작성 후 새 subagent 재개 | `in-progress` |
| 예상 밖 파일/Git 충돌 | 관련 slot 중단, main session이 우선순위 결정 | `in-progress` |
| review 미완료/실패 | `implement` 규칙에 따라 수정 또는 재개 | `in-progress` |
| review clean 및 blocker 없음 | subagent가 완료 처리 | `completed` |

충돌 시 wrapper는 자동 merge나 자동 priority 결정을 하지 않는다. main session은 충돌 증거와 plan 범위를 확인해 먼저 실행할 plan을 정하고, 우선 plan 완료 후 나머지 plan을 재평가한다.

## 9. Tests and Verification

현재 관련 테스트는 skill text와 plan-status contract를 검증하는 `tests/test_plan_status_pipeline.py`다. parallelism·handoff·checkpoint recovery·slot lock·conflict routing behavioral test seam은 없다. 구현 시 최소한 다음 계약을 검증한다.

- plan당 하나의 subagent만 spawn
- 독립 plan 병렬화 및 dependency plan 대기
- prompt의 checkpoint 경로 포함
- handoff 후 동일 plan resume
- checkpoint/Git/test 불일치 시 실제 상태 우선
- conflict 발생 시 main priority decision 대기
- 공식 plan status가 기존 다섯 상태 밖으로 확장되지 않음

## 10. Risks and Non-goals

| Risk | Decision |
| --- | --- |
| public/internal `implement` drift | wrapper는 기존 스킬을 복사하지 않고 호출 계약만 정의 |
| ignored checkpoint 접근성 | prompt에 고정 경로를 명시하고 resume 시 존재·상태 확인 |
| 상태 혼합 | 공식 status는 유지하고 runtime state는 checkpoint에만 기록 |
| 병렬 Git 충돌 | 자동 병합하지 않고 main session priority routing |
| 부분 갱신 | 각 단계의 evidence를 기록하고 재개 시 대조 |

DDD aggregate, bounded context, repository boundary는 도입하지 않는다. wrapper가 구현 코드·plan 본문·공식 완료 상태를 직접 변경하지 않으며, 자동 merge·자동 priority·외부 환경 해결도 범위 밖이다.
