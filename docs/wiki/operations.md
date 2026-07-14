# 운영

저장소 루트의 `venv`와 `python3`를 사용해 실행합니다.

```bash
./venv/bin/python3 -m harness_codex.calculator.cli "2 + 3"
```

정상 실행 시 결과는 표준 출력 한 줄로 제공됩니다. 입력 오류와 0으로 나누기는 표준 오류와 0이 아닌 종료 코드로 확인할 수 있습니다.

회귀 검증은 다음 명령으로 실행합니다.

```bash
./venv/bin/python3 -m pytest tests/calculator/
```
