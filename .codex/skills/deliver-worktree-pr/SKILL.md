---
name: deliver-worktree-pr
description: Execute a repository task end to end in a fresh HEAD-based Git worktree, then verify, commit, push, open a pull request, and check merge conflicts. Use when the user asks Codex to implement instructions and deliver a PR, especially when UI changes require Playwright screenshot evidence.
---

# Deliver Worktree PR

Complete the task through PR creation. Do not stop after planning or implementation.

## Workflow

1. Read the target repository's applicable `AGENTS.md` and smallest relevant context.
2. Invoke `$start-head-worktree` before modifying files.
3. Continue all task work in the created worktree and report its path, branch, and base SHA.
4. Inspect existing code and tests, then implement the requested behavior without overwriting unrelated changes.
5. Detect whether the diff includes user-visible UI behavior or assets.
6. Run focused tests, required repository checks, and any broader checks justified by the change.
7. Review `git diff --stat`, targeted diffs, and `git status`.
8. Commit with a message that follows repository instructions, push the branch, and open a PR.
9. Verify local and GitHub merge-conflict state. Resolve conflicts when safe, rerun verification, and update the PR.
10. Report PR URL, verification, conflict status, and screenshot evidence when applicable.

## UI Screenshot Gate

Treat changes to pages, components, styles, browser interactions, or rendered user-visible output as UI work.

For UI work:

- Start the required local server using repository commands.
- Use Playwright to exercise the implemented state in a real browser.
- Capture at least one screenshot showing the changed behavior.
- Check browser console and page errors while capturing evidence.
- Save screenshots in the repository's designated artifact location. If none exists, save them outside tracked source files and report the absolute path.
- Do not claim UI verification without a successfully written screenshot.

Skip this gate only when the final diff has no UI-related implementation. State that it was not applicable.

## PR Requirements

- Follow repository language and formatting rules for commit messages, code comments, documents, and PR text.
- Derive PR base from the source branch used by `$start-head-worktree`.
- Include implementation intent, approach, verification, risks, and rollback unless stricter repository instructions apply.
- Keep generated screenshots out of the commit unless repository conventions require them.
- Use a non-interactive CLI or connected GitHub tooling.

## Conflict Verification

After pushing and opening the PR:

1. Fetch the latest PR base branch.
2. Run a non-mutating local trial merge:

```bash
git fetch origin <base-branch>
git merge-tree --write-tree HEAD origin/<base-branch>
```

3. Check GitHub state:

```bash
gh pr view <pr-number-or-url> --json mergeable,mergeStateStatus
```

4. If GitHub returns an indeterminate state, wait briefly and retry.
5. Treat local merge-tree conflicts or GitHub `CONFLICTING` state as failure.
6. Rebase or merge the latest base only when consistent with repository policy. Resolve deliberately, rerun tests, force-push only with `--force-with-lease`, then repeat both checks.

Do not modify or remove the source worktree. Keep the task worktree unless the user explicitly requests cleanup.
