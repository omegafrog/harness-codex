# Spring Boot Diagnostic Log Schema v1

계약 버전: `1.0` · 수정일: 2026-10-22 · 근거: 사용자가 제공한 Spring Boot Diagnostic Log Schema v1.

정본 기계 스키마는 [diagnostic-log.schema.json](diagnostic-log.schema.json), 예시는 [diagnostic-log.example.json](diagnostic-log.example.json)이다. 이 JSON은 OTel 데이터 모델을 따른 **정규화된 논리 표현**이며 OTLP wire JSON/protobuf가 아니다. OTLP를 쓸 때는 SDK/exporter에서 해당 표현으로 매핑하고 원시 OTLP 요청을 JSON line ingestion에 보내지 않는다.

## 계층과 Core

Core는 OTel LogRecord, Resource는 OTel Semantic Conventions와 diag 확장, Correlation은 OTel Trace Context와 diag 확장이다. Operation/Error/Retry/State는 아래 계약을 사용하며 추가 속성은 프로젝트가 소유한다.

| 필드 | 타입 | 요구사항 |
| --- | --- | --- |
| Timestamp | RFC3339 timestamp string | 이벤트 발생 시각, 필수 |
| ObservedTimestamp | RFC3339 timestamp string | 수집 관측 시각, 선택 |
| SeverityNumber | integer 0..24 | OTel 심각도, 권장 |
| SeverityText | string | TRACE/DEBUG/INFO/WARN/ERROR 등, 권장 |
| Body | any JSON value | 메시지/구조화 본문, 권장 |
| EventName | string | 진단 이벤트에서 필수, 아래 catalog |
| TraceId | 32자 hex string | Trace context가 있으면 필수; 0으로만 구성한 ID 금지 |
| SpanId | 16자 hex string | 활성 Span이 있으면 필수; 0으로만 구성한 ID 금지, TraceId 동반 |
| TraceFlags | integer 0..255 | Trace flags, 선택 |
| Resource | object | 필수 |
| Attributes | map | 진단 이벤트에서 필수 |

Timestamp/Resource 필수는 Harness 계약이며 OTel 원본의 모든 직렬화·존재 조건을 재정의하지 않는다. 이 스키마 파일은 diagnostic.jsonl의 진단 이벤트를 검증하므로 EventName/Attributes가 필수다. 일반 framework 로그는 별도 application.jsonl에 남기고 v1 준수라고 표시하지 않는다. 심각도 권장은 오류 이벤트의 고정 assert가 아니다.

## Resource

| 필드 | 타입 | 요구사항 / 설명 |
| --- | --- | --- |
| service.name | string | 필수, 실제 서비스 이름 |
| service.namespace | string | 권장, 서비스 그룹 |
| service.version | string | 권장, 실행 애플리케이션 버전 |
| deployment.environment.name | string | 필수, local/test/staging/production 등 |
| diag.project.id | string | 필수, Harness 프로젝트 ID |
| diag.contract.version | string | 필수, 이 계약은 1.0 |
| vcs.ref.head.revision | string | 권장, 실행 중인 코드의 실제 Git commit |
| host.name | string | 선택 |
| process.pid | integer | 선택 |
| container.id | string | 선택 |
| service.instance.id | string | 권장 |

프로젝트 ID와 환경은 실행 config에서 정하며 서로 다른 프로젝트/환경을 혼합하지 않는다. source revision은 실제 실행 코드의 provenance다. 새 HEAD를 이전에 실행한 프로세스의 revision으로 적지 않는다. instance ID는 같은 서비스의 다른 실행을 구분한다.

## Attributes: Correlation과 Operation

| 필드 | 타입 | 요구사항 |
| --- | --- | --- |
| diag.operation.name | string | 진단 작업 이벤트 필수, document.extract 등 안정적인 작업 종류 |
| diag.operation.id | string | 진단 작업 이벤트 필수, 논리적 작업 인스턴스 |
| diag.operation.parent_id | string | 상위 작업이 있으면 기록 |
| diag.correlation.id | string | 여러 Trace에 걸친 장기 workflow를 연결할 때 기록 |
| diag.attempt | integer ≥ 1 | 재시도 가능한 작업과 개별 시도/재시도 이벤트에 기록 |
| diag.outcome | success/failure/cancelled | 작업 종료 이벤트 필수 |
| diag.duration_ms | integer ≥ 0 | 작업 종료 이벤트 필수, 전체 논리 작업의 경과 시간 |

재시도 중에는 operation.id를 유지하고 attempt를 구분한다. 하위 논리 작업은 새 operation.id와 parent_id를 사용한다. TraceId를 operation.id/request ID에서 임의 합성하지 않는다. 활성 Trace가 없으면 TraceId/SpanId를 생략할 수 있다. 비동기 executor·CompletableFuture·WebSocket·메시지 소비 경계의 context 전달과 종료 후 MDC 정리를 실제 source로 확인한다. duration은 monotonic clock 차이를 ms 정수로 기록하며 wall clock 보정이나 시각 차이로 음수가 되지 않게 한다.

## Attributes: Error

| 필드 | 타입 | 요구사항 |
| --- | --- | --- |
| diag.error.code | string | 실패 이벤트 필수, 안정적인 오류 코드 |
| error.type | string | 권장, 기술적 오류 유형 |
| exception.type | string | 실제 예외 발생 시 Java 예외 클래스 |
| exception.message | string | 선택, 민감정보 제거 |
| exception.stacktrace | string | 진단상 필요한 예외에서 기록, 민감정보 제거 |
| diag.error.retryable | boolean | 권장 |
| diag.error.category | enum | 권장, 아래 분류 |
| diag.error.dependency | string | 외부 의존성 실패 시 기록 |

category: validation, dependency, timeout, network, resource, concurrency, configuration, internal, cancelled. 안정적인 code로 집계하고 변하는 message나 Throwable.toString을 code로 사용하지 않는다. prompt·payload 원문·인증 header·token·비밀값·개인정보를 message/stacktrace/확장 속성에 넣지 않는다. 예상된 비즈니스 거절은 INFO/WARN으로 기록할 수 있다.

## Attributes: Retry와 State

| 필드 | 타입 | 요구사항 |
| --- | --- | --- |
| diag.retry.next_attempt | integer ≥ 2 | 재시도 예약 시 필수 |
| diag.retry.delay_ms | integer ≥ 0 | 재시도 예약 시 필수 |
| diag.state.from | string | 상태 이벤트 필수 |
| diag.state.to | string | 상태 이벤트 필수 |
| diag.state.reason | string | 선택 |

Retry는 operation.name/id·현재 attempt와 연결한다. 실패 때문에 재시도하면 error.code와 retryable을 함께 남긴다. State는 같은 operation.name/id에서 주요 상태 전이를 기록한다. 최종 작업 실패와 개별 시도 실패를 구분한다.

## Event catalog

모든 Attributes 이름에는 diag. 접두사가 적용된다. 모든 행은 operation.name/id와 Resource 필수 필드를 공통 요구한다.

| EventName | 추가 필수 Attributes | 기본 SeverityText | outcome |
| --- | --- | --- | --- |
| diag.operation.started | 없음 | DEBUG | 없음 |
| diag.operation.completed | outcome, duration_ms | INFO | success |
| diag.operation.failed | outcome, duration_ms, error.code | ERROR | failure |
| diag.operation.cancelled | outcome, duration_ms | INFO | cancelled |
| diag.attempt.failed | attempt, error.code | WARN | 없음 |
| diag.retry.scheduled | attempt, retry.next_attempt, retry.delay_ms | INFO | 없음 |
| diag.state.changed | state.from, state.to | INFO | 없음 |

## Spring Boot와 수집·조회

개발 실행만 외부 logging config로 연결한다. 기본 spring-local.properties의 Logstash 설정은 framework 로그용이며 v1 이벤트 emitter가 아니다. 실제 프로젝트의 기존 logging facade/adapter에 typed 진단 emitter와 OTel SDK/appender를 연결하고 production build에 불필요한 수집 dependency를 추가하지 않는다. logger 호출 안의 문자열 JSON을 일반 message에 중첩해 v1 이벤트를 흉내 내지 않는다.

원본 검증 파일은 `${HARNESS_SESSION_DIR}/runtime/services/<service>/diagnostic.jsonl`, 일반 로그는 같은 디렉터리의 application.jsonl이다. 한 줄당 이벤트 하나이며 Throwable stacktrace의 줄바꿈은 JSON escape로 기록한다. 이 JSON은 SDK/appender에서 실제 OTel LogRecord로 매핑하고 **OTLP HTTP**로 Collector에 전송한다. Collector는 파일을 tail하지 않으며 `/insert/opentelemetry/v1/logs`에 protobuf로 export한다. 기본 Java agent의 일반 message 수집이 domain 진단 v1 매핑을 대신하지 않는다. OTel Resource와 LogRecord attributes는 별도 필드이며 JSON의 Resource/Attributes wrapper를 문자열화하지 않는다. VictoriaLogs의 OTLP 경로는 접두사 없이 키를 저장한다. **원본 JSONL에서 타입을 검증**하고 query 결과의 string을 emitter 타입 오류로 단정하지 않는다.

| 논리 필드 | OTel / VictoriaLogs 역할 |
| --- | --- |
| Timestamp | time_unix_nano / _time |
| Body | typed body / _msg 또는 구조화 body 필드; 실제 결과 확인 |
| EventName | event_name / event_name |
| Resource.service.name | resource.attributes[service.name] / service.name, stream field |
| Resource.diag.project.id | resource.attributes[diag.project.id] / diag.project.id, stream field |
| Resource.deployment.environment.name | resource.attributes[deployment.environment.name] / deployment.environment.name, stream field |
| diag.operation.id | attributes[diag.operation.id] / diag.operation.id |
| diag.duration_ms | attributes[diag.duration_ms] / diag.duration_ms, 수치 통계 |
| TraceId / SpanId | actual trace_id / span_id |

operation ID·trace ID·request ID는 높은 cardinality라 stream field로 설정하지 않는다. 기본 진단 쿼리는 시간·프로젝트·서비스부터 제한한다.

```text
_time:15m event_name:="diag.operation.failed"
_time:15m trace_id:="4bf92f3577b34da6a3ce929d0e0e4736"
_time:1h event_name:="diag.operation.completed" diag.operation.name:="external-api.request" | stats count() as calls, avg(diag.duration_ms) as avg_ms, quantile(0.95, diag.duration_ms) as p95_ms
```

completed-only 통계는 성공 표본이다. 실패·취소를 포함한 전체 latency가 필요하면 terminal 이벤트 세 종류를 모두 포함하고 outcome별 count·오류율과 workload/기간/소스 revision을 같이 비교한다. 동적 메시지 exact match 대신 code·operation·상태·correlation과 실제 side effect를 검증한다.

## 검사

설치된 `victorialogs-diagnostic-logs` 실행 profile은 `HARNESS_DIAGNOSTIC_LOG_FILE`이 가리키는 원본 JSONL 또는 단일 JSON 예시를 검사한다. 이 검사는 Docker/서버 없이 실행된다. profile의 인자·env·설정 원본은 EXEC/execution.json에서 함께 관리한다. 예시 파일만 통과한 결과로 실제 앱 emitter/context propagation·redaction·수집·MCP 연결까지 검증됐다고 주장하지 않는다.

Source: [OTel LogRecord](https://opentelemetry.io/docs/specs/otel/logs/data-model/) · [VictoriaLogs OTLP ingestion](https://docs.victoriametrics.com/victorialogs/data-ingestion/opentelemetry/) · [VictoriaLogs 중첩 필드 저장](https://docs.victoriametrics.com/victorialogs/keyconcepts/).
