"""XML workflow adapters for security review handoffs."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any, Sequence

from harness_codex.runtime.security_review_bundle import (
    materialize_security_profile,
    materialize_security_review_bundle,
)
from harness_codex.runtime.xml_handoff import read_handoff, write_handoff


def profile(
    *,
    repo_root: Path,
    plan_path: Path,
    profile_output: Path,
    controls_output: Path,
    standards_path: Path,
) -> None:
    """Materialize XML security profile and selected controls."""

    raw_root = _raw_root(profile_output)
    raw_profile = raw_root / "security-profile.json"
    raw_controls = raw_root / "selected-controls.json"
    raw_root.mkdir(parents=True, exist_ok=True)
    try:
        profile_data, controls_data = materialize_security_profile(
            repo_root=repo_root,
            plan_path=plan_path,
            profile_output=raw_profile,
            controls_output=raw_controls,
            standards_path=standards_path,
        )
        write_handoff(_absolute(repo_root, profile_output), "security-profile", profile_data)
        write_handoff(_absolute(repo_root, controls_output), "security-controls", controls_data)
    finally:
        shutil.rmtree(raw_root, ignore_errors=True)


def bundle(
    *,
    repo_root: Path,
    run_id: str,
    work_item_id: str,
    plan_path: Path,
    profile_path: Path,
    controls_path: Path,
    verification_report_path: Path,
    verification_markdown_path: Path,
    output_dir: Path,
) -> None:
    """Materialize XML security review contract bundle from XML inputs."""

    target = _absolute(repo_root, output_dir)
    raw_root = target / ".raw-json"
    raw_root.mkdir(parents=True, exist_ok=True)
    profile_data = read_handoff(_absolute(repo_root, profile_path), expected_type="security-profile")
    controls_data = read_handoff(_absolute(repo_root, controls_path), expected_type="security-controls")
    verification_data = read_handoff(
        _absolute(repo_root, verification_report_path), expected_type="verification-report"
    )
    raw_profile = raw_root / "security-profile.json"
    raw_controls = raw_root / "selected-controls.json"
    raw_verification = raw_root / "verification-report.json"
    _write_json(raw_profile, profile_data)
    _write_json(raw_controls, controls_data)
    _write_json(raw_verification, verification_data)
    try:
        raw_bundle = raw_root / "bundle"
        materialize_security_review_bundle(
            repo_root=repo_root,
            run_id=run_id,
            work_item_id=work_item_id,
            plan_path=plan_path,
            profile_path=raw_profile,
            controls_path=raw_controls,
            verification_report_path=raw_verification,
            verification_markdown_path=verification_markdown_path,
            output_dir=raw_bundle,
        )
        target.mkdir(parents=True, exist_ok=True)
        changed = _read_json(raw_bundle / "changed-files.json")
        manifest = _read_json(raw_bundle / "manifest.json")
        write_handoff(target / "security-profile.xml", "security-profile", profile_data)
        write_handoff(target / "selected-controls.xml", "security-controls", controls_data)
        write_handoff(target / "verification-summary.xml", "verification-report", verification_data)
        manifest.update(
            {
                "schema_version": int(manifest.get("schema_version", 1)),
                "run_id": run_id,
                "work_item_id": work_item_id,
                "files": [
                    "manifest.xml",
                    "implementation.diff",
                    "security-profile.xml",
                    "selected-controls.xml",
                    "verification-summary.xml",
                    "security-plan-tasks.md",
                    "focused-test-summary.md",
                ],
                "changed_files": changed.get("files", []),
            }
        )
        write_handoff(target / "manifest.xml", "security-bundle-manifest", manifest)
        _copy(raw_bundle / "implementation.diff", target / "implementation.diff")
        _copy(raw_bundle / "security-plan-tasks.md", target / "security-plan-tasks.md")
        _copy(raw_bundle / "focused-test-summary.md", target / "focused-test-summary.md")
    finally:
        shutil.rmtree(raw_root, ignore_errors=True)


def _raw_root(path: Path) -> Path:
    return path.parent / f".{path.stem}-raw"


def _absolute(root: Path, path: Path) -> Path:
    return path if path.is_absolute() else root / path


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _copy(source: Path, destination: Path) -> None:
    destination.write_bytes(source.read_bytes() if source.is_file() else b"")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    profile_parser = subparsers.add_parser("profile")
    profile_parser.add_argument("--repo-root", default=".")
    profile_parser.add_argument("--plan", required=True)
    profile_parser.add_argument("--profile-output", required=True)
    profile_parser.add_argument("--controls-output", required=True)
    profile_parser.add_argument("--standards", default=".codex/security/owasp-standards.json")
    bundle_parser = subparsers.add_parser("bundle")
    bundle_parser.add_argument("--repo-root", default=".")
    bundle_parser.add_argument("--run-id", required=True)
    bundle_parser.add_argument("--work-item", required=True)
    bundle_parser.add_argument("--plan", required=True)
    bundle_parser.add_argument("--profile", required=True)
    bundle_parser.add_argument("--controls", required=True)
    bundle_parser.add_argument("--verification-report", required=True)
    bundle_parser.add_argument("--verification-markdown", required=True)
    bundle_parser.add_argument("--output-dir", required=True)
    args = parser.parse_args(argv)
    root = Path(args.repo_root).resolve()
    if args.command == "profile":
        profile(
            repo_root=root,
            plan_path=Path(args.plan),
            profile_output=Path(args.profile_output),
            controls_output=Path(args.controls_output),
            standards_path=Path(args.standards),
        )
    else:
        bundle(
            repo_root=root,
            run_id=args.run_id,
            work_item_id=args.work_item,
            plan_path=Path(args.plan),
            profile_path=Path(args.profile),
            controls_path=Path(args.controls),
            verification_report_path=Path(args.verification_report),
            verification_markdown_path=Path(args.verification_markdown),
            output_dir=Path(args.output_dir),
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
