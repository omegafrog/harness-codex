# harness-post-harvest-orchestrator Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-post-harvest-orchestrator/SKILL.md`

---

name: harness-post-harvest-orchestrator
description: Run the complete ChangeSet-based harness workflow after harvest has produced requirements and use cases. Use to orchestrate ChangeSet creation, affected use-case selection, use-case scoped event storming, DDD design, technical decisions, E2E goal approval, use-case planning, execution, verification, remediation loops, project wiki updates, ChangeSet completion, and target-repository PR creation.

---

# Harness Post-Harvest Orchestrator

## Agent Context Bootstrap

Before post-harvest orchestration in a new target repository, ensure repo-local
agent context exists:

```bash
python3 -m harness_codex agent-context init --description "<repo description>"
```

If an existing unmarked `AGENTS.md` is present, the bootstrap preserves it and
stores harness context under `docs/agent/`. During orchestration, read the
smallest relevant `docs/agent/` file and avoid broad context dumps.

## Purpose

Run the ChangeSet-based post-harvest orchestration flow for harness engineering.

This skill assumes harvest has already produced the initial product/design inputs. It does not replace the specialist skills. It invokes them in order, validates each handoff artifact, and routes each affected use case through its own planning, execution, verification, and remediation loop.

## Gate Summary

- Run `$harness-project-wiki` after verified work-item plans complete.
- A missing or failed wiki output blocks ChangeSet completion.
- Validate the wiki with `./harness run wiki build`.
- Run `$harness-change-set-pr` only after ChangeSet completion succeeds.

## Reference Map

Load only the reference needed for the current step. Content was split from this file without semantic changes.
- gates.md: ## Harvest Assumption to ## Orchestration Flow.
- orchestration-flow.md: ## Orchestration Flow to ## Technical Decision Gate.
- technical-decision-gate.md: ## Technical Decision Gate to ## Failure Routing.
- failure-routing.md: ## Failure Routing to ## Execution Rules.
- execution-rules.md: ## Execution Rules to ## Resume Rules.
- resume-rules.md: ## Resume Rules to ## Gate Checks.
- gate-checks.md: ## Gate Checks to ## Static Analysis Policy.
- static-analysis-policy.md: ## Static Analysis Policy to ## User-Facing Result.
- user-facing-result.md: ## User-Facing Result to EOF.
