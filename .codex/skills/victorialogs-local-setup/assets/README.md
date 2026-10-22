# 로컬 OpenTelemetry 관측성

<!-- Harness observability stack v3 -->

```text
Spring Boot A/B/C ─ OTel LogRecord · 실제 Trace/Correlation ─→ OpenTelemetry Collector :4318
                                                              └ OTLP HTTP → VictoriaLogs :9428
Spring Boot A/B/C ─ Actuator /actuator/prometheus ───────────────→ VictoriaMetrics :8428
VictoriaLogs + VictoriaMetrics ─ 공식 MCP 두 개 ─→ 에이전트의 오류 조사·수정·재검증
```

## 설치와 재설정

프로젝트 Git root에서 `node .codex/scripts/harness-setup.mjs --root <절대 경로>`를 실행한다. CLI에서 사용 여부, 두 저장소 포트·보존 일수, OTLP HTTP 포트, 프로젝트 ID/Git root와 서비스별 **앱 기준 Actuator URL(metrics_url)** 및 **컨테이너 기준 URL(scrape_url)**을 입력한다. 기본값은 Logs 9428, Metrics 8428, OTLP 4318, 보존 각각 7일이다. 명시적으로 등록한 여러 프로젝트/서비스를 하나의 스택에서 구분한다. 다른 프로젝트에서 별도 기본 포트 스택을 중복 실행하지 않는다. 기존 스택을 공유하려면 같은 생성 mcp.json과 Collector endpoint를 사용한다.

`victorialogs-local-setup` 스킬이 실제 source에 맞춰 개발 OTel SDK/appender 또는 외부 Java agent, Actuator/Prometheus registry와 실행 profile을 연결한다. 일반 logger 자동 수집은 domain 진단 v1 emitter를 구현한 것이 아니다. [진단 계약](diagnostic-log-schema.md)의 논리 JSON을 실제 OTel 필드와 typed attributes로 매핑하고 JSON 전체를 Body에 중첩하지 않는다. Java agent config는 `otel-javaagent.properties`이며 별도 trace/metric exporter는 끈다. JVM 메트릭은 Actuator를 직접 scrape한다. SDK/agent를 중복 설치하거나 production build에 개발 의존성을 포함하지 않는다.

기존 개발 Spring config에 spring-local.properties를 추가할 때 기존 endpoint 노출·보안 설정과 config loader 값을 보존한다. Actuator 경로·포트·컨테이너 접근 주소를 바꾸면 CLI를 재실행해 config.json과 scrape.json을 함께 갱신한다. 직접 config.json만 바꿔 target이 어긋나면 실행 전 검증이 실패한다. 단순 helper setup에서 services가 비어 있다면 수집 대상 준비 전이며 metrics 수집 완료가 아니다.

Docker Compose v2의 **기본 bridge network**를 사용한다. Docker host networking 활성화는 필요 없다. 컨테이너 내부는 0.0.0.0:4318/9428/8428에서 listen하고, host에는 `127.0.0.1:<설정 포트>`로만 publish한다. 앱과 에이전트의 HTTP 조회는 이 공개 포트를 사용한다. Collector→VictoriaLogs와 MCP→backend는 `victorialogs:9428`, `victoriametrics:8428`의 compose service DNS를 사용한다.

Docker Desktop/WSL에서 컨테이너가 WSL 앱에 접근할 때는 `scrape_url=http://host.docker.internal:<실제 management port>/<실제 path>`를 사용한다. 앱의 `metrics_url=http://127.0.0.1:...`와 별도로 저장하며 포트·경로는 유지한다. WSL에서 host.docker.internal을 DNS 조회하거나 Windows gateway IP를 앱 endpoint로 강제하지 않는다. Linux native Docker에서는 컨테이너에서 실제 접근 가능한 host IP/서비스 DNS를 scrape_url로 입력한다. Desktop의 host.docker.internal DNS를 임의의 host-gateway 매핑으로 덮어쓰지 않는다. 연결 실패는 자동 IP 교체나 방화벽/WSL 전역 설정 변경으로 우회하지 않고 정확한 방향·주소·실제 listener 상태를 보고한다.

로그/메트릭 데이터·Collector queue는 원본 프로젝트 session directory 안에 보존하고 stop은 데이터를 삭제하지 않는다. 원본 JSONL도 HARNESS_SESSION_DIR/runtime/services/<service>/ 안에 둔다. Collector는 파일을 tail하지 않는다. 이전 host network/Fluent Bit compose·Collector config는 session backup 후 전환한다. 최초 image 준비와 Collector config 검증의 제한 시간은 infrastructure profile에서 180초이며 실패를 성공으로 보고하지 않는다.

## 실행

```sh
node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile victorialogs-infrastructure
node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile victorialogs-check
node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile victorialogs-stop
```

infrastructure는 foreground이며 다른 세션에서 check와 앱 profile을 실행한다. check는 세 API readiness이며 앱 수집 확인은 아니다. 앱 실행 후 최근 실제 로그와 VictoriaMetrics의 `up{project="프로젝트ID",service="서비스명"}` 값 1을 확인한다. setup 자체는 서버를 시작하지 않는다. 구형 Fluent Bit compose를 전환할 때 원본을 session backup하며 구형 설정/offset 파일은 복구용으로 보존한다. 스택 시작 시 같은 compose project의 폐기 collector만 정리한다.

schema 검사는 Docker 없이 실행한다. fixture만 통과했다고 실제 emitter/context/redaction·수집·MCP 연결이 검증된 것은 아니다.

```sh
export HARNESS_DIAGNOSTIC_LOG_FILE="<원본 JSONL 절대 경로>"
node .codex/scripts/harness-exec.mjs --root <workspace_root> --profile victorialogs-diagnostic-logs
```

## MCP와 조회

mcp.json의 victorialogs/mcp와 victoriametrics/mcp-metrics 두 stdio 항목을 사용하는 MCP 클라이언트에 등록한다. helper가 공식 Docker MCP 이미지를 필요 시 해당 compose bridge network에서 실행하며 documentation 도구를 꺼 메모리 사용을 줄인다. protocol stdout 보존을 위해 MCP 클라이언트가 직접 helper를 호출한다. 전역 provider 설정은 덮어쓰지 않는다.

처음엔 최근 15분·최대 100건으로 project/service를 제한하고 trace_id와 diag.operation.id로 좁힌다. OTLP 수집 후 Resource/Attributes 접두사는 없다. 실제 필드는 저장된 결과로 확인한다. 숫자/boolean 저장 표현은 원본 typed JSON과 구분한다. 자동 장애 감시·강제 query quota는 별도 기능이다.

```text
_time:15m event_name:="diag.operation.failed" service.name:="example-api"
_time:1h event_name:="diag.operation.completed" diag.operation.name:="llm.generate" | stats count() as calls, avg(diag.duration_ms) as avg_ms, quantile(0.95, diag.duration_ms) as p95_ms
```

성공 이벤트의 지연 표본과 전체 terminal 이벤트 지연을 구분한다. JVM/CPU/GC 지표는 Metrics MCP에서 같은 프로젝트·서비스·기간으로 조회한다. trace/request/operation ID 같은 고유값은 metric label에 추가하지 않는다.

## 공식 근거

- [VictoriaLogs OTLP HTTP](https://docs.victoriametrics.com/victorialogs/data-ingestion/opentelemetry/)
- [VictoriaMetrics](https://docs.victoriametrics.com/victoriametrics/quick-start/)
- [OpenTelemetry Java](https://opentelemetry.io/docs/zero-code/java/agent/)
- [공식 Logs MCP](https://github.com/VictoriaMetrics/mcp-victorialogs) · [공식 Metrics MCP](https://github.com/VictoriaMetrics/mcp-victoriametrics)
- [Spring Boot 메트릭](https://docs.spring.io/spring-boot/reference/actuator/metrics.html)
- [Docker bridge network](https://docs.docker.com/engine/network/drivers/bridge/)
