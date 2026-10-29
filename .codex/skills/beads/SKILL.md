---
name: beads
description: Use when a project uses bd or Beads for shared tasks, dependencies, blockers, or durable handoff across sessions and worktrees.
---

# Beads

## 실행 모델과 반환

기본 `model_tier`는 `low`이며 `agents.low_performance_model`와 `agents.low_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [공통 skill 실행 계약](../../../.codex/internal-skills/skill-execution/GUIDE.md)에 따라 caller가 실제 model·effort를 resolve하여 subagent spawn에 전달한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

Use the `bd` CLI as the durable project task tracker when the repository has an active Beads workspace.

## Start

Run `bd prime` for workflow context. If it prints nothing, check `bd where`. Never initialize a database from this skill; project setup CLI owns initialization and must collect approval in its terminal before changing local or remote workspace state.

## Work

- Find tasks with `bd ready` and `bd list --status=open`.
- Inspect before editing with `bd show <id>`.
- Claim atomically with `bd update <id> --claim`.
- Create durable follow-up tasks with `bd create`.
- Close only completed work with `bd close <id> --reason="Completed"`.
- Prefer `--json` when parsing output programmatically.
- Do not use `bd edit`; use `bd update` flags instead.
- Do not duplicate Beads tasks in Markdown TODO lists.

## Harness ticket mirrors

`to-ticket` creates Beads mirrors for the tickets in the configured tracker. The configured tracker remains authoritative; mirror these lifecycle transitions in Beads so the shared board reflects execution:

| Configured tracker | Beads |
|---|---|
| `planned` / `Planned` | `open` |
| `in-progress` / `In Progress` | `in_progress` |
| `blocked` / `Blocked` | `blocked` |
| `completed` / `Done` | `closed` via `bd close` |

새로 생성하는 tracker mirror는 `external_ref`와 정수 metadata `harness_tracker_version: 1`을 함께 기록한다. 기존 데이터는 migration·재분류·자동 연결하지 않는다. 이 marker가 없는 Bead는 로컬 운영 작업으로서 기존 방식으로 관리하며 tracker mirror라고 추정하지 않는다.

새 mirror의 상태 변경은 아래 공통 명령만 사용한다. GitHub/로컬 ticket 갱신→canonical 재조회→Beads 반영→재조회 순서를 코드가 수행한다. exact external_ref가 없거나 중복이면 변경하지 않는다.

```sh
node .codex/scripts/harness-tracker.mjs sync --root <workspace_root> --ticket <external_ref> --status in-progress --phase implementation --classification committed
node .codex/scripts/harness-tracker.mjs sync --root <workspace_root> --ticket <external_ref> --phase review
node .codex/scripts/harness-tracker.mjs check --root <workspace_root>
```

상태는 `planned`, `in-progress`, `blocked`, `completed` 네 개만 허용한다. `backlog`는 `harness_classification` (`backlog`/`committed`), `test`·`review`는 `harness_phase` (`planning`/`implementation`/`test`/`review`)에 기록한다. 이 값들은 상태나 새로운 task type이 아니다. `bd todo`는 open task의 편의 명령이다. mirror에 `bd --claim`/직접 status 변경을 사용하지 않는다. 별도 담당자와 독립 acceptance가 필요한 경우에만 테스트/리뷰 child ticket을 만든다.

workflow 시작의 workspace preflight와 dispatch, 종료의 공통 완료 명령은 v1 mirror의 실제 canonical 상태를 재조회하여 불일치를 차단한다. 상태를 바꾸지 않는 `check`는 legacy Bead를 제외한다. 동기화 실패는 local journal의 원인과 재시도 명령을 보고한다. canonical 갱신이 성공했다면 되돌리지 않고 `sync --ticket <ref>` (status 생략, 실패 기록의 phase/classification은 같은 flag로 재전달)로 현재 canonical 상태를 다시 반영한다. 실패를 tracker 업무 blocker와 섞어 기존 canonical 상태를 `Blocked`로 덮지 않는다. 상태 정합성이 복구될 때까지 새 실행/정상 완료·종속 작업 해제를 하지 않는다.

`blocked` and `blocking` describe dependency direction, not duplicate ticket states: a ticket is blocked by an unfinished prerequisite; a blocking ticket is the prerequisite that another ticket depends on. `bd dep add <blocked-ticket-id> <blocker-ticket-id>` records that direction. Finish the blocker first; the dependent ticket becomes eligible after its prerequisite is completed.

Linked Git worktrees in the same repository share one Beads workspace. Do not create or copy a separate `.beads` directory in a linked worktree. For remote-backed databases, follow the coordinated migration gate: one designated clone migrates and publishes; every other clone adopts that result.
