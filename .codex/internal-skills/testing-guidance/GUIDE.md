<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# testing-guidance

This guidance is plain Markdown and independent of agent provider or test framework. It records durable project-specific test execution preferences; ordinary commands remain in `docs/agents/EXEC.md`; `docs/agents/execution.json` is reserved for explicit end-user E2E profiles.

## Record

Maintain `docs/agents/testing-guidance.md`. The caller supplies `shared_guidance_root`: the absolute original project root (`return_root` for a managed worktree). Read and write the canonical file at `<shared_guidance_root>/docs/agents/testing-guidance.md`, never a worktree-local copy, so changes are immediately visible to every linked worktree. Create it from `references/template.md` when needed.

Record explicit reusable user preferences and settled lessons from completed workflow evidence. After an E2E failure is diagnosed, the workflow owner must decide whether it reveals a reusable project testing procedure: repeated causes and confirmed cross-run setup mistakes must update this canonical file when the prevention action is a durable instruction. The owner must follow the E2E failure-learning route and link its incident lesson and execution contract. Every entry includes scope, instruction, rationale, provenance and date. Keep incident-specific failure analysis in the project verification/lesson document. Ordinary commands and operator procedures belong in `docs/agents/EXEC.md`; only E2E profile values belong in `docs/agents/execution.json`. For a reusable failure-prevention procedure, update this guidance as well and link to those contracts instead of duplicating their exact values. Do not convert an unverified hypothesis into guidance. Mark replaced instructions as superseded rather than silently deleting their history. The workflow owner maintains this file; ordinary test runners only collect evidence and do not edit guidance.

## Read

Every implementation worker reads `<shared_guidance_root>/docs/agents/testing-guidance.md` before planning, writing, modifying, selecting, or running tests. Apply only matching entries. If it conflicts with an approved plan or execution contract, stop and report the conflict for resolution. The project native CLI command in EXEC is authoritative for ordinary checks. An E2E profile is authoritative only for the final user-flow test.

For scoped Spring Boot diagnostic logging changes, use the project-owned `docs/observability/victorialogs/diagnostic-log-schema.md` and JSON schema. The installed `victorialogs-local-setup` assets supply the v1 contract; its setup helper records the matching reusable guidance in the canonical shared documents. Keep general framework logs distinct from diagnostic events. Do not claim source schema validation proves runtime context propagation, redaction or live ingestion.

## 비즈니스 로직 단위 테스트

단위 테스트는 해당 모듈이 소유한 업무 판단·계산·상태 전이·불변식·업무상 거부 조건을 실행 가능한 요구사항 명세로 관리한다.

- 승인된 Product Spec의 UC/BR/AC와 규칙 owner를 연결하고, 테스트 이름은 조건과 기대 업무 결과를 설명한다.
- 준비 조건 → 업무 행위 → 관찰 가능한 결과 형식으로 정상·경계·거부 사례를 표현한다. 같은 규칙의 사례는 함께 관리한다.
- 구현은 승인 Spec에 따라 진행하고, 변경된 비즈니스 규칙을 단위 테스트 사례에 반영한다. 작성·선실행·실패 확인 순서 대신 요구사항과 구현·사례의 일치를 기준으로 삼는다.
- 계획·구현에서 새로 만들거나 수정하는 테스트는 비즈니스 로직 단위 테스트로 한정한다. getter/setter·프레임워크·단순 위임·직렬화·배선·mock 호출 횟수와 통합·계약·E2E 테스트는 이 범위에서 만들지 않는다. 기존 필수 검증 명령과 완료 gate는 테스트 생성과 별도로 실행할 수 있다.
- 별도 모듈의 업무 규칙은 그 owner의 테스트를 사용하고, 현재 모듈은 의존 결과를 받아 수행하는 자신의 업무 판단만 검증한다.
- 요구가 바뀌면 연결된 사례와 기대 결과를 함께 갱신한다. 내부 리팩터링 후에도 업무 결과가 같으면 같은 명세 사례를 유지한다.

실제 테스트 실행 명령과 결과 증거는 기존 실행 profile·검증 절차를 따른다.

## 테스트 작성 원칙과 시점

- 테스트는 시스템이 보장하는 동작을 설명하는 실행 가능한 명세다. 각 split plan은 구현 단계마다 소유한 비즈니스 규칙 단위 테스트를 작성·갱신하고 실행한다. 사례는 해당 plan의 승인된 UC/BR/AC, 조건, 업무 행위, 기대 결과에 연결한다.
- 실패 유형과 입력 조합을 전부 열거하지 않는다. 비즈니스 규칙에 따른 별도 결과가 중요할 때만 경계·거부 사례를 테스트한다. 예를 들어 지원하지 않는 결제 수단의 거부는 테스트하지만, 일반적인 자료형 오류를 비즈니스 로직 단위 테스트로 반복하지 않는다.
- 단위 테스트는 외부 의존성을 모킹한다. plan별 단위 테스트 통과는 각 plan의 완료에 필요하다.
- 모든 split plan의 구현과 개별 검증, 계획된 통합 절차가 끝난 뒤 feature-level E2E를 마지막에 실행한다. 필요한 실제 의존성은 테스트 전용 별도 컨테이너에서 실행한다. E2E는 plan별 사례를 반복하지 않고 통합된 사용자 흐름과 관찰 가능한 결과를 확인한다.
- 비결정적 출력은 전체 문자열로 고정 비교하지 않는다. 형식, 필수 정보, 허용 범위, 규칙 위반 여부, 저장·도구 호출 등 관찰 가능한 계약을 검증한다. 자연스러움·관련성 같은 품질 평가는 기능 테스트와 분리한다.
- 테스트 간 데이터, 실행 순서, 전역 상태 의존을 금지한다. 각 테스트를 단독·병렬로 실행할 수 있게 데이터와 리소스를 격리하고 생성 자원을 정리한다. 비동기 동작은 임의 sleep 대신 완료 조건과 제한 시간을 사용한다.
- 프레임워크 설명문, 표시 이름, 태그, 문서화 주석으로 테스트가 검증하는 동작과 작성 의도를 실행 결과에서 확인할 수 있게 한다. 테스트 이름만으로 충분하면 별도 주석은 생략한다.
- 일반 단위·회귀 검증은 `docs/agents/EXEC.md`의 기본 CLI 명령으로 수행한다. 명시적 사용자 흐름 E2E만 `purpose: "e2e"` execution profile과 readiness 설정을 사용한다.
