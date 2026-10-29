# local-markdown tracker

이 파일은 `.codex/harness.yaml`의 `tracker.mode: local-markdown`일 때만 읽는다. 설정된 local ticket 문서가 상태·승인·의존성의 기준이며, GitHub Issue/Project 조회나 갱신을 하지 않는다.

- 선택한 plan은 `docs/plans/<plan-set-id>/<plan-id>.md`에서 읽는다. 해당 ticket의 상태·의존성은 설정된 local ticket 문서에서 읽고, `docs/plans/<plan-set-id>/plans.md`는 계획 본문이 아닌 링크·요약 index로만 사용한다.
- 실행 후보는 상태가 `planned`이고 미완료 dependency가 없는 ticket이다. 현재 입력에 대한 planning review gate도 통과해야 dispatch한다.
- local ticket 또는 계획 간 mapping이 누락·충돌하면 구체 근거를 보고하고 dispatch를 막는다. 누락된 tracker 정보를 GitHub에서 추측하거나 가져오지 않는다.
- 진행·차단·완료 상태는 local ticket 문서에 `in-progress`, `blocked`, `completed`로 반영한다. GitHub parent epic 절차는 적용하지 않는다. 새 mirror와 lifecycle transition의 Beads 반영은 공통 Beads 계약을 따른다.

Canonical 상태 이름은 `planned`, `in-progress`, `blocked`, `completed`다.
