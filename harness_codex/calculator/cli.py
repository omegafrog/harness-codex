"""계산기 명령줄 인터페이스."""

from __future__ import annotations

import sys
from typing import Sequence

from .application import CalculatorCliApplicationService


def main(arguments: Sequence[str] | None = None) -> int:
    """명령 인자를 계산하고 CLI 종료 코드를 반환한다."""
    response = CalculatorCliApplicationService().calculate(
        sys.argv[1:] if arguments is None else arguments
    )
    if response.is_success:
        print(response.output)
        return 0

    print(response.error, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
