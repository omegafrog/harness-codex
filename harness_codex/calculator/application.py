"""계산기 CLI를 위한 Application Service."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from .domain import Calculator, Expression


@dataclass(frozen=True)
class CalculationResponse:
    """CLI 경계로 전달할 계산 결과."""

    output: str | None = None
    error: str | None = None

    @property
    def is_success(self) -> bool:
        return self.error is None


class CalculatorCliApplicationService:
    """명령 인자를 계산기 도메인 호출로 연결한다."""

    def __init__(self, calculator: Calculator | None = None) -> None:
        self._calculator = calculator or Calculator()

    def calculate(self, arguments: Sequence[str]) -> CalculationResponse:
        """명령 인자를 계산하고 CLI가 처리할 성공·실패 응답을 반환한다."""
        try:
            result = self._calculator.evaluate(Expression(" ".join(arguments)))
        except ValueError as error:
            return CalculationResponse(error=str(error))

        return CalculationResponse(output=str(result.value))
