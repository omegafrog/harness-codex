"""Artifact manifest and report writer for workflow runs."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.models import RunMode, RunStatus


@dataclass(frozen=True)
class ArtifactManifest:
    """Paths for generated run and per-use-case artifacts."""

    run_id: str
    run_dir: Path
    run_report_json: Path
    run_report_md: Path
    events_path: Path
    use_case_artifacts: Mapping[str, Mapping[str, Path]] = field(default_factory=dict)


@dataclass(frozen=True)
class UseCaseReport:
    """Report for one affected use case."""

    uc_id: str
    active_plan_path: Path
    e2e_goal_path: Path
    change_set_path: Path
    status: RunStatus
    completed_plan_path: Path | None = None
    executor_status: str = ""
    verifier_status: str = ""
    commands_run: tuple[str, ...] = ()
    test_gate_result: str = ""
    remediation_count: int = 0
    blocker: str | None = None
    artifact_paths: Mapping[str, Path] = field(default_factory=dict)


@dataclass(frozen=True)
class RunReport:
    """Top-level report for one ChangeSet workflow run."""

    run_id: str
    change_set_id: str
    workflow_name: str
    mode: RunMode
    status: RunStatus
    affected_use_cases: tuple[str, ...]
    completed_use_cases: tuple[str, ...] = ()
    failed_use_cases: tuple[str, ...] = ()
    blocked_use_cases: tuple[str, ...] = ()
    current_use_case_id: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    report_paths: Mapping[str, Path] = field(default_factory=dict)
    artifact_paths: Mapping[str, Path] = field(default_factory=dict)
    use_case_reports: tuple[UseCaseReport, ...] = ()


class ReportWriter:
    """Write JSON and Markdown reports without running agents or shell."""

    def __init__(self, repo_root: Path | str) -> None:
        self.repo_root = Path(repo_root)

    def artifact_manifest(
        self,
        run_id: str,
        use_case_ids: tuple[str, ...],
    ) -> ArtifactManifest:
        run_dir = Path(".harness/runs") / run_id
        use_case_artifacts = {
            uc_id: {
                "report_json": run_dir / "use-cases" / uc_id / "report.json",
                "report_md": run_dir / "use-cases" / uc_id / "report.md",
                "executor_result": run_dir
                / "use-cases"
                / uc_id
                / "executor-result.json",
                "verifier_result": run_dir
                / "use-cases"
                / uc_id
                / "verifier-result.json",
                "remediation_history": run_dir
                / "use-cases"
                / uc_id
                / "remediation-history.md",
                "blocker": run_dir / "use-cases" / uc_id / "blocker.md",
                "executor_log": run_dir / "use-cases" / uc_id / "logs/executor.log",
                "verifier_log": run_dir / "use-cases" / uc_id / "logs/verifier.log",
            }
            for uc_id in use_case_ids
        }
        return ArtifactManifest(
            run_id=run_id,
            run_dir=run_dir,
            run_report_json=run_dir / "report.json",
            run_report_md=run_dir / "report.md",
            events_path=run_dir / "events.ndjson",
            use_case_artifacts=use_case_artifacts,
        )

    def write(self, report: RunReport) -> ArtifactManifest:
        manifest = self.artifact_manifest(report.run_id, report.affected_use_cases)

        self._write_json(manifest.run_report_json, _to_json(report))
        self._write_text(manifest.run_report_md, self._run_markdown(report))
        self._write_json(Path(".harness/runs") / report.run_id / "artifacts.json", _to_json(manifest))

        for use_case_report in report.use_case_reports:
            artifacts = manifest.use_case_artifacts[use_case_report.uc_id]
            self._write_json(artifacts["report_json"], _to_json(use_case_report))
            self._write_text(
                artifacts["report_md"],
                self._use_case_markdown(use_case_report),
            )
            if use_case_report.blocker:
                self._write_text(
                    artifacts["blocker"],
                    f"# Blocker {use_case_report.uc_id}\n\n{use_case_report.blocker}\n",
                )

        return manifest

    def _write_json(self, relative_path: Path, value: Mapping[str, Any]) -> None:
        path = self.repo_root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def _write_text(self, relative_path: Path, text: str) -> None:
        path = self.repo_root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def _run_markdown(self, report: RunReport) -> str:
        return "\n".join(
            [
                f"# Run Report {report.run_id}",
                "",
                f"- ChangeSet: {report.change_set_id}",
                f"- Workflow: {report.workflow_name}",
                f"- Mode: {report.mode.value}",
                f"- Status: {report.status.value}",
                f"- Affected UC: {', '.join(report.affected_use_cases)}",
                f"- Completed UC: {', '.join(report.completed_use_cases) or '-'}",
                f"- Failed UC: {', '.join(report.failed_use_cases) or '-'}",
                f"- Blocked UC: {', '.join(report.blocked_use_cases) or '-'}",
                "",
            ]
        )

    def _use_case_markdown(self, report: UseCaseReport) -> str:
        return "\n".join(
            [
                f"# Use Case Report {report.uc_id}",
                "",
                f"- Status: {report.status.value}",
                f"- Active plan: `{report.active_plan_path}`",
                f"- Completed plan: `{report.completed_plan_path or '-'}`",
                f"- E2E goal: `{report.e2e_goal_path}`",
                f"- ChangeSet: `{report.change_set_path}`",
                f"- Executor: {report.executor_status or '-'}",
                f"- Verifier: {report.verifier_status or '-'}",
                f"- Commands: {', '.join(report.commands_run) or '-'}",
                f"- Test gate: {report.test_gate_result or '-'}",
                f"- Remediation count: {report.remediation_count}",
                f"- Blocker: {report.blocker or '-'}",
                "",
            ]
        )


def _to_json(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, RunMode | RunStatus):
        return value.value
    if isinstance(value, tuple):
        return [_to_json(item) for item in value]
    if hasattr(value, "__dataclass_fields__"):
        return {key: _to_json(item) for key, item in asdict(value).items()}
    if isinstance(value, dict):
        return {key: _to_json(item) for key, item in value.items()}
    return value
