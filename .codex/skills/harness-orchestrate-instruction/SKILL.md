---
name: harness-orchestrate-instruction
description: 이 스킬이 명시적으로 선택된 경우에만 사용자 원문을 orchestration agent에 전달하는 L1 진입점이다.
---

# Harness Orchestration Instruction

## 절차

1. 확인한다: 현재 agent 경로가 정확히 `/orchestration`인지 확인한다.
2. 수행한다: `/orchestration`이면 새 orchestration agent를 만들지 않는다. `.codex/agents/orchestration.toml`과 그 파일이 지시하는 참조 문서를 읽어 orchestration 역할을 직접 수행한다.
3. 전달한다: 그 외 경로에서는 사용자 프롬프트 원문 전체를 수정·요약하지 않고 `orchestration` agent에 전달한다. 원문 전달 전에는 파일 읽기, tool 호출, skill 선택, CLI 실행을 하지 않는다.
4. 위임한다: agent가 route와 L2 step 호출을 수행한다. L1은 `next_skill` 하나만 호출하라는 응답을 대신 실행하지 않는다.
5. 반환한다: step 결과를 사용자에게 전달한다. route나 agent 호출이 없으면 `blocked: orchestration`으로 종료한다.

직접 CLI·수동 실행·대체 skill로 우회하지 않는다.
