---
name: harness-delivery-bootstrap
description: 다중 저장소 전달 대상 중 Harness가 없는 Git repository에 로컬 Harness 설치와 초기화를 수행하는 L3 skill이다.
---

# Delivery Bootstrap

레벨: L3.

`scripts/bootstrap_repository.py --source-root <현재 worktree> --target <대상 repo>`를 실행한다.

- Git repository이고 GitHub mapping이 있는 대상만 초기화한다.
- 현재 Harness source의 runtime·skills를 설치한 뒤 `<target>/harness init --no-llm`을 실행한다.
- 제품 코드·테스트·build 설정은 수정하지 않는다.
- 설치·초기화 실패는 `blocked`다.
- 호출 종료 후 token 추정을 출력한다.
