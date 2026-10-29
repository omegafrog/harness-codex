---
name: eli5
description: Explain a topic to a complete beginner with a visual-first, low-text explanation. Use when the user invokes eli5, asks to explain something like they are five, or asks for a dead-simple picture-style explanation of how something works.
---

# eli5

## 실행 모델과 반환

기본 `model_tier`는 `low`이며 `agents.low_performance_model`와 `agents.low_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [정적 호출기](../../../.codex/internal-skills/static-caller/GUIDE.md)에 따라 `harness-static-call.mjs`가 스킬의 binding과 setup 설정을 읽어 model·effort를 선택한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

Explain the topic for someone with no prior knowledge. Preserve the original skill's core idea: **big-picture visuals, very few words, immediate understanding**.

## Topic

Use the topic from the user's current request.

- If the host invokes this skill from a command with trailing text, treat that trailing text as the topic.
- Do not depend on provider-specific argument variables such as `$ARGUMENTS`.
- If no topic is stated, simplify the immediately preceding topic or explanation when the conversation makes it unambiguous.

## Explain

1. Understand the topic before simplifying it. Use whatever repository, file, search, or inspection tools are available only when the topic requires them.
2. Reduce the topic to one correct mental model. Simplify details, but do not introduce a false mechanism.
3. Lead with one short sentence that says what the thing is.
4. Show the mechanism or relationship visually.
5. Add only the minimum labels needed to understand the visual.
6. End with one short sentence explaining why it matters.

Prefer concrete objects, arrows, containers, people, roads, pipes, queues, shelves, or other familiar shapes over abstract prose. Use an analogy only when it makes the mechanism easier to understand.

## Visual Output

Use the best visual medium the current host actually supports. The skill must still work when no special artifact or rendering tool exists.

Preference order:

1. A native visual or artifact surface, when the host provides one and using it is appropriate.
2. Mermaid or another supported diagram format for simple flows and relationships.
3. A compact Markdown or ASCII diagram using boxes, arrows, icons, or emoji.

HTML or SVG may be used when the user explicitly asks for a page/file or the host exposes a suitable creation surface. **Do not assume an HTML artifact feature exists.**

Do not require image generation, browser automation, a particular shell command, or a provider-specific tool merely because this skill was invoked.

## Style

- Assume zero background knowledge.
- Prefer one visual over several paragraphs.
- Keep labels short: usually 1-5 words.
- Introduce at most one unfamiliar technical term at a time, and define it immediately.
- Avoid preambles, history, edge cases, and implementation detail unless they are necessary for the core mental model or the user asks for them.
- Never talk down to the user.

A good response should usually fit this shape:

```text
[one-sentence idea]

[large, simple visual]

[up to 3 tiny notes]

[one-sentence why it matters]
```

## Composition

`eli5` changes **how an already-understood topic is explained**. It does not replace research, debugging, architecture analysis, or code inspection skills. When another skill is responsible for determining the facts, use that result as the source and apply `eli5` only to the explanation layer.
