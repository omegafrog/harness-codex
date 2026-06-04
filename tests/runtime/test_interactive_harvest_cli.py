import pytest

from harness_codex.cli import build_parser, main


def test_harvest_command_is_not_registered() -> None:
    parser = build_parser()

    with pytest.raises(SystemExit):
        parser.parse_args(["harvest", "--help"])


def test_harvest_interactive_is_rejected(tmp_path) -> None:
    with pytest.raises(SystemExit) as exc:
        main(["--repo-root", str(tmp_path), "harvest", "--interactive"])
    assert exc.value.code == 2
