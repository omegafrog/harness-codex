from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import harness_codex.runtime as runtime_package
from harness_codex.runtime import dashboard_ddd_integration_patch as patch


def test_dashboard_projection_accepts_candidate_without_architecture_baseline(monkeypatch) -> None:
    calls: list[tuple[str, list[Path]]] = []
    dashboard = SimpleNamespace(
        _dashboard_stage_artifacts=lambda root, session, use_cases: {},
        _add_artifact=lambda artifacts, stage, root, paths: calls.append((stage, paths)),
    )
    monkeypatch.setattr(runtime_package, "dashboard_runtime_state", dashboard, raising=False)

    patch.apply_dashboard_ddd_integration_patch()
    dashboard._dashboard_stage_artifacts(
        Path("."),
        {"ddd_architecture": {"complete": True, "uc_ids": ["UC-001"]}},
        ("UC-001",),
    )

    assert calls == [
        (
            "ddd-architecture-definition",
            [Path("docs/use-cases/UC-001/ddd-design.md")],
        )
    ]
