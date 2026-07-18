---
name: harness-codedeploy-pipeline
description: Harness 메인 워크플로우의 W5 완료 뒤 기존 CodeDeploy GitHub Actions pipeline이 선언된 배포 계약과 달라졌는지 판별하고 필요한 경우에만 생성·수정하는 L2 step이다.
---

# CodeDeploy Pipeline

레벨: L2. ChangeSet의 `Deployment Pipeline: codedeploy`일 때 W5 뒤, W6 전에만 호출한다.

`codedeploy_pipeline` agent를 호출한다. 정본 지침은 `.codex/agents/references/codedeploy_pipeline.md`다.

1. ChangeSet, active plan, AppSpec, hook, 패키징 명령, AWS Target Participation을 읽는다.
2. `references/reconciliation.md`의 변경 판정과 실패 정책을 적용한다.
3. `scripts/reconcile_codedeploy.py`를 실행해 `created | updated | unchanged | conflict | skipped`를 판정한다.
4. `unchanged`면 파일을 쓰지 않고 정상 통과한다.
5. `created | updated`면 workflow 문법과 AppSpec·패키징 계약을 검증한다.
6. 결과를 `.harness/runs/<RUN-ID>/codedeploy-gate.json`에 기록하고 orchestrator에 반환한다.

사용자 소유 workflow는 덮어쓰지 않는다. live AWS mutation은 Target Participation의 `Mutation: allowed`일 때만 수행한다. EC2가 `stopped | stopping`이면 알리고 비차단 결과를 반환한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
