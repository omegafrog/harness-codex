---
name: harness-ddd-design
description: >
  Use after event storming exists to derive one use-case-scoped candidate DDD
  design and cumulative Mermaid architecture visualization without generating code.
  The candidate is later reconciled by harness-ddd-integration before downstream
  stages may treat it as canonical. Also use for the harness
  ddd-architecture-definition runtime command.
---

# Harness DDD Design

## Hot Path

- Use this skill only for the workflow described in the frontmatter.
- Read `.codex/skills/harness-ddd-design/references/detailed-instructions.md` before making workflow decisions or producing required artifacts.
- Read additional files named by the detailed reference only when the current task needs them.
- Treat `docs/use-cases/<UC-ID>/ddd-design.md` as a candidate, not the shared Aggregate contract.
- Keep one cumulative Mermaid architecture visualization inside that candidate document; do not create separate diagram artifacts.
- Do not write `ARCHITECTURE.md`; only `harness-ddd-integration` may promote an accepted shared-model delta.
- 기술 stack 선택은 DDD 설계를 막지 않는다. 구현 저장소·메시징·배포 선택은 technical-decisions 단계로 넘긴다.
- Keep writes inside the scope declared by the caller or runtime payload.
- Preserve unrelated worktree changes.
- Stop and report the blocker when required inputs, approvals, or scope are missing.
- Report changed files, verification commands, and blockers clearly.
