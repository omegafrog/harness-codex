### opentelemetry-local-observability-v2
- Status: active
- Applies to: Spring Boot 로컬 관측성 설치·개발 실행·수집 검증
- Guidance: OpenTelemetry Collector → VictoriaLogs 로그 경로와 Actuator → VictoriaMetrics 메트릭 경로, 공식 MCP 두 개를 사용한다. Vector/Fluent Bit을 설치하지 않는다. setup CLI가 포트·보존 기간·프로젝트/서비스 식별자·실제 Actuator URL을 관리한다. SDK/appender 또는 개발 전용 외부 Java agent로 실제 OTel LogRecord를 export하며 진단 JSON을 Body 문자열에 중첩하지 않는다. Resource와 Attributes를 OTel 대응 필드로 매핑하고 실제 Trace/Span을 유지한다. Collector endpoint와 앱 profile의 설정을 함께 갱신한다. 앱별 실제 수집은 최근 로그 검색과 project/service별 최신 up=1로 확인하며 backend API readiness와 구분한다. production artifact에 개발 agent·registry를 포함하지 않는다. 데이터·queue·검증 출력은 session 내부에 두고 bridge의 host 공개 localhost·내부 service DNS·컨테이너 기준 scrape_url을 구분해 EXEC에 기록한다. Docker Desktop/WSL 앱 접근은 host.docker.internal을 사용하고 포트/path를 유지한다. 원본 metrics_url만 바꾸고 scrape를 방치하지 않는다. schema 검사만을 위해 E2E를 실행하지 않는다.
- Rationale: 합의한 OTel 수집과 메트릭 경로를 설치·실행·진단에서 동일하게 사용한다.
- Source: 2026-10-22 사용자 인프라 구성도 및 Vector 대신 OpenTelemetry 사용 정정
- Updated: 2026-10-22

### spring-boot-diagnostic-log-v1
- Status: active
- Applies to: Spring Boot 진단 로깅과 이를 지원하는 Harness 변경
- Guidance: Spring Boot Diagnostic Log Schema v1(1.0)을 사용한다. 배포 정본은 victorialogs-local-setup/assets/diagnostic-log-schema.md와 diagnostic-log.schema.json이며 프로젝트에서는 docs/observability/victorialogs/에 둔다. Timestamp·EventName·Resource 필수 식별자·Attributes의 operation.name/id와 이벤트별 필드를 typed emitter에서 기록한다. framework application.jsonl과 v1 diagnostic.jsonl을 구분하고 JSON 문자열을 일반 message에 중첩하지 않는다. retry는 operation.id를 유지하고 attempt를 증가시키며 자식은 parent_id, 장기 흐름은 correlation.id로 연결한다. 실제 Trace/Span context만 기록하고 async/WebSocket에서 전달·정리한다. duration_ms는 monotonic clock 기반 정수이고 오류는 안정 code·category와 redacted exception을 기록한다. severity는 기본 권장이며 예상된 거절을 무조건 ERROR로 올리지 않는다. production build/dependency 분리와 session 출력 경계를 유지한다. 로깅 adapter·수집 매핑·조회·구현/테스트 지침·설치 경로를 함께 갱신한다.
- Rationale: 에이전트가 오류·시도·상태·지연을 일관된 구조와 실제 연관관계로 진단할 수 있어야 한다.
- Source: 2026-10-22 사용자가 제공한 Spring Boot Diagnostic Log Schema v1 및 구현·테스트 지침 반영 요청
- Updated: 2026-10-22
