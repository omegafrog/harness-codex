---
name: implementation-guidance
description: Capture or reconcile durable implementation-only guidance from explicit user direction or settled Specs, with scope and provenance, and keep it separate from product and architecture contracts.
---

# implementation-guidance

The guidance file is plain Markdown so it can be read by different agent providers and tooling. Use this skill when a user gives a reusable implementation constraint during ordinary project work, or when a specification workflow identifies an explicit implementation preference in the request or settled answers. Do not turn inferred preferences, one-ticket requirements, or unresolved architecture choices into durable guidance.

## Record

Maintain `docs/agents/implementation-guidance.md` in the consumer project. The caller supplies `shared_guidance_root`: the absolute original project root (`return_root` for a managed worktree). Read and write the canonical file at `<shared_guidance_root>/docs/agents/implementation-guidance.md`, never a worktree-local copy. This keeps all linked worktrees on one live version. Create it from `references/template.md` when needed. Each entry must state its identifier, scope, instruction, rationale, source (user message or specification section), and update date. Record the user's meaning without adding a solution they did not choose. Keep product and architecture contracts authoritative for ticket-specific requirements and decisions.

When a new instruction conflicts with an existing entry, compare scope and source. Update or mark the old entry `superseded` with the replacing entry and date; do not silently keep both as active. Ask only when the user has not settled which rule applies. Specification and user-conversation workflows must write updates to `shared_guidance_root`, even when their ticket artifacts belong in a session worktree. Ordinary implementation workers only read the file; the workflow owner updates it when the user explicitly establishes reusable guidance.

## Read

Every implementation worker reads the canonical document before planning edits. The caller must pass `shared_guidance_root` and verify it resolves to the same Git common directory as `workspace_root`. Apply only entries whose scope matches the current project and change. If an entry conflicts with approved ticket requirements or design, report the conflict and stop for resolution; do not silently override either source.
