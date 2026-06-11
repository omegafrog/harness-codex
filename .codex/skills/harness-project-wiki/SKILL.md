---
name: harness-project-wiki
description: Create or update a harness-implemented project's MkDocs Material wiki from verified implementation, completed plans, ChangeSet artifacts, use-case slices, architecture, and operational scripts. Use after affected work items pass verification, when a project needs its initial MkDocs wiki, or when a completed ChangeSet requires existing docs/wiki pages and navigation to be refreshed before ChangeSet completion.
---

# Harness Project Wiki

## Hot Path

- Delegate to the configured `wiki_curator` agent.
- Read `.codex/skills/harness-project-wiki/references/detailed-instructions.md`.
- Use `.codex/skills/harness-project-wiki/assets/` as the MkDocs baseline.
- Require an active ChangeSet and completed plans for every affected work item.
- Create and maintain `mkdocs.yml`, `docs/wiki/`, and wiki scripts.
- Create `docs/wiki/index.md` when no project wiki exists.
- Update existing pages incrementally; preserve unrelated user-authored content.
- Treat verified code, tests, and runtime behavior as current truth.
- Install pinned MkDocs dependencies into the repository-root `venv`.
- Run `./harness run wiki build` before reporting success.
- Stop on missing verification evidence or material source conflicts.
