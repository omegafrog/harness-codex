"""계산기 BC의 상태 없는 도메인 모델."""

from __future__ import annotations

import ast
from dataclasses import dataclass
from decimal import Decimal
from operator import add, mul, sub, truediv
from typing import Callable


@dataclass(frozen=True)
class Expression:
    """사용자가 입력한 계산식."""

    source: str

    def __post_init__(self) -> None:
        if not self.source.strip():
            raise ValueError("수식은 비어 있을 수 없습니다.")


@dataclass(frozen=True)
class CalculationResult:
    """계산식 평가 결과."""

    value: Decimal


class Calculator:
    """수식을 평가하는 상태 없는 도메인 서비스."""

    _BINARY_OPERATORS: dict[type[ast.operator], Callable[[Decimal, Decimal], Decimal]] = {
        ast.Add: add,
        ast.Sub: sub,
        ast.Mult: mul,
        ast.Div: truediv,
    }

    def evaluate(self, expression: Expression) -> CalculationResult:
        """허용된 산술 수식의 결과를 반환한다."""
        try:
            node = ast.parse(expression.source, mode="eval").body
            return CalculationResult(self._evaluate(node))
        except (ArithmeticError, SyntaxError, TypeError, ValueError) as error:
            raise ValueError("계산할 수 없는 수식입니다.") from error

    def _evaluate(self, node: ast.expr) -> Decimal:
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return Decimal(str(node.value))

        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = self._evaluate(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value

        if isinstance(node, ast.BinOp) and type(node.op) in self._BINARY_OPERATORS:
            operator = self._BINARY_OPERATORS[type(node.op)]
            return operator(self._evaluate(node.left), self._evaluate(node.right))

        raise ValueError("지원하지 않는 수식입니다.")
