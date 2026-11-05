# Testing and verification guidance

This provider-neutral document stores durable project-specific testing preferences for this workspace. A managed workflow reads and updates the copy in its active worktree so the durable memory change can be reviewed and pushed with that branch. Ordinary verification commands belong in `docs/agents/EXEC.md` and run through native project CLIs. `docs/agents/execution.json` is reserved for explicit end-user E2E profiles.

## Active guidance

### harness-black-box-calculator-workflow
- Status: active
- Applies to: 사용자가 요청하는 Harness workflow E2E 실행
- Guidance: `docs/agents/EXEC.md`의 정본 시나리오를 그대로 사용한다. 테스트 저장소는 `/home/jiwoo/workspace/harness-test`다. 승인된 소스 commit/push → consumer 갱신 → 명시적으로 요청한 기존 worktree 백업/삭제 → main/clean 확인 뒤 `codex exec`로 `$orchestrator 계산기 웹 앱 만들어. 유저 인증과 커뮤니티 기능 있어야 해`를 실행한다. 실제 응답의 worktree에서 별도 `codex exec`로 `$orchestrator 계속 진행해`를 실행해 spec-me 진입부터 implement 완료까지 관찰하고 멈춘 뒤 산출물을 검증한다. 중단·실패·질문·승인 대기에 임의로 개입하거나 답변·위임·상태 수정·자동 재실행을 하지 않는다. 다른 작은 기능·fixture·eval replay·단위 테스트를 이 E2E의 대체로 보고하지 않는다.
- Rationale: 실제 사용자의 두 orchestrator 호출 경로를 반복 가능한 방식으로 검증한다.
- Source: 2026-11-05 사용자의 저장소·원문 명령·실행 순서·개입 금지 직접 지시
- Updated: 2026-11-05

### final-e2e-explicit-approval
- Status: active
- Applies to: implement-wrapper의 최종 E2E
- Guidance: 기존 implement-wrapper로 tracker의 split plan을 하나씩 구현·검증·리뷰한다. 전체 구현 후 Spec 기반 통합 코드 리뷰를 통과해야 최종 E2E를 준비한다. 에이전트가 시나리오·기대 결과·실제 실행 조건을 작성하고 사용자에게 최종 실행 승인을 받은 뒤 실행한다. 실패·timeout·환경 차단·cleanup 실패 시 증거와 소유 자원 정리만 수행하고 사용자 확인 전 코드·테스트·실행 설정 수정이나 재실행을 하지 않는다. 재시도 budget과 과거 계획 승인은 이 확인을 대신하지 않는다.
- Rationale: 통합 검증의 범위와 실패 후 조치를 사용자가 결정한다.
- Source: 2026-11-05 사용자 요청 및 기존 implement-wrapper 재사용 지시
- Updated: 2026-11-05

### planning-and-implementation-unit-tests-only
- Status: superseded
- Applies to: 계획·구현 단계의 테스트 계획·작성·갱신
- Guidance: 계획과 구현은 비즈니스 로직 단위 테스트만 추가·수정한다. 테스트는 해당 모듈이 소유한 UC/BR/AC의 조건·행위·기대 업무 결과만 검증한다. 비즈니스 로직 변경이 없으면 테스트를 추가하지 않는다. 통합·계약·E2E 테스트와 프레임워크 배선·직렬화·mock 호출·단순 위임 테스트를 만들지 않는다. 기존 필수 검증 명령·완료 gate는 테스트 작성 범위와 분리해 실행할 수 있다. 상세 기준은 `.codex/internal-skills/testing-guidance/GUIDE.md`를 따른다.
- Rationale: 테스트를 업무 규칙의 실행 가능한 명세로 한정하고 비즈니스 로직에 대한 오판을 줄인다.
- Source: 2026-10-26 사용자 요청 — “단위 테스트만 만들도록 해 플랜 및 구현에서. 그리고 단위 테스트는 비즈니스 로직만 테스트해. 비즈니스 로직이 제대로 동작하는지에 대해서만 해”
- Updated: 2026-10-26

### per-plan-unit-tests-and-final-e2e
- Status: active
- Applies to: split-plan test planning, implementation, and final feature verification
- Guidance: `to-ticket` plans owned business-rule unit tests per split plan and one feature-level E2E scenario at the plan-set parent. Each implementation writes/updates and runs its unit tests before that split plan completes; unit tests mock external dependencies and remain independent. After all split plans pass review and verification and are integrated, run the parent E2E once as the final test step using real required dependencies in test-only containers. Do not run E2E at individual plan boundaries.
- Rationale: Specify business behavior per implementation slice and verify the integrated user journey once when the complete feature exists.
- Source: 2026-10-27 user request — each split plan gets unit tests during implementation; run E2E last after implementing all split plans
- Updated: 2026-10-27

### business-rule-unit-specifications
- Status: superseded
- Applies to: 이 프로젝트의 구현·단위 테스트 작성·계획·리뷰
- Guidance: 단위 테스트는 해당 모듈이 소유한 비즈니스 로직만 대상으로 UC/BR/AC와 연결된 조건·업무 행위·기대 결과 사례로 관리한다. 테스트 우선 작성·선실행·Red 확인을 요구하지 않는다.
- Rationale: 새 기준은 비즈니스 로직 단위 테스트만 계획·작성하도록 범위를 더 좁혔다.
- Source: 2026-10-25 사용자 요청
- Updated: 2026-10-25

### opentelemetry-local-observability-v2
- Status: active
- Applies to: Spring Boot 로컬 관측성 설치·개발 실행·수집 검증
- Guidance: OpenTelemetry Collector → VictoriaLogs 로그 경로와 Actuator → VictoriaMetrics 메트릭 경로, 공식 MCP 두 개를 사용한다. Vector/Fluent Bit을 설치하지 않는다. setup CLI가 포트·보존 기간·프로젝트/서비스 식별자·실제 Actuator URL을 관리한다. SDK/appender 또는 개발 전용 외부 Java agent로 실제 OTel LogRecord를 export하며 진단 JSON을 Body 문자열에 중첩하지 않는다. Resource와 Attributes를 OTel 대응 필드로 매핑하고 실제 Trace/Span을 유지한다. Collector endpoint와 앱 profile의 설정을 함께 갱신한다. 앱별 실제 수집은 최근 로그 검색과 project/service별 최신 up=1로 확인하며 backend API readiness와 구분한다. production artifact에 개발 agent·registry를 포함하지 않는다. 데이터·queue·검증 출력은 session 내부에 두고 bridge의 host 공개 localhost·내부 service DNS·컨테이너 기준 scrape_url을 구분해 EXEC에 기록한다. Docker Desktop/WSL 앱 접근은 host.docker.internal을 사용하고 포트/path를 유지한다. 원본 metrics_url만 바꾸고 scrape를 방치하지 않는다. 연결 probe는 listener의 실제 기동과 내부 known-response를 먼저 확인한 뒤 방향·bind·접속 주소별로 판정한다. 필수 경로 실패는 nonzero로 종료하고 프로세스 exit=0만으로 연결 성공을 주장하지 않는다. schema 검사만을 위해 E2E를 실행하지 않는다.
- Rationale: 합의한 OTel 수집과 메트릭 경로를 설치·실행·진단에서 동일하게 사용한다.
- Source: 2026-10-22 사용자 인프라 구성도 및 Vector 대신 OpenTelemetry 사용 정정
- Updated: 2026-10-22

### run-with-complete-runtime
- Status: active
- Applies to: tests, services, and infrastructure for this project
- Guidance: For ordinary unit and regression checks, use the documented native project CLI. For explicit end-user E2E only, verify required infrastructure, arguments, environment, and current configuration through its execution profile before launch.
- Rationale: The user wants tests to fail closed when runtime prerequisites or configuration are omitted.
- Source: 2026-10-20, user instruction on repeated incomplete test/service startup
- Updated: 2026-10-20

### keep-test-output-in-session
- Status: active
- Applies to: every test and service verification run
- Guidance: Store logs, screenshots, temporary files, and run evidence only under the run's session directory. Preserve every E2E failure and its original evidence until its cause has been addressed and the affected path reverified.
- Rationale: Keep project worktrees clean and prevent failed scenarios from being lost between runs.
- Source: 2026-10-20, user instructions on session output boundaries and learning from E2E failures
- Updated: 2026-10-20

### selective-e2e-and-dynamic-agent-oracles
- Status: superseded
- Applies to: test planning, implementation verification, and E2E runner handoffs
- Guidance: Use focused unit/integration/contract checks by default; E2E is limited to explicit requests or approved critical cross-boundary risk.
- Rationale: Planning and implementation now create business-logic unit tests only under the newer user instruction.
- Source: 2026-10-21, explicit user preference on unnecessary E2E execution and dynamic agent response assertions
- Updated: 2026-10-21

### spring-boot-diagnostic-log-v1
- Status: active
- Applies to: Spring Boot 진단 emitter·관련 작업 흐름·로그 수집/조회 변경의 집중 검증
- Guidance: 프로젝트 진단 v1 계약과 diagnostic-log.schema.json을 읽고 emitter가 실제 출력한 원본 JSONL의 필수 필드·타입·catalog별 outcome/duration/error/retry/state를 검사한다. 테스트 fixture만으로 실제 앱 준수를 주장하지 않는다. 활성 Trace/Span 조건, 동일 operation의 재시도/parent/correlation 연결, async·WebSocket context 전달 및 MDC 정리, monotonic duration, 비밀값 redaction과 완결된 작업의 terminal 이벤트를 관련 seam에서 검증한다. 가변 메시지 exact match나 이벤트 severity 고정 assert를 만들지 않는다. schema 검사는 Docker 없이 victorialogs-diagnostic-logs profile로 실행하며 HARNESS_DIAGNOSTIC_LOG_FILE을 원본 파일로 지정한다. VictoriaLogs OTLP query는 접두사 없는 event_name·trace_id·service.name·diag.* 필드를 사용하고 원본 숫자 타입과 저장소 문자열 표현을 구분한다. 지연 비교는 같은 workload/기간/revision·표본 outcome·오류율을 포함한다. 로그 검증만을 위해 E2E를 추가 실행하지 않으며 실패 학습 pending이 실제 테스트 결과를 덮지 않는다.
- Rationale: 형식 오류와 실제 context/동작 오류를 구분하고 근거 없는 오류율·성능 판정을 막는다.
- Source: 2026-10-22 사용자가 제공한 Spring Boot Diagnostic Log Schema v1 및 구현·테스트 지침 반영 요청
- Updated: 2026-10-22

## Superseded guidance
