<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# code-research

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

The caller delegates this bounded task to `code_researcher` using the configured execution mechanism for the active workflow. Supply the research request and referenced inputs; do not require a separate Codex session or an independent execution command. The researcher inspects only relevant source and tests, does not edit files, make design decisions, invoke `code-research` recursively or spawn another agent, and returns only the Output sections plus blockers, with a file path for every concrete claim and the inspected commit. The caller reads the result and decides what to pass to the next skill.

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

`docs/agents/EXEC.md`와 `execution.json`은 실행·설정·인프라 요구가 조사 범위일 때만 읽으며, 두 파일이 없다는 것만으로 조사를 막지 않는다. 실행 전제에 영향이 있는 조사에서는 실제 entrypoint/config loader/compose·infra/CI를 EXEC에 대조해 빠진 인프라, 필수 flag·환경 변수, 생성된 설정의 stale 검증, 사용자 흐름 E2E 전용인 harness-exec로 잘못 보낸 일반 검증을 보고한다. 비어 있는 dependency/prepare 목록은 추측한 기본값이 아니라 source 근거가 필요하다. 명시적 최종 사용자 흐름 E2E가 있다면 해당 `purpose: "e2e"` profile도 검토해 필수 인자·설정·인프라 누락을 보고한다. 일반 검증 명령은 기본 CLI로 기록한다.
