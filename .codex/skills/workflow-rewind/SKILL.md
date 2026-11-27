---
name: workflow-rewind
description: Safely return an active Harness workflow to a named stage when the user asks to revisit, correct or redo that stage. Use only inside the selected workflow worktree; preserve prior artifacts and use the runner's revision and stale-stage controls.
main_session: true
---

# Workflow Rewind

Return an active Harness workflow to the stage the user names, without manually changing execution state or deleting artifacts. This skill is for an explicit request to revisit a stage. It does not handle ordinary answers, approvals, a dependency block, or a new workflow.

## Procedure

1. Run `node .harness/scripts/harness-context.mjs --entry` in the current workspace. Follow the orchestrator's worktree selection rule first if this is the primary checkout and linked worktrees exist. Never dispatch a stage into a different worktree from the current conversation.
2. Confirm that the context belongs to the active workflow and that the requested stage ID is an exact stage in its flow. Use the stage ID from the workflow state/map; do not infer a stage from a document filename. If the user names a stage informally and it maps to more than one stage, ask which stage they mean.
3. Classify the user's intent from meaning:
   - If a stage has an unanswered question and the user is answering it, route the answer to that stage. Do not rewind.
   - If the user approves a completed result, route the approval. Do not rewind.
   - If the user asks to change or redo a completed stage, preserve their exact instruction as revision feedback and use the normal user-revision route.
   - When the user names a destination stage, treat “돌아가”, “되돌려”, “다시 열어” and similar wording as a forward user revision of that stage. Use `--user-revision true` with the user's exact instruction, even when they do not provide a separate content edit; the stage can resume from its existing result and ask for any missing direction. **Never use `--restart-requirements` for a named-stage return.**
   - `--restart-requirements true` is a destructive restore path, not a way to reopen one stage. It may be used only when the user explicitly asks to discard/restore later requirements-stage work, without naming a stage as a revision target, and only when the runner confirms its commit-scope and clean-worktree guards. “되돌리기” by itself never authorizes it.
4. Check whether the runner supports user revision for the requested stage. Prefer the orchestrator's result and `next` guidance. The supported set is limited to the requirements revision stages, tactical design stages, `to-ticket`, and the special `implement-wrapper` repair path. If the requested stage is not supported, do not emulate it with a plain launch, state edit, commit reset, document deletion, or requirements restart. Tell the user the runner refused or does not support revising that stage and report the safe next option from its `next`/`user_decision`.
5. Before launching, ensure no stage is still running and resolve any current block or unanswered decision through its own route. The runner enforces these constraints; do not bypass a refusal. For a supported completed-stage change, use the user's exact words:
   - Codex: `node .harness/scripts/harness-native-stage.mjs launch --stage-id <stage-id> --user-revision true --feedback '<verbatim user instruction>'` (use the orchestrator's established argument handling for long or quoted text).
   - Claude Code: route `harness-stage: revise <stage-id>` with the user's exact instruction to the workflow orchestrator.
6. Follow the returned `next` exactly. Do not launch downstream stages manually. When the revised stage completes, show its returned summary and artifacts and wait for the user's approval. Then process stale downstream stages in runner order, showing and obtaining approval for each stage before continuing. Do not reuse an approval granted to an earlier result.
7. If the user only says “rerun” and gives no change instruction, do not invent feedback. Check the stage's supported resume path and ask what should change when the runner requires user revision. If no safe resume route exists, explain that and stop without changing workflow state.

## Safety boundaries

- Never edit Harness session/state files, stage records, result envelopes, or checkpoint files directly.
- Never delete, reset, or overwrite prior documents, commits, answers, approvals, or artifacts to simulate returning to a stage.
- `--reopen-for` is only for the exact later `blocked / DEPENDENCY_INCOMPLETE` execution that names the earlier owner. Follow the block's `next`; do not use it for a user-requested revision.
- `--restart-requirements` is destructive and separate from a forward revision. A request with a named stage always uses the forward revision route; never fall back to restart if revision is refused.
- If a guard refuses the transition, stop and report its `why`, `next`, and `user_decision`. Do not keep trying variants or guess a different stage.
