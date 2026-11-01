<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# event-storming

## 실행 모델과 반환

기본 `model_tier`는 `high_performance`이며 `agents.high_performance_model`와 `agents.high_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [실행 조율](../skill-execution/GUIDE.md)에 따라 `harness-skill-execution.mjs binding`이 스킬의 binding과 setup 설정에서 model·effort를 해석한다. 지정된 작업을 수행하고 필요한 내부 작업은 [실행 조율](../skill-execution/GUIDE.md)에 따라 서브에이전트에 위임한다. 사용자 결정과 workflow 단계 전환은 상위 caller에 반환한다.

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
