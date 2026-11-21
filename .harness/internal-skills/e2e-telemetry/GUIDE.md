---
model_tier: execution
---
# E2E 사용량 분석

E2E 실행별 선택 기능이다. 사용자가 켜거나 끄도록 요청하면 그 설정을 적용한다. 설정이 없으면 `HARNESS_E2E_TELEMETRY=1`일 때 켜고, `0` 또는 미설정이면 끈다. 같은 run의 호출과 재개에는 선택한 값을 전달한다.

Codex는 관찰한 `thread.started` ID를 사용한다. Claude Code는 `--provider claude-code`와 관찰한 root `session_id`를 사용한다. 단계 종료, 승인 대기, 실패 또는 cleanup 뒤 한 번 집계한다. 최초 명령과 이어진 명령에 서로 다른 root가 있으면 `--thread`를 각각 넘긴다. 기존 세션에서 시작했다면 run의 실제 시작 시각을 ISO 8601 UTC의 `--since`로 넘긴다. 같은 run을 이어 간 뒤에는 최초 시작 시각과 관찰한 전체 root ID로 갱신한다.

```sh
HARNESS_E2E_TELEMETRY=1 node .harness/internal-skills/e2e-telemetry/scripts/report.mjs \
  --root <절대-workspace-경로> --run-id <run-id> --provider <codex|claude-code> --thread <관찰한-root-id>
```

`--root`는 기존 E2E 증거의 세션을 결정한 workspace다. Codex 로컬 rollout은 `CODEX_HOME`에서, Claude Code 로컬 transcript는 `CLAUDE_CONFIG_DIR`(기본 `~/.claude`)의 `projects/`에서 읽는다. 확인된 하위 기록도 포함한다. 관찰 root가 없으면 수집 불가를 기록한다. 결과는 같은 run의 `runtime/e2e/<run-id>/telemetry.json`과 `telemetry.md`에 저장한다. 보고서에 수집 누락을 표시한다. 분석은 테스트 판정과 승인 상태에 영향을 주지 않는다.

Codex의 `ContextCompaction`과 Claude Code의 `compact_boundary`에서 오케스트레이터와 작업자별 압축을 기록한다. Claude Code는 한 메시지의 여러 블록을 메시지 ID로 합치고, 캐시 읽기를 캐시 입력으로 기록한다. 캐시 기록 입력은 캐시 제외 입력에 포함한다. provider가 기록하지 않은 수치는 수집 불가로 표시한다. 같은 스레드에서 압축 이후 단계가 결과를 제출했는지는 실제 실행 기록을 대조한다.

호출 ID와 도구·인자가 모두 같은 복사본은 한 번만 집계하고, 제외 건수를 보고한다. ID가 없거나 실제로 다시 호출한 도구는 별도 집계한다. 테스트 후보는 셸 명령 시작을 기준으로 판별하므로 `rg`의 검색 문자열에 테스트 명령이 들어 있어도 테스트 실행에 넣지 않는다.

보고서의 호출 후보를 원본 줄에서 대조한다. 앞 단계가 이미 제공한 경로를 다시 찾은 경우, 관련 변경 없이 같은 범위를 반복해서 읽은 경우, 동일 상태에서 무관하거나 중복된 테스트를 실행한 경우를 실제 비효율로 보고한다. `cat` 등으로 정해진 파일을 직접 읽은 호출은 정상일 수 있다. 원본 프롬프트·명령·출력은 분석 보고서에 복사하지 않는다. 개별 호출의 토큰 비용은 추정하지 않는다.
