---
name: harness-maintenance-bootstrap
description: orchestrator가 bugfix 또는 refactor로 분류한 ChangeSet의 maintenance intake를 작성할 때 호출한다.
---

# Maintenance Intake

레벨: L2.

1. `maintenance_intake_specialist` agent를 호출한다.
2. 선택된 ChangeSet과 `.codex/skills/harness-maintenance-bootstrap/references/intake-rules.md`를 입력한다.
3. `docs/maintenance/<MAINT-ID>/` 변경 경로와 blocker를 보고하고 종료한다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
