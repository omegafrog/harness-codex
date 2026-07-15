---
name: harness-orchestrate-instruction
description: 이 스킬이 명시적으로 선택된 경우에만 사용자 원문을 orchestration agent에 라우팅한다.
---

# Harness Orchestration

이 스킬이 선택된 턴의 필수 진입점(L1).

이 문서는 모든 사용자 프롬프트를 전역적으로 orchestration agent에 라우팅하라는 의미가 아니다. 일반 질문이나 직접 확인 가능한 저장소 질의는 이 스킬이 선택되지 않았다면 직접 처리할 수 있다.

1. 사용자 프롬프트 원문 전체를 수정·요약하지 말고 `orchestration` agent의 첫 입력으로 전달한다.
2. 원문 전달 전에는 파일 읽기, tool 호출, 하위 skill 선택, CLI 실행을 하지 않는다.
3. `orchestration` agent가 반환한 `next_skill` 하나만 호출한다.
4. route가 없거나 agent를 호출할 수 없으면 `blocked: orchestration`으로 종료한다.

직접 CLI·수동 실행·대체 skill로 우회하지 않는다.
