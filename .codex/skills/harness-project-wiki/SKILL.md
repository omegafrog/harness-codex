---
name: harness-project-wiki
description: orchestrator가 review ready와 선언된 Documentation Impact를 확인한 뒤 문서를 갱신할 때 호출한다.
---

# Documentation Completion

레벨: L2. `review.md`가 ready이고 unresolved Deferred Finding이 없으며 Documentation Impact가
`local | broad | bootstrap`일 때만 호출한다. wiki 근거에는 required/achieved verification level과
resolved finding disposition/link를 포함한다.

- `local`: source scan으로 근거를 확인하고 선언된 기존 문서만 갱신·검증한다. 문서 체계 생성,
  dependency 설치, 전체 페이지 재작성, 별도 문서 체계 commit은 수행하지 않는다.
- `broad`: 선언된 기존 문서 집합만 source scan → document → verify → commit 순서로 처리한다.
- `bootstrap`: 새 문서 체계가 명시적으로 승인된 경우에만 document, 구성, dependency 설치,
  전체 verify와 commit을 수행한다.
- `none`: 이 skill을 호출하지 않고 `skipped`로 기록한다.

특정 문서 도구, API endpoint 또는 저장소 구조를 전제로 하지 않는다. 필요한 검증은
caller-owned requirement와 probe로 선언하고 Runtime의 generic evidence를 사용한다.

호출 종료 후 token 추정치를 출력한다.
