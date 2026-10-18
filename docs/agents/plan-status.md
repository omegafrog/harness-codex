# Tracker 상태 계약

## 상태 source

선택된 tracker가 canonical 상태를 저장한다. Harness가 생성한 ticket은 Beads에도 lifecycle 상태를 mirror해 공유 칸반에 표시한다.

- `github` mode: parent Issue는 전체 작업을, child Issue는 split plan을 나타낸다. child Issue의 GitHub Project `Workflow Status`가 canonical source다.
- `local-markdown` mode: ticket 파일의 상태가 canonical source다. plan 문서는 구현 계약과 실행 기록을 보조한다.
- Beads mirror는 `planned`→`open`, `in-progress`→`in_progress`, `blocked`→`blocked`, `completed`/`Done`→`closed`로 표시한다. Beads 변경이 실패하면 선택 tracker 상태는 되돌리지 말고 동기화 실패를 보고한다. 다음 실행에서 external reference로 재시도한다.

## Canonical 상태

- `planned`: 승인 전이거나, 승인되었지만 dependency 또는 blocker 때문에 실행할 수 없음
- `in-progress`: 구현자가 현재 실행 중
- `completed`: 구현·검증·상태 정리 완료
- `blocked`: 명시적인 blocker로 진행 불가

GitHub mode 매핑:

| Canonical 상태 | GitHub Project `Workflow Status` |
|---|---|
| `planned` | `Planned` |
| `in-progress` | `In Progress` |
| `blocked` | `Blocked` |
| `completed` | split plan 구현·검증·리뷰 완료 후 `Done` (child Issue는 plan-set integration PR merge 전 열려 있을 수 있음) |

local-markdown mode는 위 canonical 상태를 ticket 파일에 그대로 기록한다.

## 실행 가능성

별도 상태값 `ready-for-agent`를 저장하지 않는다. 다음 조건을 모두 만족하면 실행 가능으로 계산한다.

- 승인 완료
- 모든 dependency가 `completed`
- 구현 목적·범위·acceptance criteria·test contract 존재
- blocker 없음
- GitHub mode에서는 대응 child Issue가 parent Issue에 연결됨

GitHub mode에서 실행 가능 plan은 Project `Planned` 상태를 유지하며, `implement`가 선택해 `In Progress`로 전환한다.

## 상태 전이

```text
planned --(승인 + 실행 가능)--> in-progress
planned --(blocker 존재)--> blocked
in-progress --(구현·검증·리뷰 완료)--> completed
in-progress --(blocker 발생)--> blocked
completed --(dependency 해소)--> dependent planned ticket 재평가
```

## 책임

- `to-ticket`: GitHub mode에서는 parent/child Issue와 dependency를 만들고, local-markdown mode에서는 ticket·plan과 dependency를 만든다. 모두 `planned`로 초기화한다.
- `implement`: 실행 가능한 ticket 하나를 선택해 선택 tracker에서 `in-progress`로 전환하고 대응 Beads mirror도 `in_progress`로 갱신한다. blocker 발생 시 둘 다 blocked 상태로 반영한다. 구현·검증·리뷰가 완료되면 선택 tracker를 terminal state로 전환하고 Beads mirror를 닫은 뒤 dependent ticket을 재평가한다. GitHub child Issue는 열어 둔다. 모든 split plan 완료 후 plan-set integration PR 하나를 만든다.
- 사람: 승인, 요구사항·설계 결정, 외부 blocker만 처리한다. 정상적인 상태 전이는 수동으로 수행하지 않는다.

## 불변식

- 하나의 split plan은 하나의 child Issue 또는 하나의 local ticket에 대응한다.
- GitHub mode의 child Issue 본문은 split plan 본문이다.
- parent/child Issue 연결과 상태의 공식 source는 GitHub다. `docs/plans/<plan-set-id>/plans.md`는 해당 plan set의 split plan을 모아 보는 생성 인덱스이며 상태 source가 아니다. 각 plan set은 고유 디렉토리를 사용하고 `docs/plans/plans.md`에는 쓰지 않는다.
- parent/child 연결은 Markdown 링크가 아니라 GitHub Sub-issues API 관계여야 한다. `gh` CLI의 `--parent`, `--add-sub-issue` 옵션은 사용하지 않는다. child를 `gh issue create`로 만든 뒤 Issue `id`를 얻어 `gh api --method POST repos/<OWNER>/<REPO>/issues/<PARENT-ISSUE-NUMBER>/sub_issues -F sub_issue_id=<CHILD-ISSUE-ID>`로 연결한다. 기존 child를 재연결할 때만 `-F replace_parent=true`를 사용한다. 연결 후 부모의 `/sub_issues`와 child의 `/parent` REST endpoint를 확인한다.
- plan-set integration PR은 하나만 만들고, 본문에는 parent와 모든 child에 대한 closing keyword를 각각 넣는다. 개별 split plan 완료 시 child Issue 상태는 `Done`으로 전환하되 Issue는 닫지 않는다. 모든 split plan이 terminal 상태가 된 뒤에만 integration PR을 생성하며, PR이 repository default branch에 merge되면 GitHub가 Issue를 닫는다.
- 선택하지 않은 configured tracker에는 상태·dependency를 기록하지 않는다. Beads는 위 매핑에 따라 lifecycle을 mirror한다.
- 실행 가능 조건을 만족하는 ticket을 `planned`로 방치하지 않는다.

## 신규 mirror lifecycle v1

기존 데이터 migration은 하지 않는다. 새로 생성·연결하는 mirror에만 정수 `harness_tracker_version: 1`과 `harness_phase: planning`, `harness_classification: committed`를 기록한다. 기존 `harness_plan_id`는 idempotent 생성 식별자로 유지한다. exact external_ref로 하나의 mirror만 연결하며 legacy/로컬 운영 Beads를 tracker mirror로 추정하지 않는다.

상태 변경은 `harness-tracker.mjs sync`가 canonical 갱신·재조회→Beads 반영·재조회를 담당한다. 시작 workspace preflight/dispatch와 완료 hook/실제 completion은 `tracker_sync`로 신규 mirror 불일치를 검사한다. 실패 시 실행/정상 완료·종속 해제를 차단하고 기록된 sync를 재시도한다. 선택 tracker의 업무 상태는 rollback하지 않는다.

`backlog`는 `harness_classification` (`backlog`/`committed`)이며 테스트/리뷰는 `harness_phase` (`planning`/`implementation`/`test`/`review`)다. 실행 상태와 중복 저장하지 않는다. backlog 후보를 실행할 때는 committed로 분류한다. 신규 mirror에 `backlog/test/review` custom status를 사용하지 않는다. 별도 담당자·독립 acceptance가 필요한 경우에만 별도 ticket을 만든다.

GitHub 보드는 configured Workflow Status로 group/filter하며 기본 Status는 workflow 판단에서 제외한다. 기본 Status 열 숨김은 view 설정으로 안내하고 field 자체나 기존 item 상태는 삭제하지 않는다. Done은 구현·검증 완료이며 Issue closure는 integration PR merge lifecycle이다.
