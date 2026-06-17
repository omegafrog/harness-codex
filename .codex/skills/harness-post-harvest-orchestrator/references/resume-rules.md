## Resume Rules

When artifacts already exist:

- If `docs/changes/active/<CHG-ID>.md` exists and the user did not ask to regenerate it, treat ChangeSet creation as complete and validate the affected UC list before continuing.
- If `docs/use-cases/<UC-ID>/event-storming.md` exists for an affected UC and the user did not ask to regenerate it, treat that UC event-storming stage as complete.
- If `docs/use-cases/<UC-ID>/ddd-design.md` exists for an affected UC and the user did not ask to regenerate UC DDD design, treat that UC DDD stage as complete.
- If `docs/use-cases/<UC-ID>/technical-decisions.md` exists for an affected UC and the user did not ask to regenerate technical decisions, treat that UC technical-decision stage as complete.
- If `docs/use-cases/<UC-ID>/e2e-goal.md` exists for every affected UC, still require user approval before planning unless approval is already recorded.
- If `docs/plans/active/<UC-ID>/plan.md` exists for an affected UC and the user did not ask to regenerate that UC plan, treat that UC planning stage as complete.
- If `docs/plans/completed/<UC-ID>/plan.md` exists for an affected UC, treat that UC as complete unless the active ChangeSet includes a newer delta for the same UC.
- If `docs/wiki/index.md` contains a Change History entry for the active ChangeSet,
  `mkdocs.yml` exists, `./harness run wiki build` passes, and no affected artifact is newer,
  treat the wiki stage as complete.
- If the user asks to regenerate a stage, regenerate that stage and every downstream stage because downstream artifacts may be stale.

