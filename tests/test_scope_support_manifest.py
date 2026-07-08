from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from harness_codex.runtime.agent_context import bootstrap_agent_context
from harness_codex.runtime.scope_support_manifest import (
    SCOPE_SUPPORT_MANIFEST_PATH,
    ensure_scope_support_manifest,
)


def test_bootstrap_agent_context_creates_repo_scope_support_manifest(
    tmp_path: Path,
) -> None:
    (tmp_path / "build.gradle").write_text("plugins {}", encoding="utf-8")
    (tmp_path / "scripts/deploy.sh").parent.mkdir(parents=True)
    (tmp_path / "scripts/deploy.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    (tmp_path / "src/main/resources/ehcache.xml").parent.mkdir(parents=True)
    (tmp_path / "src/main/resources/ehcache.xml").write_text(
        "<config/>",
        encoding="utf-8",
    )

    result = bootstrap_agent_context(tmp_path, "테스트 리포지토리")

    manifest_path = tmp_path / SCOPE_SUPPORT_MANIFEST_PATH
    manifest_text = manifest_path.read_text(encoding="utf-8")

    assert manifest_path.exists()
    assert SCOPE_SUPPORT_MANIFEST_PATH in result.changed_paths
    assert 'allow = ["build.gradle", "scripts/**", "src/main/resources/**"]' in manifest_text


def test_scope_support_manifest_refreshes_when_stale(tmp_path: Path) -> None:
    (tmp_path / "src/main/resources/ehcache.xml").parent.mkdir(parents=True)
    (tmp_path / "src/main/resources/ehcache.xml").write_text("<config/>", encoding="utf-8")
    manifest_path = tmp_path / SCOPE_SUPPORT_MANIFEST_PATH
    manifest_path.parent.mkdir(parents=True)
    stale_time = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    manifest_path.write_text(
        "\n".join(
            [
                'version = "1"',
                f'generated_at = "{stale_time}"',
                "refresh_after_hours = 24",
                "",
                "[repo]",
                'fingerprint = "stale"',
                "technologies = []",
                "manifests = []",
                "",
                "[support_files]",
                "allow = []",
                "",
            ]
        ),
        encoding="utf-8",
    )

    result = ensure_scope_support_manifest(tmp_path, "테스트 리포지토리")
    manifest_text = manifest_path.read_text(encoding="utf-8")

    assert result.action == "updated"
    assert 'src/main/resources/**' in manifest_text
    assert 'fingerprint = "stale"' not in manifest_text
