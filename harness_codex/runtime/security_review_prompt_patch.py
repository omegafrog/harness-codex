"""Install a minimal prompt profile for bundle-scoped security reviewers."""

from __future__ import annotations

from typing import Any, Mapping


_PATCHED = "_harness_security_review_prompt_profile_applied"

_REVIEW_BUNDLE_INSTRUCTION = """You are running as a bounded reviewer.
Read only the runtime-declared review bundle. Treat its focused diff, evidence, security profile, and selected controls as the review authority.
Do not read ChangeSet documents, repository settings, full standards sources, long-term memory, or upstream design artifacts. Report a blocker when the bundle is insufficient rather than widening the read scope.
Write all agent input/output and user-facing output in Korean. Preserve code identifiers, file paths, JSON keys, CLI commands, protocol names, and approved canonical terms when compatibility requires their original form.
Report findings, evidence, and blockers clearly."""


def apply_security_review_prompt_patch() -> None:
    """Route `review-bundle-minimal` through a bounded prompt assembly path."""

    from harness_codex.runtime import prompt

    if getattr(prompt, _PATCHED, False):
        return

    original = prompt.build_agent_prompt

    def build_agent_prompt(
        *,
        step,
        context,
        agent_config: Mapping[str, Any],
        agent_config_path,
        skill_path=None,
        skill_body=None,
    ) -> str:
        if prompt._prompt_context_profile(step) != "review-bundle-minimal":
            return original(
                step=step,
                context=context,
                agent_config=agent_config,
                agent_config_path=agent_config_path,
                skill_path=skill_path,
                skill_body=skill_body,
            )
        payload = {
            "run_id": context.run_id,
            "work_item_id": context.metadata.get("active_work_item_id"),
            "step": {
                "id": step.id,
                "agent_id": step.agent_id,
                "inputs": [str(path) for path in step.inputs],
                "outputs": [str(path) for path in step.outputs],
            },
            "required_reads": [str(path) for path in step.inputs],
            "explicitly_excluded_context": [
                "ChangeSet body",
                "workflow definition",
                "repository source-of-truth previews",
                "repository settings",
                "full OWASP standards source",
                "long-term memory",
                "upstream design artifacts",
            ],
        }
        sections = [
            prompt._section("1. Runtime Instruction", _REVIEW_BUNDLE_INSTRUCTION),
            prompt._section(
                "2. Delegation Contract",
                prompt._delegation_contract(
                    step,
                    agent_config,
                    agent_config_path,
                    skill_path,
                    context.repo_root,
                ),
            ),
            prompt._section(
                "3. Focused Review Bundle",
                "\n".join(["```json", prompt._stable_json(payload), "```"]),
            ),
        ]
        return "\n\n".join(sections).rstrip() + "\n"

    prompt.build_agent_prompt = build_agent_prompt
    try:
        from harness_codex.runtime import runner

        if getattr(runner, "build_agent_prompt", None) is original:
            runner.build_agent_prompt = build_agent_prompt
    except ImportError:
        pass
    setattr(prompt, _PATCHED, True)
