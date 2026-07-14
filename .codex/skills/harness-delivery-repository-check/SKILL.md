---
name: harness-delivery-repository-check
description: 다중 저장소 ChangeSet 전달 전에 repository map, Git 저장소, Harness 설치물을 검사하는 L3 skill이다.
---

# Delivery Repository Check

레벨: L3.

`scripts/check_repositories.py --repo-root <worktree> --plan <plan.md>`를 실행한다.

- `current` 이외 `외부 저장소 전달` 대상만 검사한다.
- map 부재, path·GitHub repository·Harness 설치물 부재는 `blocked`로 반환한다.
- 파일을 수정하거나 다른 skill·agent를 호출하지 않는다.
- 호출 종료 후 token 추정을 출력한다.
