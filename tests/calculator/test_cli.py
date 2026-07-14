import subprocess
import sys

import pytest


def run_calculator(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "harness_codex.calculator.cli", *arguments],
        check=False,
        capture_output=True,
        text=True,
    )


def test_cli_prints_calculation_result_and_succeeds() -> None:
    result = run_calculator("2 + 3")

    assert result.returncode == 0
    assert result.stdout == "5\n"
    assert result.stderr == ""


@pytest.mark.parametrize("expression", ["unknown", "1 / 0"])
def test_cli_prints_calculation_error_and_fails(expression: str) -> None:
    result = run_calculator(expression)

    assert result.returncode != 0
    assert result.stdout == ""
    assert result.stderr == "계산할 수 없는 수식입니다.\n"
