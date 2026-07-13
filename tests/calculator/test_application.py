from harness_codex.calculator.application import CalculatorCliApplicationService


def test_application_service_returns_calculation_output() -> None:
    response = CalculatorCliApplicationService().calculate(["2", "+", "3"])

    assert response.is_success
    assert response.output == "5"
    assert response.error is None


def test_application_service_returns_calculation_error() -> None:
    response = CalculatorCliApplicationService().calculate(["unknown"])

    assert not response.is_success
    assert response.output is None
    assert response.error == "계산할 수 없는 수식입니다."
