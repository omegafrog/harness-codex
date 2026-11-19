---
model_tier: execution
---
# E2E 사용량 분석

E2E 실행별 선택 기능이다. 사용자가 켜거나 끄도록 요청하면 그 설정을 적용한다. 설정이 없으면 `HARNESS_E2E_TELEMETRY=1`일 때 켜고, `0` 또는 미설정이면 끈다. 같은 run의 호출과 재개에는 선택한 값을 전달한다.

관찰한 Codex `thread.started`의 ID만 사용한다. 단계 종료, 승인 대기, 실패 또는 cleanup 뒤 한 번 집계한다. 최초 명령과 이어진 명령이 서로 다른 thread라면 `--thread`를 각각 넘긴다. 기존 thread에서 시작한 run은 범위 밖 사용량을 제외할 수 있도록 run의 실제 시작 시각을 ISO 8601 UTC의 `--since`로 넘긴다. 같은 run을 이어 간 뒤에는 최초 시작 시각과 관찰한 전체 root ID로 갱신한다.

```sh
HARNESS_E2E_TELEMETRY=1 node .codex/internal-skills/e2e-telemetry/scripts/report.mjs \
  --root <절대-workspace-경로> --run-id <run-id> --thread <관찰한-root-thread-id>
```

`--root`는 기존 E2E 증거의 세션을 결정한 workspace다. Codex 로컬 rollout은 실행 시 사용한 `CODEX_HOME`에서 읽고, 확인된 하위 thread를 포함한다. 관찰한 Codex thread가 없는 실행에서는 `--thread`를 생략하면 수집 불가를 기록한다. 결과는 같은 run의 `runtime/e2e/<run-id>/telemetry.json`과 `telemetry.md`에 저장한다. 수집 누락은 보고서에 표시한다. 분석은 테스트의 성공·실패 판정과 승인 상태에 영향을 주지 않는다. `ContextCompaction` 이벤트의 스레드 ID를 대조해 오케스트레이터와 각 작업자의 압축 횟수·시각·원본 줄을 기록한다. 하위 스레드로 복사된 상위 압축 기록은 제외한다. 같은 스레드에서 압축 이후 단계 결과를 정상 제출했는지 실제 실행 기록도 대조한다.

보고서의 호출 후보를 원본 줄에서 대조한다. 앞 단계가 이미 제공한 경로를 다시 찾은 경우, 관련 변경 없이 같은 범위를 반복해서 읽은 경우, 동일 상태에서 무관하거나 중복된 테스트를 실행한 경우를 실제 비효율로 보고한다. `cat` 등으로 정해진 파일을 직접 읽은 호출은 정상일 수 있다. 원본 프롬프트·명령·출력은 분석 보고서에 복사하지 않는다. 개별 호출의 토큰 비용은 추정하지 않는다.
