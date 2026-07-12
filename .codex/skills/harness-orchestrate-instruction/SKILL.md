---
name: harness-orchestrate-instruction
description: Route one user instruction through the selected workflow and specialist subagents.
---

# Harness Orchestration Sequence

1. Read only the handoff's workflow path, current run root, canonical state, and declared artifacts.
2. Check the selected workflow step's `needs` and current step result. A new current run may have an empty `steps/` directory; route from active ChangeSet/state rather than blocking. When active ChangeSet, maintenance slice, and active plan exist, record earlier producers as resume state and route `review-work-item-plan`; do not require a current-run checkpoint or handoff before review.
3. For an agent step, select only its `agent_id`, `skill_id`, ChangeSet, and work item. Call the exact runtime specialist dispatcher; do not load specialist control planes, create XML, or call `spawn_agent`.
4. Read the dispatcher-created step-scoped `subagent-result.xml`. Require matching identity, delegate, and provenance before routing.
5. For a validator step, request only its exact workflow YAML command through runtime deterministic service. Read its verdict; runtime never chooses the next route.
6. Route from facts:
   - approved review → materialize declared scope → executor;
   - rejected review with canonical upstream answer → bounded planner repair → review again;
   - `verification_root_cause` → bounded planner repair with result evidence;
   - environment blocker → preserve checkpoint and resume only executor in the same session;
   - missing policy/conflicting upstream facts → owning producer; otherwise block.
7. After each specialist result, end that specialist. Specialists never communicate directly; step-scoped invocation/result XML is their durable handoff.
8. Complete only after declared gates pass. Return one Korean workflow status summary.

## Boundaries

- Current run root is the only `.harness/runs/<RUN-ID>` namespace. Do not search prior runs.
- Reuse a parent orchestration session only through `harness resume RUN-ID`; never create a duplicate nonterminal session.
- Do not create XML/XSD/report contracts beyond existing `subagent-invocation-v1` and `subagent-result-v1`.
