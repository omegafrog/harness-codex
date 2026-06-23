"""Runtime policy for post-validating writes made by agent steps.

Every agent step in a Git worktree receives a role-derived write policy.  Document,
review, and analysis agents may modify only their workflow-declared outputs and
runtime artifacts.  The implementation executor additionally receives the
ChangeSet/work-item implementation scope evaluated by ``validate_scope_diff``.
"""

from __future__ import annotations

import hashlib
import os
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
    original_scope_patterns = scope_module._scope_patterns

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

    def scope_patterns(
        *,
        repo_root: Path,
        change_set_id: str,
        work_item_id: str,
        metadata: Mapping[str, Any],
        runtime_allow_patterns,
    ):
        if metadata.get(_POLICY_METADATA_KEY) == DECLARED_OUTPUTS_ONLY.name:
            return tuple(runtime_allow_patterns), ()
        return original_scope_patterns(
            repo_root=repo_root,
            change_set_id=change_set_id,
            work_item_id=work_item_id,
            metadata=metadata,
            runtime_allow_patterns=runtime_allow_patterns,
        )

    scope_module.capture_git_snapshot = _capture_filesystem_snapshot
    runner_module.capture_git_snapshot = _capture_filesystem_snapshot
    scope_module._scope_patterns = scope_patterns
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


def _capture_filesystem_snapshot(repo_root: Path) -> dict[str, dict[str, str | None]]:
    """Snapshot all files except Git internals, including ignored files.

    Comparing two complete snapshots means pre-existing dirty files remain outside
    the validation delta while a file newly changed by the agent is always visible.
    """

    snapshot: dict[str, dict[str, str | None]] = {}
    if not repo_root.exists():
        return snapshot

    for root, directories, filenames in os.walk(repo_root, followlinks=False):
        directories[:] = sorted(
            directory for directory in directories if directory != ".git"
        )
        root_path = Path(root)
        for filename in sorted(filenames):
            path = root_path / filename
            relative = str(path.relative_to(repo_root))
            snapshot[relative] = {
                "path": relative,
                "state": _filesystem_state(path),
                "sha256": _filesystem_sha256(path),
            }
    return snapshot


def _filesystem_state(path: Path) -> str:
    if path.is_symlink():
        return "symlink"
    if path.is_file():
        return "file"
    return "missing"


def _filesystem_sha256(path: Path) -> str | None:
    digest = hashlib.sha256()
    try:
        if path.is_symlink():
            digest.update(os.readlink(path).encode("utf-8"))
            return digest.hexdigest()
        if not path.is_file():
            return None
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None
