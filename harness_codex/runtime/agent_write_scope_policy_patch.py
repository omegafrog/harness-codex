"""Runtime policy for post-validating writes made by agent steps.

Every agent step in a Git worktree receives a role-derived write policy. Document,
review, and analysis agents may modify only their workflow-declared outputs and
runtime artifacts. The implementation executor additionally receives the
ChangeSet/work-item implementation scope evaluated by ``validate_scope_diff``.
"""

from __future__ import annotations

import hashlib
import subprocess
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Mapping


_POLICY_METADATA_KEY = "_agent_write_scope_policy"
_DECLARED_PATHS_METADATA_KEY = "_agent_write_scope_declared_paths"


@dataclass(frozen=True)
class AgentWriteScopePolicy:
    """Role-derived permissions for one agent step."""

    name: str
    include_work_item_scope: bool


DECLARED_OUTPUTS_ONLY = AgentWriteScopePolicy(
    name="declared_outputs",
    include_work_item_scope=False,
)
IMPLEMENTATION_SCOPE = AgentWriteScopePolicy(
    name="implementation_scope",
    include_work_item_scope=True,
)


def derive_agent_write_scope_policy(step: Any) -> AgentWriteScopePolicy:
    """Return the runtime-owned policy for ``step``.

    Workflow outputs are declarations, not instructions supplied by the agent.
    Only the executor is allowed to extend those declarations with the separate
    ChangeSet/work-item implementation scope.
    """

    if getattr(step, "agent_id", None) == "implementation_executor":
        return IMPLEMENTATION_SCOPE
    return DECLARED_OUTPUTS_ONLY


def apply_agent_write_scope_policy_patch() -> None:
    """Install generic scope validation without duplicating the main runner."""

    from harness_codex.runtime.models import StepKind
    import harness_codex.runtime.runner as runner_module
    import harness_codex.runtime.validate_scope_diff as scope_module

    BasicStepRunner = runner_module.BasicStepRunner
    if getattr(BasicStepRunner, "_agent_write_scope_policy_patch_applied", False):
        return

    original_run_agent = BasicStepRunner._run_agent
    original_scope_policy = scope_module._scope_policy

    def run_agent(self, step, context, step_dir: Path):
        if step.kind != StepKind.AGENT or not _inside_git_work_tree(context.repo_root):
            return original_run_agent(self, step, context, step_dir)

        policy = derive_agent_write_scope_policy(step)
        scoped_step = replace(
            step,
            metadata={
                **dict(step.metadata),
                _POLICY_METADATA_KEY: policy.name,
            },
        )
        scoped_context = replace(
            context,
            metadata={
                **dict(context.metadata),
                _POLICY_METADATA_KEY: policy.name,
                _DECLARED_PATHS_METADATA_KEY: _declared_write_paths(step),
            },
        )
        return original_run_agent(self, scoped_step, scoped_context, step_dir)

    def requires_scope_diff_validation(step) -> bool:
        return (
            step.kind == StepKind.AGENT
            and bool(step.metadata.get(_POLICY_METADATA_KEY))
        )

    def runtime_scope_allow_patterns(context, step_dir: Path):
        patterns = [
            scope_module.ScopePattern(
                str(runner_module._relative_to_repo(step_dir, context)) + "/",
                "runtime step artifacts",
            ),
            scope_module.ScopePattern(
                str(runner_module._relative_to_repo(context.run_dir, context)) + "/",
                "runtime run artifacts",
            ),
            scope_module.ScopePattern(
                ".harness/cache/prompt-context/",
                "runtime prompt context cache",
            ),
            scope_module.ScopePattern(
                ".harness/ui-server.log",
                "runtime UI server log",
            ),
        ]
        for raw_path in context.metadata.get(_DECLARED_PATHS_METADATA_KEY, ()):
            normalized = str(Path(str(raw_path)))
            if not normalized:
                continue
            pattern = normalized + "/" if _declares_directory(normalized) else normalized
            patterns.append(
                scope_module.ScopePattern(pattern, "declared agent output")
            )
        return tuple(patterns)

    def scope_policy(
        *,
        repo_root: Path,
        change_set_id: str,
        work_item_id: str,
        metadata: Mapping[str, Any],
        runtime_allow_patterns,
    ):
        if metadata.get(_POLICY_METADATA_KEY) == DECLARED_OUTPUTS_ONLY.name:
            return scope_module.ScopePolicy(
                runtime_allow=tuple(runtime_allow_patterns),
                changeset_allow=(),
                manifest_allow=(),
                blocked=(),
            )
        return original_scope_policy(
            repo_root=repo_root,
            change_set_id=change_set_id,
            work_item_id=work_item_id,
            metadata=metadata,
            runtime_allow_patterns=runtime_allow_patterns,
        )

    scope_module.capture_git_snapshot = _capture_worktree_snapshot
    runner_module.capture_git_snapshot = _capture_worktree_snapshot
    scope_module._scope_policy = scope_policy
    runner_module._requires_scope_diff_validation = requires_scope_diff_validation
    runner_module._runtime_scope_allow_patterns = runtime_scope_allow_patterns
    BasicStepRunner._run_agent = run_agent
    BasicStepRunner._agent_write_scope_policy_patch_applied = True


def _declared_write_paths(step: Any) -> tuple[str, ...]:
    values = [str(path) for path in getattr(step, "outputs", ())]
    bootstrap_outputs = getattr(step, "metadata", {}).get("bootstrap_outputs", ())
    if isinstance(bootstrap_outputs, (list, tuple)):
        values.extend(str(path) for path in bootstrap_outputs)
    return tuple(dict.fromkeys(value for value in values if value))


def _declares_directory(path: str) -> bool:
    # Workflow declarations use a suffix-less path for directory outputs (for
    # example ``docs/use-cases``), while normal file outputs retain their suffix.
    return not Path(path).suffix


def _inside_git_work_tree(repo_root: Path) -> bool:
    completed = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    return completed.returncode == 0 and completed.stdout.strip() == "true"


def _capture_worktree_snapshot(repo_root: Path) -> dict[str, dict[str, str | None]]:
    """Snapshot all changed worktree files, including ignored files.

    The two snapshots delimit the agent's own delta, so pre-existing dirty paths are
    not validated. The ignored-file listing closes the previous ``.gitignore`` bypass.
    """

    if not _inside_git_work_tree(repo_root):
        return {}

    snapshot: dict[str, dict[str, str | None]] = {}
    for path in sorted(_git_changed_paths_including_ignored(repo_root)):
        absolute = repo_root / path
        snapshot[path] = {
            "path": path,
            "state": _file_state(absolute),
            "sha256": _sha256(absolute),
        }
    return snapshot


def _git_changed_paths_including_ignored(repo_root: Path) -> set[str]:
    """Return raw Git pathnames, including ignored files, without quote escaping."""

    paths: set[str] = set()
    commands = (
        ["git", "diff", "--name-only", "-z"],
        ["git", "diff", "--name-only", "--cached", "-z"],
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        ["git", "ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    )
    for command in commands:
        completed = subprocess.run(
            command,
            cwd=repo_root,
            text=True,
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            continue
        paths.update(path for path in completed.stdout.split("\0") if path)
    return paths


def _file_state(path: Path) -> str:
    if path.is_file():
        return "file"
    if path.is_dir():
        return "directory"
    return "missing"


def _sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()
