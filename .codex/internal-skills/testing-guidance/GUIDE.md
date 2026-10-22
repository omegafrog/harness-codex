<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# testing-guidance

This guidance is plain Markdown and independent of agent provider or test framework. It records durable project-specific test execution preferences; exact commands and machine-checked startup requirements remain in `docs/agents/EXEC.md` and `docs/agents/execution.json`.

## Record

Maintain `docs/agents/testing-guidance.md`. The caller supplies `shared_guidance_root`: the absolute original project root (`return_root` for a managed worktree). Read and write the canonical file at `<shared_guidance_root>/docs/agents/testing-guidance.md`, never a worktree-local copy, so changes are immediately visible to every linked worktree. Create it from `references/template.md` when needed.

Record explicit reusable user preferences and settled lessons from completed workflow evidence. After an E2E failure is diagnosed, the workflow owner must decide whether it reveals a reusable project testing procedure: repeated causes and confirmed cross-run setup mistakes must update this canonical file when the prevention action is a durable instruction. The owner must follow the E2E failure-learning route and link its incident lesson and execution contract. Every entry includes scope, instruction, rationale, provenance and date. Keep incident-specific failure analysis in the project's verification/lesson document and exact commands/configuration in both `docs/agents/EXEC.md` and `docs/agents/execution.json`, with the executable profile values in JSON and operator procedure/readiness rationale in Markdown. When one changes, reconcile the other. For a reusable failure-prevention procedure, update this guidance as well and link to those contracts instead of duplicating their exact values. Do not convert an unverified hypothesis into guidance. Mark replaced instructions as superseded rather than silently deleting their history. The workflow owner maintains this file; ordinary test runners only collect evidence and do not edit guidance.

## Read

Every test runner and implementation worker reads this canonical document before choosing or starting tests. Apply only matching entries. If it conflicts with an approved plan or execution contract, stop and report the conflict for resolution. The project execution profile remains authoritative for exact commands, configuration, dependencies and readiness.

For scoped Spring Boot diagnostic logging changes, use the project-owned `docs/observability/victorialogs/diagnostic-log-schema.md` and JSON schema. The installed `victorialogs-local-setup` assets supply the v1 contract; its setup helper records the matching reusable guidance in the canonical shared documents. Keep general framework logs distinct from diagnostic events. Do not claim source schema validation proves runtime context propagation, redaction or live ingestion.
