# 검증

계산기 변경은 총 10개 테스트가 통과한 상태로 검토되었습니다.

- 도메인 테스트: 5개
- 애플리케이션 서비스 테스트: 2개
- CLI 테스트: 3개

검증 명령:

```bash
./venv/bin/python3 -m pytest tests/calculator/
```

수동 실행 예시:

```bash
./venv/bin/python3 -m harness_codex.calculator.cli "2 + 3"
```

정상 계산, 잘못된 수식, 0으로 나누기의 출력 채널과 종료 코드 동작을 검토했습니다.
