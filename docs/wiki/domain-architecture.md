# 도메인·아키텍처

계산기 기능은 하나의 계산기 Bounded Context로 구성됩니다. 이 범위에는 Aggregate가 없습니다.

도메인 값은 다음과 같습니다.

- `Expression(source)`: 사용자가 입력한 원본 수식
- `CalculationResult(value: Decimal)`: 계산 결과

처리 흐름은 다음과 같습니다.

```text
CLI → CalculatorCliApplicationService.calculate → Calculator.evaluate
```

CLI는 입력과 표준 입출력·종료 코드를 담당합니다. `CalculatorCliApplicationService`는 계산 요청을 도메인으로 전달하고, `Calculator`는 수식을 평가합니다. 별도 Bounded Context 또는 외부 시스템 통신은 없습니다.
