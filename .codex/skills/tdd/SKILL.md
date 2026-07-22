---
name: tdd
description: Implement approved behavior through failing tests first and minimal production changes. Use during implementation when a test seam and acceptance contract are known.
---

# tdd

## 목적

합의된 test seam에서 실패 test를 먼저 만들고 최소 구현으로 통과시킨다.

## 규칙

- test는 구현 계약을 먼저 고정한다.
- 실패가 확인되기 전 구현을 확장하지 않는다.
- 계획 밖 범위로 test를 넓히지 않는다.
