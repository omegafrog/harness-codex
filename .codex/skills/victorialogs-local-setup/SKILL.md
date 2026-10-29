---
name: victorialogs-local-setup
description: Connect development OpenTelemetry logs, VictoriaLogs, Actuator metrics, VictoriaMetrics and both official provider-neutral MCP servers through the Harness setup CLI.
---

# 로컬 OpenTelemetry 관측성 설정

## 실행 모델과 반환

기본 `model_tier`는 `execution`이며 `agents.execution_model`와 `agents.execution_reasoning_effort`를 함께 사용한다. workflow stage가 지정된 호출은 그 stage의 tier를 우선한다. [정적 호출기](../../../.codex/internal-skills/static-caller/GUIDE.md)에 따라 `harness-static-call.mjs`가 스킬의 binding과 setup 설정을 읽어 model·effort를 선택한다. `execution_id`를 받은 실행은 지정된 작업만 수행하고 결과 파일을 저장한 뒤 공통 envelope만 반환한다. 추가 agent·리뷰·단계 전환이 필요하면 orchestrator에 상태 코드로 반환한다.

setup CLI의 `observability.victorialogs.local.enabled: true` 선택에 따라 실행한다. 설정값은 CLI가 수집하며 agent가 채팅으로 재질문하지 않는다. **OpenTelemetry Collector → VictoriaLogs**, **Actuator → VictoriaMetrics**, **공식 MCP 두 개 → 에이전트**가 기본 구성이다. Vector·Fluent Bit·Grafana·trace 저장소는 설치하지 않는다.

## 하나의 설치 경로

1. 절대 `workspace_root`와 Git root, 같은 Git common directory의 `shared_guidance_root`를 확인한다. 공용 구현/테스트 지침과 등록된 각 프로젝트의 Spring Boot 버전·Gradle/Maven wrapper·logging backend·기존 OTel/Micrometer·개발 profile·EXEC/execution.json을 읽는다. 일반 로깅을 v1 진단 emitter로 취급하지 않는다.
2. setup CLI는 두 저장소의 localhost 포트/보존 기간, OTLP HTTP 포트, 프로젝트 ID·Git root·서비스명·앱 기준 metrics_url·컨테이너 기준 scrape_url을 수집하고 `harness-victorialogs.mjs setup`을 호출한다. `docs/observability/victorialogs/`에 compose·otel-collector.yaml·scrape.json·Spring 외부 설정·otel-javaagent.properties·config.json·mcp.json·진단 schema를 준비하고 공용 지침을 갱신한다. 일반 인프라 관리는 전용 helper CLI로 직접 수행하며 execution profile을 만들지 않는다. 재실행은 managed 설정을 session backup 후 갱신하며 다른 MCP·profile·업무 지침은 보존한다. 구형 host network/Fluent Bit compose와 Collector 설정은 백업 후 교체하고 기존 offset·데이터·전역 plugin은 지우지 않는다. setup은 서버를 시작하지 않는다.
3. 기존 OTel SDK/appender를 먼저 재사용해 **실제 LogRecord**를 `http://127.0.0.1:<otel_port>/v1/logs`로 보낸다. 없는 경우 source와 버전에 맞는 공식 OpenTelemetry Java agent를 외부 개발 도구로 고정해 설치하고 `-javaagent:<실제 경로>`와 `-Dotel.javaagent.configuration-file=<생성된 otel-javaagent.properties>`를 **개발 실행 profile에만** 연결한다. 서비스명과 `diag.project.id`, `deployment.environment.name`, `diag.contract.version`을 프로젝트 실제 값으로 설정한다. Java agent/SDK 두 개를 중복 연결하지 않는다. 기존 trace/MDC bridge와 실제 context를 유지하고 async/WebSocket 전달·정리를 검토한다. SDK/appender·agent 버전·경로를 확인하지 못하면 정확한 미완료 범위를 보고한다. production build/image/classpath에 agent나 개발 registry를 넣지 않는다.
4. [진단 v1 계약](assets/diagnostic-log-schema.md)의 Timestamp·EventName·Resource·Attributes·Trace/Span을 SDK/appender의 대응 필드에 매핑한다. JSON 전체를 Body 문자열에 넣지 않는다. agent의 일반 logger 자동 수집만으로 domain operation/retry/state의 v1 구현이 완료되었다고 주장하지 않는다. typed emitter가 필요하면 실제 facade/adapter에서 구현한다. 원본 JSONL을 보존할 때는 session의 `runtime/services/<service>/diagnostic.jsonl`, 일반 Spring Logstash 파일은 application.jsonl을 사용한다. 파일은 오프라인 검증 근거이며 Collector가 tail하지 않는다. 같은 이벤트를 SDK와 agent 양쪽에서 중복 전송하지 않는다.
5. Spring Actuator와 `micrometer-registry-prometheus`의 실제 존재·Boot 호환성을 확인한다. 필요하면 Gradle 개발 configuration 또는 Maven 개발 profile에만 의존성을 추가하고 production artifact에서 제외되는 빌드 경로를 확인한다. 기존 `spring.config.additional-location`을 보존해 `spring-local.properties`를 개발 config로 연결한다. 기존 endpoint 노출·인증 규칙을 보존하면서 health/prometheus만 필요한 범위에 추가한다. CLI의 실제 URL을 `/actuator/prometheus` 기본 경로나 8080 포트로 임의 덮어쓰지 않는다. management 별도 포트/base path도 반영한다. `scrape.json`은 명시한 scrape_url을 프로젝트/서비스 label로 구분한다. 앱 기준 metrics_url과 혼동하지 않는다. Docker Desktop/WSL의 localhost 앱은 보통 host.docker.internal:<실제 port/path>를 사용하며 CLI가 별도 확인한다. target 변경 후 setup을 재실행한다.
6. 각 앱의 개발 실행 profile에 실제 인자/env/config_inputs를 연결하고 필요한 helper readiness 검사를 `node .codex/scripts/harness-victorialogs.mjs check --root <workspace_root>`로 직접 수행한다. config.json·otel-javaagent.properties·spring-local.properties·실제 앱 config/build/agent 경로를 실행 전 검증한다. 각 프로젝트의 EXEC/execution.json도 함께 갱신한다. 기본 compose bridge를 사용한다. 내부는 0.0.0.0의 고정 port, host 공개는 127.0.0.1의 설정 port다. 앱→Collector는 host 공개 localhost, Collector/MCP→backend는 compose service DNS, Metrics→WSL 앱은 명시적 scrape_url을 사용한다. host.docker.internal은 컨테이너 기준 DNS다. Linux native Docker는 실제 접근 가능한 host IP/service DNS를 입력한다. 전역 WSL·방화벽 설정을 바꾸거나 앱을 외부에 노출해 우회하지 않는다.
7. 필요할 때 `node .codex/scripts/harness-victorialogs.mjs start|check|stop --root <workspace_root>` 명령을 직접 실행한다. 실제 사용자 흐름을 E2E로 검증할 때만 `harness-exec` profile을 사용한다. check는 Collector와 두 backend API만 검사하며 실제 수집 검증과 구분한다. 실행 검증이 요청되면 앱 readiness, 비밀값 없는 실제 오류/operation 한 건 검색, `up{project="...",service="..."}`의 최신 값 1을 확인하고 소유 프로세스만 정리한다. 설치 확인을 이유로 E2E를 추가하지 않는다.
8. 생성한 mcp.json의 victorialogs와 victoriametrics 두 stdio 항목을 MCP 클라이언트에 연결한다. provider 설정을 자동 덮어쓰지 않는다. MCP 클라이언트는 helper의 `mcp`/`mcp-metrics`를 직접 호출해 stdout 프로토콜을 보존한다. 두 공식 이미지 모두 내장 documentation 도구를 끈다. MCP는 자동 장애 감시나 runtime query quota가 아니다.
9. 원본 진단 JSON/JSONL은 HARNESS_DIAGNOSTIC_LOG_FILE을 지정해 `victorialogs-diagnostic-logs` profile로 Docker 없이 검증한다. 조회는 최근 15분·100건부터 project/service/trace로 좁힌다. OTLP 저장 필드인 `event_name`, `trace_id`, `diag.operation.id`, `diag.duration_ms`를 사용하며 논리 JSON의 Resource/Attributes 접두사를 그대로 검색하지 않는다. 메트릭 비교는 같은 workload·기간·revision·오류율을 명시하고 trace/request ID를 metric label로 넣지 않는다. 실패 학습 상태와 실제 검증 결과는 별개다.
10. `sync-contracts`로 Collector·두 backend·MCP 경계와 개발 전용 의존성을 반영한다. configuration-only 준비, 실제 앱 instrumentation, 수집, MCP 조회의 확인 범위를 따로 보고한다.

## 공식 근거

- [VictoriaLogs OTLP](https://docs.victoriametrics.com/victorialogs/data-ingestion/opentelemetry/)
- [OpenTelemetry Java agent](https://opentelemetry.io/docs/zero-code/java/agent/)
- [VictoriaMetrics scrape](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/)
- [공식 Logs MCP](https://github.com/VictoriaMetrics/mcp-victorialogs) · [공식 Metrics MCP](https://github.com/VictoriaMetrics/mcp-victoriametrics)
- [Spring Boot Prometheus](https://docs.spring.io/spring-boot/reference/actuator/metrics.html)
