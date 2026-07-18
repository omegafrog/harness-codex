from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from harness_codex.runtime import app_deployment
from harness_codex.runtime.app_deployment import scaffold_app_runtime
from harness_codex.runtime.app_runner import run_app_lifecycle


def _terraform_ok(monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    commands: list[list[str]] = []

    def fake_run(command, **_kwargs):
        commands.append(list(command))
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(app_deployment.subprocess, "run", fake_run)
    return commands


def test_init_generates_only_codedeploy_ready_terraform(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    commands = _terraform_ok(monkeypatch)

    output = scaffold_app_runtime(tmp_path, [])

    terraform_root = tmp_path / "infra/harness/aws"
    assert (terraform_root / "versions.tf").is_file()
    assert (terraform_root / "variables.tf").is_file()
    assert (terraform_root / "outputs.tf").is_file()
    assert not (tmp_path / "scripts/app").exists()
    assert not (tmp_path / ".harness/app-runtime").exists()
    assert commands == [
        ["terraform", f"-chdir={terraform_root}", "init", "-input=false"],
        ["terraform", f"-chdir={terraform_root}", "validate"],
    ]
    assert "terraform plan/apply: not run" in output


def test_generated_terraform_uses_eip_public_dns_and_no_route53(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _terraform_ok(monkeypatch)
    scaffold_app_runtime(tmp_path, [])

    source = (tmp_path / "infra/harness/aws/main.tf").read_text(encoding="utf-8")
    outputs = (tmp_path / "infra/harness/aws/outputs.tf").read_text(encoding="utf-8")
    assert 'resource "aws_eip" "app"' in source
    assert 'resource "aws_eip_association" "app"' in source
    assert "enable_dns_support   = true" in source
    assert "enable_dns_hostnames = true" in source
    assert 'resource "aws_codedeploy_app" "app"' in source
    assert 'resource "aws_codedeploy_deployment_group" "app"' in source
    assert 'resource "aws_iam_openid_connect_provider" "github"' in source
    assert "route53" not in source.lower()
    assert 'output "public_dns"' in outputs
    assert 'data.aws_instance.app.public_dns' in outputs


def test_init_preserves_user_owned_file_even_with_force(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _terraform_ok(monkeypatch)
    target = tmp_path / "infra/harness/aws/main.tf"
    target.parent.mkdir(parents=True)
    target.write_text("# user owned\n", encoding="utf-8")

    output = scaffold_app_runtime(tmp_path, ["--force"])

    assert target.read_text(encoding="utf-8") == "# user owned\n"
    assert "- preserved: infra/harness/aws/main.tf" in output


def test_init_updates_only_marked_file_with_force(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _terraform_ok(monkeypatch)
    target = tmp_path / "infra/harness/aws/main.tf"
    target.parent.mkdir(parents=True)
    target.write_text(app_deployment.GENERATOR_MARKER + "\nold\n", encoding="utf-8")

    scaffold_app_runtime(tmp_path, ["--force"])

    assert 'resource "aws_instance" "app"' in target.read_text(encoding="utf-8")


def test_init_reports_terraform_failure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        app_deployment.subprocess,
        "run",
        lambda command, **_kwargs: subprocess.CompletedProcess(command, 1, "", "bad config"),
    )

    with pytest.raises(ValueError, match="terraform init -input=false failed: bad config"):
        scaffold_app_runtime(tmp_path, [])


def test_lifecycle_init_does_not_require_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _terraform_ok(monkeypatch)

    output = run_app_lifecycle(tmp_path, ["init"])

    assert "AWS application infrastructure initialized" in output
