"""Create small, durable security-review artifacts for one work item."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Mapping, Sequence

_SIGNAL_PATTERNS: dict[str, tuple[str, ...]] = {
    "public_http_endpoint": ("endpoint", "controller", "route", "rest", "http", "api"),
    "authentication_changed": ("authentication", "authenticate", "login", "jwt", "session", "token", "인증", "로그인"),
    "authorization_changed": ("authorization", "permission", "role", "access control", "권한", "인가"),
    "personal_data": ("personal data", "pii", "email", "phone", "profile", "개인정보", "회원"),
    "external_network_call": ("webhook", "webclient", "resttemplate", "http client", "external api", "third party"),
    "file_upload": ("upload", "multipart", "attachment", "file input"),
    "deserialization": ("deserialize", "serialization", "yaml", "pickle"),
    "tenant_boundary": ("tenant", "multi-tenant", "multitenant"),
    "dynamic_query": ("dynamic query", "criteria", "native sql", "search query", "filter expression"),
    "secret_or_token": ("secret", "api key", "password", "credential", "refresh token"),
    "payment": ("payment", "결제", "invoice", "refund"),
}

_CONTROL_MAP: dict[str, tuple[dict[str, str], ...]] = {
    "public_http_endpoint": ({"id": "ASVS-V4", "title": "Input validation", "requirement": "Reject malformed and boundary-invalid input."},),
    "authentication_changed": ({"id": "ASVS-V2", "title": "Authentication", "requirement": "Protected behavior rejects failed authentication."},),
    "authorization_changed": ({"id": "ASVS-V4.2", "title": "Authorization", "requirement": "Denied principals cannot access another resource."},),
    "personal_data": ({"id": "ASVS-V8", "title": "Data protection", "requirement": "Do not expose personal data beyond the response contract."},),
    "external_network_call": ({"id": "ASVS-V9", "title": "Communications", "requirement": "Constrain outbound destinations and failures."},),
    "file_upload": ({"id": "ASVS-V12", "title": "File handling", "requirement": "Validate type, size, storage path, and authorization."},),
    "deserialization": ({"id": "ASVS-V5", "title": "Secure coding", "requirement": "Avoid unsafe untrusted deserialization."},),
    "tenant_boundary": ({"id": "API1:2023", "title": "Object authorization", "requirement": "Verify tenant and object ownership."},),
    "dynamic_query": ({"id": "ASVS-V5.3", "title": "Injection prevention", "requirement": "Bind values and validate query operators."},),
    "secret_or_token": ({"id": "ASVS-V6", "title": "Stored secrets", "requirement": "Do not expose secrets or tokens."},),
    "payment": ({"id": "ASVS-V11", "title": "Business logic", "requirement": "Verify authorization, idempotency, and state invariants."},),
}
_HIGH_RISK = frozenset(_SIGNAL_PATTERNS) - {"public_http_endpoint"}


def materialize_security_profile(
    *, repo_root: Path, plan_path: Path, profile_output: Path,
    controls_output: Path, standards_path: Path = Path(".codex/security/owasp-standards.json"),
) -> tuple[dict[str, Any], dict[str, Any]]:
    plan = _absolute(repo_root, plan_path)
    if not plan.is_file():
        raise FileNotFoundError(f"active plan is required: {plan_path}")
    text = plan.read_text(encoding="utf-8").lower()
    signals = {key: any(token.lower() in text for token in needles) for key, needles in _SIGNAL_PATTERNS.items()}
    applicable = [key for key, enabled in signals.items() if enabled]
    controls = _dedupe(control for signal in applicable for control in _CONTROL_MAP.get(signal, ()))
    profile = {
        "schema_version": 1,
        "source_plan": _relative(plan, repo_root),
        "signals": signals,
        "applicable_signals": applicable,
        "review_required": any(signals[key] for key in _HIGH_RISK),
        "routing": "independent-review" if any(signals[key] for key in _HIGH_RISK) else "static-profile-only",
    }
    selected = {
        "schema_version": 1,
        "source": "runtime security profile",
        "pinned_standards": _pinned_standards(_absolute(repo_root, standards_path)),
        "selected_controls": controls,
    }
    _write_json(_absolute(repo_root, profile_output), profile)
    _write_json(_absolute(repo_root, controls_output), selected)
    return profile, selected


def materialize_security_review_bundle(
    *, repo_root: Path, run_id: str, work_item_id: str, plan_path: Path,
    profile_path: Path, controls_path: Path, verification_report_path: Path,
    verification_markdown_path: Path, output_dir: Path,
) -> dict[str, Any]:
    target = _absolute(repo_root, output_dir)
    target.mkdir(parents=True, exist_ok=True)
    files = _changed_files_from_scope_report(repo_root, run_id)
    if not files:
        files = _git_changed_files(repo_root)
    _write_json(target / "changed-files.json", {"files": files})
    (target / "implementation.diff").write_text(_git_diff(repo_root, files), encoding="utf-8")
    _write_json(target / "security-profile.json", _read_json(_absolute(repo_root, profile_path)))
    _write_json(target / "selected-controls.json", _read_json(_absolute(repo_root, controls_path)))
    (target / "security-plan-tasks.md").write_text(_security_plan_section(_read_text(_absolute(repo_root, plan_path))), encoding="utf-8")
    _write_json(target / "verification-summary.json", _read_json(_absolute(repo_root, verification_report_path)))
    (target / "focused-test-summary.md").write_text(_read_text(_absolute(repo_root, verification_markdown_path)), encoding="utf-8")
    manifest = {
        "schema_version": 1,
        "run_id": run_id,
        "work_item_id": work_item_id,
        "files": [
            "changed-files.json", "implementation.diff", "security-profile.json",
            "selected-controls.json", "security-plan-tasks.md", "verification-summary.json",
            "focused-test-summary.md",
        ],
    }
    _write_json(target / "manifest.json", manifest)
    return manifest


def _changed_files_from_scope_report(repo_root: Path, run_id: str) -> list[dict[str, str]]:
    payload = _read_json(repo_root / ".harness/runs" / run_id / "steps" / "execute-work-item" / "scope-diff-report.json")
    allowed = payload.get("allowed")
    if not isinstance(allowed, list):
        return []
    return [
        {"path": str(row["path"]), "operation": str(row.get("operation") or "modify")}
        for row in allowed if isinstance(row, Mapping) and row.get("path")
    ]


def _git_changed_files(repo_root: Path) -> list[dict[str, str]]:
    result = subprocess.run(["git", "diff", "--name-only", "HEAD"], cwd=repo_root, text=True, capture_output=True, check=False)
    return [{"path": line, "operation": "modify"} for line in result.stdout.splitlines() if line] if result.returncode == 0 else []


def _git_diff(repo_root: Path, files: Sequence[Mapping[str, str]]) -> str:
    paths = [str(row["path"]) for row in files if row.get("path")]
    if not paths:
        return "# No scoped implementation diff was available.\n"
    result = subprocess.run(["git", "diff", "--binary", "HEAD", "--", *paths], cwd=repo_root, text=True, capture_output=True, check=False)
    if result.returncode:
        return f"# Unable to materialize scoped diff\n\n{result.stderr}\n"
    return result.stdout or "# No tracked scoped implementation diff was available.\n"


def _security_plan_section(text: str) -> str:
    match = re.search(r"(?ims)^##\s+(?:OWASP\s+Security\s+Review|보안\s+검토)\s*$.*?(?=^##\s|\Z)", text)
    return match.group(0).strip() + "\n" if match else "# No dedicated security-plan section was found.\n"


def _pinned_standards(path: Path) -> list[dict[str, str]]:
    values = _read_json(path).get("standards")
    if not isinstance(values, list):
        return []
    return [
        {"id": str(item["id"]), "version": str(item["expected_version"]), "name": str(item.get("name") or item["id"])}
        for item in values if isinstance(item, Mapping) and item.get("id") and item.get("expected_version")
    ]


def _dedupe(values: Any) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in values:
        if item["id"] not in seen:
            seen.add(item["id"])
            result.append(dict(item))
    return result


def _absolute(root: Path, path: Path) -> Path:
    return path if path.is_absolute() else root / path


def _relative(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    profile = subparsers.add_parser("profile")
    profile.add_argument("--repo-root", default=".")
    profile.add_argument("--plan", required=True)
    profile.add_argument("--profile-output", required=True)
    profile.add_argument("--controls-output", required=True)
    profile.add_argument("--standards", default=".codex/security/owasp-standards.json")
    bundle = subparsers.add_parser("bundle")
    bundle.add_argument("--repo-root", default=".")
    bundle.add_argument("--run-id", required=True)
    bundle.add_argument("--work-item", required=True)
    bundle.add_argument("--plan", required=True)
    bundle.add_argument("--profile", required=True)
    bundle.add_argument("--controls", required=True)
    bundle.add_argument("--verification-report", required=True)
    bundle.add_argument("--verification-markdown", required=True)
    bundle.add_argument("--output-dir", required=True)
    args = parser.parse_args(argv)
    root = Path(args.repo_root).resolve()
    if args.command == "profile":
        materialize_security_profile(repo_root=root, plan_path=Path(args.plan), profile_output=Path(args.profile_output), controls_output=Path(args.controls_output), standards_path=Path(args.standards))
    else:
        materialize_security_review_bundle(repo_root=root, run_id=args.run_id, work_item_id=args.work_item, plan_path=Path(args.plan), profile_path=Path(args.profile), controls_path=Path(args.controls), verification_report_path=Path(args.verification_report), verification_markdown_path=Path(args.verification_markdown), output_dir=Path(args.output_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
