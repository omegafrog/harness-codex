<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

내부 절차를 호출할 때 공개 스킬 검색 대신 해당 GUIDE를 읽는다: [codebase-design](../codebase-design/GUIDE.md) · [ddd-design](../ddd-design/GUIDE.md).

# code-research

## 실행 모델과 반환

기본 `model_tier`는 `low`이며 `agents.low_performance_model`와 `agents.low_performance_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [공통 skill 실행 계약](../skill-execution/GUIDE.md)에 따라 caller가 실제 model·effort를 resolve하여 subagent spawn에 전달한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

## What it does

`code-research` inspects the current codebase and returns only the facts and deltas needed for architecture work.

## What it collects

- current package and module structure
- public entrypoints and boundaries
- relevant source and test seams
- persistence, adapter, and integration touchpoints
- anything that conflicts with the target design

For DDD/architecture work, read the affected `CONTEXT-MAP.md`, linked ADRs/models/diagrams, and `docs/architecture/domain-model.md` when present. Return the affected existing contexts, aggregate roots or explicit absence, identity/state/invariants, rule-owning methods/functions, public APIs, callers, data/transaction ownership, communication paths, and deployment units with source `file:line` and inspected commit. Separate observed implementation, accepted target, and document drift. Identify the smallest existing-owner extension and missing evidence; do not infer new aggregates from directory names. See [model continuity](../ddd-design/references/model-continuity.md).

## Navigation policy

Check current scoped canonical/retired terms before naming the model. For replacement work, identify old entrypoints and all affected static/dynamic consumers, exports, configuration, installed paths, fixtures and current documentation; return the migration/removal scope and evidenced compatibility exceptions. Historical names alone do not authorize new aliases. Use the language lifecycle and replacement rules linked from model continuity.

Report evidence when current glossary meaning diverges from observed model responsibility/lifecycle, or synonyms/overloaded names obscure ownership, even if no term is already marked retired. Return facts and affected terms to the design parent; the researcher does not choose future business meaning or approve a rename.

- When the Graphify navigation connector is available, use it first to locate relevant modules, symbols, and dependency edges.
- Treat Graphify as a navigation index only; verify every concrete claim against the actual source and tests.
- Supplement incomplete or unavailable Graphify results with repository-local `rg`/`find` searches.
- Do not create or persist a separate repository map, cache, or derived source index for this workflow.

## Agent execution

Run the research in one subagent instead of inspecting the whole codebase inline.

- Use `multi_agent_v1.spawn_agent` with the `code_researcher` agent profile when available.
- Resolve `.codex/harness.yaml` `agents.low_performance_model` to an actual model ID and pass it explicitly to `multi_agent_v1.spawn_agent`. Fall back to `agents.default_model` only for older configurations.
- If no model resolves, stop and require `setup`; never omit the override or inherit the parent model. The `code_researcher` profile owns its fixed `medium` reasoning effort.
- A user-specified supported model for the current request overrides both defaults.
- Keep reasoning effort modest unless the user explicitly requests deeper reasoning.
- Use `fork_context: false`.
- Keep the main agent responsible for reading the result, checking it against the current request, and deciding what to pass into the next skill.

Use this prompt for the subagent:

```text
You are the code-research subagent.

Work in the current repository. Inspect only the code and tests needed to answer the research request. Do not edit files. Do not make product or architecture decisions.

Return a compact architecture-focused report with these sections:

1. Current Structure
2. Entry Points And Boundaries
3. Relevant Source And Test Seams
4. Persistence, Adapter, And Integration Touchpoints
5. Mismatches Against Target Design
6. Structural Risks
7. Follow-up Areas For codebase-design

For every concrete claim, include file paths. Keep the report short and factual.
```

## What it leaves out

- implementation drafting
- redesign decisions
- long narrative explanations
- anything that is already obvious from the target design

## Output

- a short codebase summary
- a list of mismatches against the target design
- a list of structural risks
- a list of files or areas that need follow-up in `codebase-design`

실행 전제에 영향이 있는 조사에서는 실제 entrypoint/config loader/compose·infra/CI를 EXEC에 대조한다. 명시적 최종 사용자 흐름 E2E가 있다면 해당 `purpose: "e2e"` profile도 검토해 필수 인자·설정·인프라 누락을 보고한다. 일반 검증 명령은 기본 CLI로 기록한다.
