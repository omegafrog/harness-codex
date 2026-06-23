import argparse

from harness_codex.canonical_cli import build_parser


def test_public_command_list_uses_staged_workflow():
    parser = build_parser()
    names = set()
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            names = set(action.choices)
    assert "requirements-definition" in names
    assert "implementation" in names
    assert "ultrawork" not in names
    assert "change-set-pr" not in names
