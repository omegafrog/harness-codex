---
name: harness-artifact-reviewer
description: Review a single critical harness workflow artifact, such as plan.md or technical-decisions.md, before a downstream agent consumes it. Writes one review report and uses an explicit Review Status gate.
---

# Harness Artifact Reviewer

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/agents/references/artifact_reviewer.md` before making workflow decisions or producing required artifacts.
- Read additional files only when named by the runtime payload or required to verify a cited input.
- Keep writes inside the single review output declared by the runtime payload.
- Consume existing `subagent-invocation.xml` and declared document artifacts only. Assess only declared `reviewTask` criteria, return one matching `subagent-result.xml`, then terminate; do not implement fixes or choose remediation.
- Preserve unrelated worktree changes.
- Write `Review Status: approved` only when downstream execution can proceed.
- Write `Review Status: rejected` when any blocking finding remains.
- For plan review, treat old execution evidence as out of scope unless the runtime payload explicitly asks for a repair review based on that evidence.
