---
name: harness-orchestrate-instruction
description: 이 스킬이 명시적으로 선택된 경우에만 사용자 원문을 orchestration agent에 전달하는 L1 진입점이다.
---

# Harness Orchestration Instruction

이 문서는 모든 사용자 프롬프트를 전역적으로 orchestration agent에 라우팅하라는 의미가 아니다. 일반 질문이나 직접 확인 가능한 저장소 질의는 이 스킬이 선택되지 않았다면 직접 처리할 수 있다.

## 절차

1. 사용자 프롬프트 원문 전체를 수정하거나 요약하지 말고 `orchestration` agent의 첫 입력으로 전달한다.
2. 원문 전달 전에 파일 읽기, tool 호출, 하위 skill 선택, CLI 실행을 하지 않는다.
3. `orchestration` agent가 route를 결정하고 해당 L2 step skill을 직접 호출한다. 이 L1 skill은 `next_skill`을 받아 대신 호출하지 않는다.
4. `orchestration` agent가 step skill 호출 결과를 포함한 최종 상태를 반환하면 그 결과를 사용자에게 전달한다.
5. route가 없거나 agent를 호출할 수 없으면 `blocked: orchestration`으로 종료한다.

직접 CLI 실행, 수동 route 실행, 대체 skill 우회 호출은 허용하지 않는다.
