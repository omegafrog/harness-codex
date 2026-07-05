---
name: harness-question-router
description: Answer questions about harness-implemented DDD code by routing the request through `harness changes question`, identifying whether it is a question or implementation request, then delegating scoped read-only analysis to the question_orchestrator agent. Use when the user asks how implemented behavior works, why a ChangeSet implementation behaves a certain way, where code for a BC/aggregate/module lives, or asks for an explanation rather than a code change.
---

# Harness Question Router

## Workflow

1. Resolve the target ChangeSet.
   - Use the user-provided `CHG-ID` when present.
   - Otherwise run `./harness changes active` or `./harness changes list` and choose the only clear active ChangeSet.
   - If multiple targets remain plausible, ask one concise clarification.

2. Run the router before reading product code:

```bash
./harness changes question <CHG-ID> --query "<USER QUESTION>" [--uc <UC-ID>] --json
```

3. Interpret the route.
   - If `intent` is `implementation`, do not answer as a question. Tell the user it should go through `harness changes continue` or `harness implementation`.
   - If `intent` is `question`, continue with scoped read-only analysis.

4. Delegate to the dedicated agent when available.
   - agent id: `question_orchestrator`
   - config: `.codex/agents/question_orchestrator.toml`
   - required reference: `.codex/agents/references/question_orchestrator.md`

5. Pass this prompt shape to the agent:

```text
사용자 질문:
<original user question>

라우팅 JSON:
<exact JSON from harness changes question>

작업:
- 라우팅 JSON의 preferred_read_scope와 read_order를 먼저 따른다.
- 코드/문서 조회는 후보 BC/module/aggregate 범위에 제한한다.
- 범위 밖 조회가 필요하면 이유를 먼저 설명하고 최소 파일만 읽는다.
- 파일 수정, 테스트 수정, runtime 수정, git 작업은 하지 않는다.
- 답변은 한국어로 작성하고, 근거 파일 경로를 포함한다.
```

6. If the dedicated agent cannot be spawned, answer locally using the same route and read limits. Do not broaden code search to the whole repository.

## Read Limits

- Read ChangeSet and affected UC artifacts first.
- Read only `preferred_read_scope` paths before expanding.
- Prefer `rg` within scoped paths over repository-wide search.
- Expand outside scope only for imports, public APIs, compile references, or clearly named shared utilities.
- Do not modify files while answering a question.

## Output

Return:

- direct answer
- scoped evidence paths
- any scope expansion performed and why
- residual uncertainty when the route could not identify a BC/module/aggregate
