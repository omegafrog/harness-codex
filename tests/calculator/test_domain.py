from decimal import Decimal

import pytest

from harness_codex.calculator import Calculator, Expression


def test_calculator_evaluates_valid_expression() -> None:
    result = Calculator().evaluate(Expression("(2 + 3) * 4 / 2"))

    assert result.value == Decimal("10")


@pytest.mark.parametrize("source", ["unknown", "2 ** 3", "1 / 0"])
def test_calculator_rejects_unavailable_expression(source: str) -> None:
    with pytest.raises(ValueError, match="계산할 수 없는 수식"):
        Calculator().evaluate(Expression(source))


def test_expression_rejects_empty_source() -> None:
    with pytest.raises(ValueError, match="수식은 비어 있을 수 없습니다"):
        Expression("")
