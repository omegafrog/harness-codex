---
name: harness-requirements
description: Harness 메인 워크플로우에서 초기 요청을 요구사항으로 정리하는 L2 step이다.
---

# Requirements

레벨: L2.

`requirements_interviewer` agent를 호출한다. agent의 정본 지침은
`.codex/agents/references/requirements_interviewer.md`다.

호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
