<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# testing-guidance

This guidance is plain Markdown and independent of agent provider or test framework. It records durable project-specific test execution preferences; exact commands and machine-checked startup requirements remain in `docs/agents/EXEC.md` and `docs/agents/execution.json`.

## Record

Maintain `docs/agents/testing-guidance.md`. The caller supplies `shared_guidance_root`: the absolute original project root (`return_root` for a managed worktree). Read and write the canonical file at `<shared_guidance_root>/docs/agents/testing-guidance.md`, never a worktree-local copy, so changes are immediately visible to every linked worktree. Create it from `references/template.md` when needed.

Record explicit reusable user preferences and settled lessons from completed workflow evidence. After an E2E failure is diagnosed, the workflow owner must decide whether it reveals a reusable project testing procedure: repeated causes and confirmed cross-run setup mistakes must update this canonical file when the prevention action is a durable instruction. The owner must follow the E2E failure-learning route and link its incident lesson and execution contract. Every entry includes scope, instruction, rationale, provenance and date. Keep incident-specific failure analysis in the project's verification/lesson document and exact commands/configuration in both `docs/agents/EXEC.md` and `docs/agents/execution.json`, with the executable profile values in JSON and operator procedure/readiness rationale in Markdown. When one changes, reconcile the other. For a reusable failure-prevention procedure, update this guidance as well and link to those contracts instead of duplicating their exact values. Do not convert an unverified hypothesis into guidance. Mark replaced instructions as superseded rather than silently deleting their history. The workflow owner maintains this file; ordinary test runners only collect evidence and do not edit guidance.

## Read

Every test runner and implementation worker reads this canonical document before choosing or starting tests. Apply only matching entries. If it conflicts with an approved plan or execution contract, stop and report the conflict for resolution. The project execution profile remains authoritative for exact commands, configuration, dependencies and readiness.

For scoped Spring Boot diagnostic logging changes, use the project-owned `docs/observability/victorialogs/diagnostic-log-schema.md` and JSON schema. The installed `victorialogs-local-setup` assets supply the v1 contract; its setup helper records the matching reusable guidance in the canonical shared documents. Keep general framework logs distinct from diagnostic events. Do not claim source schema validation proves runtime context propagation, redaction or live ingestion.

## 비즈니스 로직 단위 테스트

단위 테스트는 해당 모듈이 소유한 업무 판단·계산·상태 전이·불변식·업무상 거부 조건을 실행 가능한 요구사항 명세로 관리한다.

- 승인된 Product Spec의 UC/BR/AC와 규칙 owner를 연결하고, 테스트 이름은 조건과 기대 업무 결과를 설명한다.
- 준비 조건 → 업무 행위 → 관찰 가능한 결과 형식으로 정상·경계·거부 사례를 표현한다. 같은 규칙의 사례는 함께 관리한다.
- 구현은 승인 Spec에 따라 진행하고, 변경된 비즈니스 규칙을 단위 테스트 사례에 반영한다. 작성·선실행·실패 확인 순서 대신 요구사항과 구현·사례의 일치를 기준으로 삼는다.
- 단위 테스트 범위는 소유한 비즈니스 로직으로 한정한다. getter/setter·프레임워크·단순 위임·직렬화·배선·mock 호출 횟수는 그 자체로 단위 테스트 작성 대상이 아니다. 이 경계의 검증이 필요한 경우 목적에 맞는 통합·계약 검사로 다룬다.
- 별도 모듈의 업무 규칙은 그 owner의 테스트를 사용하고, 현재 모듈은 의존 결과를 받아 수행하는 자신의 업무 판단만 검증한다.
- 요구가 바뀌면 연결된 사례와 기대 결과를 함께 갱신한다. 내부 리팩터링 후에도 업무 결과가 같으면 같은 명세 사례를 유지한다.

실제 테스트 실행 명령과 결과 증거는 기존 실행 profile·검증 절차를 따른다.
