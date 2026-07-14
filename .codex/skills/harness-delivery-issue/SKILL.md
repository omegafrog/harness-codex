---
name: harness-delivery-issue
description: 준비된 대상 저장소 또는 미초기화 대상 저장소에 ChangeSet 전달 GitHub Issue를 생성하거나 재사용하는 L3 skill이다.
---

# Delivery Issue

레벨: L3.

`scripts/create_issue.py`로 `gh issue`를 호출한다.

- 같은 대상 repository·ChangeSet·종류의 열린 Issue가 있으면 URL을 재사용한다.
- Issue 본문은 전달 범위·성공 기준·ChangeSet ID만 담는다.
- Issue 생성 실패는 `blocked`다.
- 파일을 수정하거나 다른 skill·agent를 호출하지 않는다.
- 호출 종료 후 token 추정을 출력한다.
