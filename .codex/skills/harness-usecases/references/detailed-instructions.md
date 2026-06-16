# harness-usecases Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-usecases/SKILL.md`

---
name: harness-usecases
description:
  Use after requirements and context.md exist to turn confirmed requirements
  into external-actor use cases and runtime-ready use-case slice documents.
---

# Harness Use Cases

## Purpose

This skill turns confirmed requirements into both the canonical use case document and runtime-ready use case slice documents.

Responsibilities are split as follows.

- `harness-requirements`: writes `docs/design/요구사항.md` and the project-wide language source `context.md`.
- `harness-usecases`: validates requirements and ubiquitous language readiness, then writes `docs/design/유스케이스.md` plus `docs/use-cases/<UC-ID>/use-case.md` and `docs/use-cases/<UC-ID>/e2e-goal.md` for every harvested use case.

If requirements do not exist, if `context.md` does not exist, if core ubiquitous
language is unresolved, or if core business policy decisions remain unresolved,
stop and ask the user to run `$harness-requirements` first. Do not invent missing
requirements or missing domain terms.

When this skill is invoked, delegate the work to the dedicated agent defined in
`.codex/agents/harness_usecases.toml`. If the dedicated agent cannot be found
or cannot run, do not perform a fallback implementation. Explain the reason and
stop.


## Reference Map

Load only the reference needed for the current step. Content was split from this file without semantic changes.
- standards.md: ## Embedded Standards to ## Invocation.
- invocation.md: ## Invocation to ## Interactive Runtime Contract.
- runtime-contract.md: ## Interactive Runtime Contract to ## Use Case Document Template.
- templates.md: ## Use Case Document Template to EOF.
