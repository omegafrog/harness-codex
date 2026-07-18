# Agent Lifecycle 계약

이 문서는 orchestration 계층의 sub-agent 생성, 재사용, 대기 정본이다. Runtime은 Codex
collaboration tool을 가로채거나 agent를 선택하지 않는다. 호출자가 이 계약을 적용하고
contract test가 필수 규칙을 고정한다.

## Lease Key

orchestration은 session-local lease table을 유지한다.

| ChangeSet ID | Role | Scope ID | Agent path | State | Revision |
| --- | --- | --- | --- | --- | --- |
| opaque ID | agent role | UC, batch, artifact revision 또는 stage | canonical path | running / idle / blocked / failed | opaque revision |

lease key는 `(ChangeSet ID, Role, Scope ID)`다. 같은 key에 둘 이상의 agent를 두지 않는다.
compaction 뒤에는 `list_agents`를 한 번 호출해 lease table을 재조정할 수 있다.

같은 ChangeSet에서는 orchestration agent를 하나만 유지한다. 동일 UC 또는 UC batch의 같은
requirements, Oracle, DDD role은 각각 하나의 lease만 가지며, 동일 implementation batch의 executor와
동일 artifact revision의 reviewer도 각각 하나만 유지한다.

## Dispatch 우선순위

1. 같은 lease의 running agent에 필수 입력 변경이 있으면 `send_message`를 사용한다.
2. 같은 lease의 idle agent를 재개할 수 있으면 `followup_task`를 사용한다.
3. reusable lease가 없을 때만 `spawn_agent`를 사용한다.

L3 document skill은 owning L2 agent가 직접 호출한다. 별도 agent를 spawn하지 않는다.
task 또는 commit 경계만으로 executor를 교체하지 않는다.

새 agent는 다음 경우에만 허용한다.

- producer와 분리된 plan, implementation 또는 security review
- 서로 독립적인 UC batch의 병렬 처리
- 기존 lease가 blocked, failed 또는 복원 불가
- role, sandbox, mutation capability가 달라 재사용 불가

slot 또는 depth 한도 실패 뒤 같은 인수로 spawn을 반복하지 않는다. 현재 cohort가 끝날 때까지
기다리거나 상위 agent에 한 번만 escalation한다.

## Cohort Event Loop

orchestration은 agent별 polling 대신 다음 event loop를 사용한다.

1. ready agent를 concurrency 한도까지 dispatch한다.
2. 즉시 처리 가능한 mailbox 결과와 로컬 결정을 모두 처리한다.
3. 더 dispatch할 일이 없고 running cohort가 있을 때만 `wait_agent`를 한 번 호출한다.
4. 새 상태 전환을 처리한 뒤 다음 cohort를 dispatch한다.

정상 진행 확인을 위해 `list_agents`를 호출하지 않는다. 최초 topology 확인, compaction 복구,
응답 유실 또는 slot 불일치 진단에서만 허용한다.

sub-agent는 사용자 질문, blocker·새 failure fingerprint, batch·stage 완료, heartbeat만 보고한다.
테스트 한 건 완료, 단순 확인, 독촉, 변화 없는 진행 상태는 보내지 않는다. `send_message`도
running agent의 필수 입력 변경에만 사용한다.

shell/tool `wait`는 실제 yielded process에만 사용하고 한 번에 60초를 넘기지 않는다. 새 출력이나
종료가 없으면 동일 상태를 재보고하지 않는다.

## Executor Checkpoint

executor lease key는 `(ChangeSet ID, implementation_executor, Batch ID)`다. 같은 batch와 같은
environment fingerprint에서는 context, process state와 reusable PASS evidence를 유지한다.

다음 조건에서만 checkpoint 후 lease를 교체한다.

- batch 또는 bounded context 변경
- dependency 또는 environment fingerprint 변경
- upstream 회귀
- 복원 불가능한 compaction
- 실행 중 process 또는 미커밋 상태가 다음 batch를 오염시킴

checkpoint에는 commit, `EvidenceEnvelope`, invalidated requirement, remaining batch를 포함한다.

## 감사 기준

- 동일 lease key의 중복 agent session: 0
- slot/depth 실패 후 동일 spawn 반복: 0
- 정상 상태 확인 목적 `list_agents`: 0
- heartbeat 전 unchanged progress wakeup: 0
- executor 생성 단위: task가 아니라 batch
