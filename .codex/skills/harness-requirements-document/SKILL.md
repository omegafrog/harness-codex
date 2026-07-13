---
name: harness-requirements-document
description: 확정된 요구사항 질문 결과로 표준 요구사항 문서만 작성하는 L3 skill이다.
---

# Requirements Document

레벨: L3.

질문 결과, 확정 입력, 호출자가 준 status만 사용해 `docs/changes/active/<CHG-ID>/requirements.md`를 작성하거나 갱신한다.

- `.codex/skills/harness-requirements-document/references/template.md`를 따른다.
- 질문 생성, 구현 판단, 용어 확정, use case 작성 금지.
- status 판단과 질문 생성 금지.
- 호출 종료 후 `.codex/workflow/token-estimation.md` 기준의 입력·출력·합계 추정 token을 출력한다.
