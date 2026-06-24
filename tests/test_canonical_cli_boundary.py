from __future__ import annotations

import pytest

from harness_codex import canonical_cli


def test_public_cli_rejects_retired_command_without_calling_stage_runtime(monkeypatch, capsys) -> None:
    def fail_stage_runtime(_arguments: list[str]) -> int:
        raise AssertionError("retired command reached the internal parser")

    monkeypatch.setattr(canonical_cli._stage_runtime, "main", fail_stage_runtime)

    assert canonical_cli.main(["ultrawork"]) == 2
    assert "unknown public harness command: ultrawork" in capsys.readouterr().err


def test_public_cli_delegates_supported_stage_with_global_option(monkeypatch) -> None:
    observed: list[str] = []

    def run_stage_runtime(arguments: list[str]) -> int:
        observed.extend(arguments)
        return 0

    monkeypatch.setattr(canonical_cli._stage_runtime, "main", run_stage_runtime)

    assert canonical_cli.main(["--repo-root", "fixture", "implementation", "CHG-001", "--plan"]) == 0
    assert observed == ["--repo-root", "fixture", "implementation", "CHG-001", "--plan"]


def test_public_cli_routes_memory_only_when_memory_is_the_command(monkeypatch) -> None:
    stage_arguments: list[str] = []
    memory_arguments: list[str] = []

    def run_stage_runtime(arguments: list[str]) -> int:
        stage_arguments.extend(arguments)
        return 0

    def run_memory(arguments: list[str]) -> int:
        memory_arguments.extend(arguments)
        return 0

    monkeypatch.setattr(canonical_cli._stage_runtime, "main", run_stage_runtime)
    monkeypatch.setattr(canonical_cli, "memory_main", run_memory)

    assert canonical_cli.main(["requirements-definition", "--title", "memory", "--idea", "cleanup"]) == 0
    assert stage_arguments == ["requirements-definition", "--title", "memory", "--idea", "cleanup"]
    assert memory_arguments == []

    assert canonical_cli.main(["--repo-root", "fixture", "memory", "list"]) == 0
    assert memory_arguments == ["--repo-root", "fixture", "list"]


def test_public_parser_does_not_advertise_retired_command() -> None:
    parser = canonical_cli.build_parser()

    with pytest.raises(SystemExit):
        parser.parse_args(["ultrawork"])
