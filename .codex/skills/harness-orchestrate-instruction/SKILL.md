---
name: harness-orchestrate-instruction
description: 이 스킬이 명시적으로 선택된 경우에만 사용자 원문을 orchestration agent에 전달하는 L1 진입점이다.
---

# Harness Orchestration Instruction

이 스킬이 명시적으로 선택된 경우에만 실행한다.

## 절차

1. 사용자 프롬프트 원문 전체를 요약하지 않고 `/root/orchestration`의 첫 입력으로 전달한다.
2. 원문 전달 전에는 파일 읽기, tool 호출, 하위 skill 선택, CLI 실행을 하지 않는다.
3. 반환된 `next_skill` 하나만 호출하고 workflow agent를 `/root/*` 직접 자식으로 spawn한다.
4. step 결과를 같은 `orchestration` agent에 전달해 다음 결정을 받는다.
5. 질문, blocker, 실패 또는 완료까지 3~4를 반복한 뒤 최종 상태를 전달한다.

route가 없거나 agent를 호출할 수 없으면 `blocked: orchestration`으로 종료한다. 직접 CLI·수동 실행·대체 skill로 우회하지 않는다.
