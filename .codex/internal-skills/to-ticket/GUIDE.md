# to-ticket

`execution_id`를 받은 호출은 해당 stage 파일에 지정된 작업을 수행하고 결과 파일과 공통 envelope를 반환한다.

## Plan authoring stage

The canonical entrypoint is `.codex/internal-skills/to-ticket/GUIDE.md`, already supplied by the runner. Do not require or search for a public `skills/to-ticket/SKILL.md` copy. `AGENTS.md` and `docs/agents/EXEC.md` provide project guidance when present; their absence or empty content is not a plan-authoring prerequisite. Do not return `DEPENDENCY_INCOMPLETE`, invoke setup, or create filler guidance solely for those files. Preserve the actual workspace identity, approved Spec/review, decision evidence and planning gates. Describe necessary implementation/runtime preparation in the plans; actual service/E2E launch readiness is checked when that execution begins.

The static runner supplies `context.execution_workspace`. Do not author workspace paths or branch metadata in plans or tracker drafts; the publication input preparer generates execution metadata and body file paths.

`to-ticket` owns plan authoring and its independent review loop. Use [split](references/split.md) on the initial invocation and [revision](references/revision.md) to address findings. It calls a fresh native `plan_reviewer` subagent itself, records the attempt through `harness-plan-review.mjs`, revises plans when needed, and repeats with a different fresh reviewer. It returns `completed/OK` only after `check --phase planning` confirms the canonical review is current and passing. Plan review is never handed to the main orchestrator as `REVIEW_REQUIRED`; actual user decisions use `USER_DECISION_REQUIRED`.

When the user explicitly asks to restart a waiting or failed `to-ticket` stage from its completed `spec-me`, prepare a fresh stage input with `node .codex/scripts/harness-prepare-input.mjs --worktree-ref <canonical-worktree.json> --stage-id to-ticket --restart true`. The runner accepts this only in the active matching worktree, while `spec-me` is completed and tracker-publish has never started. It archives the prior plan set, review history, and `runtime/to-ticket` artifacts under `.io/runtime/restarts/`; execution history and Specs remain in place. Never use restart to bypass a running stage or reviewer.

- Write canonical plans from the approved Specs, then execute the review loop in this stage. A plan carries a rule at the Spec's stated precision and never adds or tightens one. Ask the user only when a necessary decision cannot be resolved from the approved Specs.
- A `revise` verdict causes a scoped plan revision and a new attempt with a new reviewer. Preserve the configured three substantive-attempt limit; after it is reached, return the concrete unresolved decision to the user. User answers do not count as a review pass.
- Before authoring, read `worktree.json` from the supplied `session_directory` and the supplied Product and Architecture Specs, plan-set scope, tracker contract, repository conventions and diagram inventory.
- Keep every split plan vertical, with explicit dependencies and resources, inside the approved plan-set boundary. Preserve approved decisions and stable IDs. When asked to add or tighten a rule only in a plan, even with an approval, return `SPEC_REVISION_REQUIRED` so the Spec changes first.
- Use the configured tracker helpers or connector; do not handcraft API payloads or duplicate canonical tracker state. Report created or rendered artifacts, dependency/resource evidence, validation results and blockers.
- A `pass` verdict completes plan authoring only after the current snapshot check. The orchestrator requests final user approval of the reviewed plan set before dispatching the separate `tracker-publish` workflow stage. This skill never publishes to the tracker or Beads.

The following publisher is a separate workflow stage, not a nested subagent or an action performed by the orchestrator main session. It owns tracker/Beads publication and returns the final receipt.

The orchestrator presents real user questions and preserves actual answers. A user answer resolves only the asked decision; it does not make a review pass. Standalone use follows the same split → internal independent review → revision when needed and completion gate.
