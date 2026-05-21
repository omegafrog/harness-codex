import pytest

from harness_codex.cli import build_parser, main


def test_harvest_help_includes_interactive_option(capsys) -> None:
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["harvest", "--help"])

    output = capsys.readouterr().out
    assert "--interactive" in output
    assert "interactive Grill-Me loop" in output
    assert "--apply" not in output
    assert "--preview" not in output


def test_harvest_interactive_requires_idea(tmp_path, capsys) -> None:
    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "harvest",
            "--interactive",
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "--idea is required" in captured.err
