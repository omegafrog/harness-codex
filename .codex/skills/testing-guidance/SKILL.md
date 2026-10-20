---
name: testing-guidance
description: Capture and reconcile project-specific testing and verification instructions from explicit user direction or settled test decisions, shared across all linked worktrees.
---

# testing-guidance

This guidance is plain Markdown and independent of agent provider or test framework. It records durable project-specific test execution preferences; exact commands and machine-checked startup requirements remain in `docs/agents/EXEC.md` and `docs/agents/execution.json`.

## Record

Maintain `docs/agents/testing-guidance.md`. The caller supplies `shared_guidance_root`: the absolute original project root (`return_root` for a managed worktree). Read and write the canonical file at `<shared_guidance_root>/docs/agents/testing-guidance.md`, never a worktree-local copy, so changes are immediately visible to every linked worktree. Create it from `references/template.md` when needed.

Record only explicit, reusable user preferences or settled lessons. Every entry includes scope, instruction, rationale, provenance and date. Keep test-specific failure analysis and prevention checks in the project's verification/lesson documents; link to them instead of duplicating incident details here. Mark replaced instructions as superseded rather than silently deleting their history. Only the workflow owner updates this file for explicit reusable guidance; ordinary test runners only read it.

## Read

Every test runner and implementation worker reads this canonical document before choosing or starting tests. Apply only matching entries. If it conflicts with an approved plan or execution contract, stop and report the conflict for resolution. The project execution profile remains authoritative for exact commands, configuration, dependencies and readiness.
