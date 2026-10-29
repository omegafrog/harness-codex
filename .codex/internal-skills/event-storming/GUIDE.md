<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# event-storming

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [정적 호출기](../static-caller/GUIDE.md)에 따라 `harness-static-call.mjs`가 스킬의 binding과 setup 설정을 읽어 model·effort를 선택한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

## What it does

`event-storming` maps a use-case command into actors, commands, events, policies, and external systems for DDD.

It stays in the problem space and does not choose module structure, persistence, or frameworks.

## Stakeholder input

The skill must reflect stakeholder perspectives. Ask about stakeholders whenever they are already known from prior context, or whenever the use case needs them to be made explicit.

Use those stakeholder views to shape the extraction of:

- actors
- commands
- events
- policies
- external systems

If the stakeholder set is incomplete, ask one question at a time until the missing perspective is clear enough to keep going.

## When to reach for it

Use `/event-storming` when a use case needs its domain flow made explicit before aggregates or code structure are discussed.

## Output

- candidate actors
- candidate commands
- candidate events
- candidate policies
- candidate external systems
- open questions for the next grilling step
