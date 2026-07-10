# 구현 계획

## 1. 구현 목표
- ChangeSet: `ISSUE-472` / PR `#473`
- Work item: `MAINT-472-XML-CONTRACT` (`maintenance`)
- Slice path: verdict-only verifier output과 기존 XML handoff/runtime service 계약 정합화
- 목표: 새 XSD를 추가하지 않고 `verification-report`, `gate-verdict`, `runtime-services` 계약을 기존 `harness-handoff-v1.xsd`와 `xml_handoff.py`에 통합하여 XML 기록 단계의 계약 위반과 blocking을 제거한다.
- Maintenance verification goal: PASS/FAIL/BLOCKED verification report와 runtime service manifest가 XML round-trip을 통과하고, routing/remediation 필드가 모든 중첩 위치에서 거부된다.

## 필수 입력
- present: Issue `#472`의 gate/verifier verdict-only 계약.
- present: PR `#473`의 `structured_verify_work_item_xml.py`, `runtime_services.py`, `verification_failure.py` 구현.
- present: 기존 공용 XSD `schemas/harness-handoff-v1.xsd`와 XML reader/writer `harness_codex/runtime/xml_handoff.py`.
- missing: 없음. 구현 중 legacy repair artifact의 read/write 참조가 남아 있는지만 repository search로 확정한다.

## 2. 구현하지 말아야 할 것
- orchestration adapter, selected-step handler, worktree/session lifecycle, CLI 복구를 구현하지 않는다.
- 새 XSD 또는 새 handoff envelope를 추가하지 않는다.
- verifier가 owner stage, resume target, retry, remediation route를 결정하도록 되돌리지 않는다.
- 기존 XML 직렬화 형식, namespace, schema version을 변경하지 않는다.
- PR `#473` 전체 구조를 재설계하거나 unrelated runtime service를 수정하지 않는다.

## 실행 경계
- 대상 bounded context/module: `harness_codex.runtime` XML handoff/verdict contract
- 대상 aggregate root: N/A - maintenance contract repair

### 수정 허용 경로
- `harness_codex/runtime/xml_handoff.py`
- `harness_codex/runtime/verification_failure.py`
- `harness_codex/runtime/runtime_services.py`
- `schemas/harness-handoff-v1.xsd`
- `tests/test_xml_handoff.py`
- `tests/test_verification_xml_contract.py`
- `tests/test_runtime_services.py`

### 수정 금지 경로
- `harness_codex/runtime/engine.py`
- `harness_codex/runtime/selected_step_runtime.py`
- `harness_codex/runtime/session_coordinator.py`
- `harness_codex/entrypoint.py`
- `.codex/agents/**`
- `.codex/skills/**`
- `.harness/workflows/**`
- `docs/plans/active/MAINT-472-XML-CONTRACT/plan.md` 외 문서

### 영향받는 기존 파일
- `harness_codex/runtime/structured_verify_work_item_xml.py`: 새 verification payload의 producer. 원칙적으로 수정하지 않고 계약 적합성을 integration test로 검증한다.
- `harness_codex/runtime/security_review_bundle_xml.py`: 기존 `approved/rejected` review verdict 소비 호환성을 읽기 전용으로 확인한다.
- `harness_codex/runtime/materialize_security_review.py`: 기존 review verdict 상태 소비 호환성을 읽기 전용으로 확인한다.

## 패키지 및 의존성 계약

### 생성/수정 클래스와 정확한 package
- `harness_codex.runtime.xml_handoff`: handoff type registry, 필수 필드, semantic validation, routing-key 재귀 검사.
- `harness_codex.runtime.verification_failure`: 공용 routing-key 검사 재사용 및 verdict classification 유지.
- `harness_codex.runtime.runtime_services`: registry schema 선언이 canonical XML 계약과 동일하도록 조정.

### 각 클래스의 layer와 책임
- XML envelope/XSD: namespace, envelope 구조, 지원 handoff type만 검증한다.
- `xml_handoff.py`: handoff type별 required field와 상태 조합을 검증한다.
- `verification_failure.py`: 실패 분류와 evidence 변환만 담당하며 routing 결정을 하지 않는다.
- `runtime_services.py`: 등록된 schema/gate/tool manifest를 생성하며 XML 계약을 별도로 재정의하지 않는다.

### 허용 의존성 방향
- `structured_verify_work_item_xml` -> `xml_handoff`
- `runtime_services` -> `xml_handoff`
- `verification_failure` -> `xml_handoff`의 routing-key 검사 helper
- XSD와 `_REQUIRED` type 목록은 테스트로 양방향 일치시킨다.

### 금지 import/framework dependency
- 새 XML/JSON schema 라이브러리 추가 금지.
- `xml_handoff.py`가 verifier, engine, orchestration 모듈을 import하는 역방향 의존 금지.
- import side effect, monkey patch, dynamic module replacement 금지.

### bootstrap/configuration wiring
- N/A - installer 호출 방식은 변경하지 않고 manifest write/read만 정상화한다.

## 계약 구현 규칙

### `verification-report`
- 필수 필드: `schema_version`, `change_set_id`, `work_item_id`, `run_id`, `status`, `plan_path`, `plan_sha256`, `verification_goal_path`, `evidence_items`, `verdict`, `failure_class`.
- 제거 필드: `owner_stage`, `recommended_resume_target`, `repair`.
- `status=PASS`는 `verdict.status=pass`와 `failure_class=null`만 허용한다.
- `status=FAIL`은 `verdict.status=fail|blocked`와 non-empty `failure_class`만 허용한다.
- `verdict`는 `status`, `rule_id`, `reason`, `evidence_path`, `violations`를 포함한다.
- `evidence_items`, `verdict.violations`, 최상위 `evidence`는 목록 형식을 유지한다.

### routing/remediation 금지
- `owner_stage`, `recommended_resume_target`, `resume_target`, `retry_target`, `repair`, `remediation_route`를 최상위와 모든 중첩 map/list에서 거부한다.
- 재귀 검사는 한 helper를 사용하고 `xml_handoff.py`와 `verification_failure.py`가 같은 규칙을 공유한다.

### `runtime-services`
- 기존 XSD type enumeration과 `_REQUIRED`에 추가한다.
- 필수 필드: `schema_version`, `schemas`, `gates`, `tools`.
- 세 목록은 non-empty string 목록이며 중복을 허용하지 않는다.

### `gate-verdict`
- runtime gate의 canonical status는 `pass|fail|blocked`로 고정한다.
- 기존 plan/security review가 사용하는 `approved|rejected`는 현재 consumer 호환을 위해 XML reader에서 허용한다.
- producer별 허용 status를 테스트로 고정하고 routing 필드는 추가하지 않는다.

### Legacy repair artifact
- branch 전체에서 실제 read/write 참조가 0개이면 XML type, `_REQUIRED`, 기존 XSD enumeration에 추가하지 않는다.
- legacy artifact reader/writer가 남아 있으면 이번 작업에서는 verification report에서 생성하거나 참조하지 않는다.
- 새 replacement schema/type은 만들지 않는다.

## 외부 계약 읽기 허용 목록
- verification payload producer 확인 -> `harness_codex/runtime/structured_verify_work_item_xml.py`
- review verdict backward compatibility 확인 -> `harness_codex/runtime/security_review_bundle_xml.py`, `harness_codex/runtime/materialize_security_review.py`
- runtime installer manifest 확인 -> `harness_codex/runtime/runtime_services.py`
- legacy repair artifact 잔존 여부 확인 -> repository 내 legacy repair marker와 `resume_target` 검색 결과

## 작업 체크리스트
- [ ] TASK-001 `harness_codex/runtime/xml_handoff.py`: `verification-report` required fields를 verdict-only 형태로 교체하고 PASS/FAIL/BLOCKED 상태 조합과 verdict 내부 타입을 검증한다.
- [ ] TEST-001 `tests/test_xml_handoff.py`: PASS, FAIL, BLOCKED payload의 write/read round-trip과 잘못된 상태 조합 거부를 추가한다.
- [ ] TASK-002 `harness_codex/runtime/xml_handoff.py`, `harness_codex/runtime/verification_failure.py`: routing/remediation key 재귀 검사를 공용화하고 최상위/중첩 payload를 동일하게 거부한다.
- [ ] TEST-002 `tests/test_verification_xml_contract.py`: verifier가 생성한 PASS/FAIL/BLOCKED XML이 성공하고 routing key가 없는지 검증한다.
- [ ] TASK-003 `schemas/harness-handoff-v1.xsd`, `harness_codex/runtime/xml_handoff.py`: `runtime-services`를 기존 handoff type 계약에 추가하고 manifest field/list 규칙을 구현한다.
- [ ] TEST-003 `tests/test_runtime_services.py`: `install_runtime_services(repo_root)`가 manifest를 기록하고 `load_runtime_services_manifest()`가 동일 payload를 반환하는지 검증한다.
- [ ] TASK-004 `harness_codex/runtime/xml_handoff.py`, `harness_codex/runtime/runtime_services.py`: `gate-verdict` status 의미를 runtime `pass|fail|blocked`와 기존 review `approved|rejected` 호환 규칙으로 정합화한다.
- [ ] TEST-004 `tests/test_xml_handoff.py`, `tests/test_runtime_services.py`: 허용 status는 통과하고 임의 status와 routing-shaped verdict는 실패하는지 검증한다.
- [ ] TASK-005 `schemas/harness-handoff-v1.xsd`, `harness_codex/runtime/xml_handoff.py`: legacy repair artifact 실제 참조를 조사하고 0개이면 XML 계약에 추가하지 않으며, 남아 있으면 deprecated 호환 없이 차단한다.
- [ ] TEST-005 `tests/test_xml_handoff.py`: XSD handoff type enumeration과 Python `_REQUIRED` key 집합이 정확히 일치하는 회귀 테스트를 추가한다.

## 집중 검증
- [ ] VERIFY-001 Syntax: `python3 -m py_compile harness_codex/runtime/xml_handoff.py harness_codex/runtime/verification_failure.py harness_codex/runtime/runtime_services.py harness_codex/runtime/structured_verify_work_item_xml.py` -> 모든 모듈 compile 성공.
- [ ] VERIFY-002 Focused tests: `python3 -m pytest -q tests/test_xml_handoff.py tests/test_verification_xml_contract.py tests/test_runtime_services.py` -> 전체 PASS.
- [ ] VERIFY-003 Integration: `python3 -m pytest -q tests/test_engine_runtime_integration.py tests/test_verification_xml_contract.py tests/test_runtime_services.py` -> verification XML write와 installer manifest 경로 PASS.
- [ ] VERIFY-004 Maintenance verification: 임시 repository에서 PASS/FAIL/BLOCKED verification payload와 `runtime-services.xml`을 write/read하고 원본 payload와 동일함을 테스트로 증명.
- [ ] VERIFY-005 Test gate: N/A - branch에 `.codex/test-gate.yaml`이 없으므로 focused pytest와 integration pytest를 authoritative evidence로 사용.
- [ ] VERIFY-006 Runtime server verification: N/A - 서버-visible behavior가 없는 XML contract maintenance 작업.
- [ ] VERIFY-007 Static analysis: `python3 -m compileall -q harness_codex/runtime` -> compile error 없음.

### 중단 조건
- 기존 review consumer가 `approved/rejected` 제거로 깨지는 경우 호환 status를 유지하고 별도 migration 없이 강제 전환하지 않는다.
- 기존 legacy repair artifact reader/writer가 남아 있으면 XML type을 추가하지 않고 차단한다.
- verifier payload에 routing 필드가 필요한 consumer가 발견되면 해당 consumer를 이번 범위에서 우회 수정하지 않고 계약 충돌로 보고한다.

## 9. OWASP Security Review
- pending `security_plan_reviewer`; attack surface: 외부 입력 XML의 중첩 map/list 검증, 임의 type/status 수용, manifest path write.

## 10. 완료 조건
- `verification-report`가 기존 routing 필드 없이 PASS/FAIL/BLOCKED XML round-trip을 통과한다.
- routing/remediation key가 모든 중첩 위치에서 거부된다.
- `install_runtime_services(repo_root)`가 `runtime-services.xml`을 기록하고 다시 읽는다.
- XSD type enumeration과 Python handoff type registry가 일치한다.
- 기존 plan/security review verdict 호환이 유지된다.
- 필요한 테스트가 존재하고 focused/integration verification이 통과한다.
- active -> completed 전이는 `complete-work-item-plan`만 수행한다.

## 11. 검증 결과
- Syntax: pending
- Focused tests: pending
- Integration: pending
- Maintenance verification: pending
- Test gate: N/A - `.codex/test-gate.yaml` 없음
- Runtime server verification: N/A - runtime surface 없음
- Static analysis: pending
