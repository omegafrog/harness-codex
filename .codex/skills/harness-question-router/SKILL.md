---
name: harness-question-router
description: Answer questions about harness-implemented DDD code by routing the request through `harness changes question`, identifying whether it is a question or implementation request, then delegating scoped read-only analysis to the question_orchestrator agent. Use when the user asks how implemented behavior works, why a ChangeSet implementation behaves a certain way, where code for a BC/aggregate/module lives, or asks for an explanation rather than a code change.
---

# Harness Question Router Sequence

1. Resolve the one ChangeSet; ask one concise question only when multiple targets remain.
2. Run `./harness changes question <CHG-ID> --query "<USER QUESTION>" [--uc <UC-ID>] --json` before product-code reads.
3. For `implementation`, delegate to orchestration. For `question`, delegate the exact route JSON to `question_orchestrator`.
4. The dedicated agent follows `.codex/agents/references/question_orchestrator.md`; do not duplicate its read policy here.
5. If delegation is unavailable, apply that same bounded read policy locally and return Korean evidence paths, scope expansion, and uncertainty.
