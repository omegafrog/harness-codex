---
name: harness-ddd-integration
description: >
  Use after every affected use-case has a candidate DDD design to reconcile those
  candidates into one ChangeSet-level canonical DDD contract. The skill never
  writes implementation code and blocks rather than guessing unresolved domain
  policy.
---

# Harness DDD Integration

## Hot Path

- Use this skill only for the ChangeSet-level `ddd-design-integration` stage.
- Read `.codex/skills/harness-ddd-integration/references/detailed-instructions.md` before integrating candidate designs.
- Run the `ddd_design_integrator` agent; do not substitute a candidate DDD agent.
- Read every affected use-case candidate, its Event Storming evidence, `context.md`, and existing `ARCHITECTURE.md` when present.
- Write only the ChangeSet integration artifacts and, for an accepted shared-model delta, `ARCHITECTURE.md`.
- Do not generate code, tests, plans, technical decisions, or diagrams.
- Stop and return a routed blocker when the conflict is not resolved by approved upstream evidence.
