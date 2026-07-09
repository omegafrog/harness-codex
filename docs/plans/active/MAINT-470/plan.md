# 구현 계획

## 1. 구현 목표
- ChangeSet: CHG-470
- Work item: MAINT-470
- 목표: normal implementation executor가 harness control-plane 파일을 수정하지 못하게 하고, source/test/config 변경을 active plan implementationBoundary로 제한한다.

## 2. 구현하지 말아야 할 것
- readFrontier/diffContract evidence 모델 재도입 금지.
- 새 per-step handoff artifact 추가 금지.
- normal executor가 harness agent/skill/workflow/runtime policy를 직접 수정하도록 허용 금지.

## 실행 경계
- 대상 bounded context/module: harness runtime scope validation
- 대상 aggregate root: N/A - runtime policy module

```yaml
implementationBoundary:
  source:
    - harness_codex/runtime/artifact_boundary.py
    - harness_codex/runtime/validate_scope_diff.py
  tests:
    - tests/test_executor_write_policy.py
    - tests/test_scope_support_files.py
  runtimeArtifacts:
    - docs/plans/active/MAINT-470/plan.md
    - .harness/runs/**
    - .harness/state/**
  configExceptions: []
  protected:
    - .harness/system/**
    - .harness/agents/**
    - .harness/contracts/**
    - .harness/docs/**
    - .harness/workflows/**
    - .codex/**
    - harness_codex/**
```

### 수정 허용 경로
- `harness_codex/runtime/artifact_boundary.py`
- `harness_codex/runtime/validate_scope_diff.py`
- `tests/test_executor_write_policy.py`
- `tests/test_scope_support_files.py`
- `.codex/skills/harness-code-planner/references/detailed-instructions.md` - 이번 harness evolve 성격의 issue 구현에서 planner instruction 갱신
- `.codex/skills/harness-code-planner/references/plan-template.md` - 이번 harness evolve 성격의 issue 구현에서 template 갱신
- `.codex/skills/harness-implementation-executor/SKILL.md` - 이번 harness evolve 성격의 issue 구현에서 executor instruction 갱신
### 수정 금지 경로
- 위 목적 외 harness agent/skill/workflow/runtime policy 전면 재작성 금지
- readFrontier/diffContract 관련 새 runtime evidence 파일 추가 금지
### 영향받는 기존 파일
- `harness_codex/runtime/artifact_boundary.py`
- `harness_codex/runtime/validate_scope_diff.py`
- `.codex/skills/harness-code-planner/references/detailed-instructions.md`
- `.codex/skills/harness-code-planner/references/plan-template.md`
- `.codex/skills/harness-implementation-executor/SKILL.md`

## 패키지 및 의존성 계약
### 생성/수정 클래스와 정확한 package
- `harness_codex.runtime.validate_scope_diff`: `ImplementationBoundary`, `ScopePolicy`, `validate_scope_diff` 정책 변경
- `harness_codex.runtime.artifact_boundary`: harness control-plane path 분류 강화
### 각 클래스의 layer와 책임
- runtime policy layer: executor write boundary 검증
### 허용 의존성 방향
- 기존 runtime 내부 의존만 사용
### 금지 import/framework dependency
- 새 외부 dependency 추가 금지
### bootstrap/configuration wiring
- 기존 `BasicStepRunner`의 scope-diff 호출 경로 유지

## 도메인 구현 계약
### Aggregate invariant
- N/A - runtime policy maintenance
### 상태 전이
- executor write result: allowed / suspicious / blocked
### Entity/Value Object 생성 및 검증 규칙
- path category와 plan implementationBoundary를 기준으로 검증
### Domain Service 여부와 책임
- N/A
### Domain Event 및 persistence compatibility
- N/A
### 다른 Aggregate/Bounded Context 협력 방식
- N/A
### Transaction, idempotency, concurrency
- N/A

## 외부 계약 읽기 허용 목록
- N/A - runtime scope validator와 agent instruction만 갱신

## 작업 체크리스트
- [x] TASK-001 `harness_codex/runtime/artifact_boundary.py`: `.harness/system`, `.harness/agents`, `.harness/contracts`, `.harness/docs`, `.harness/workflows`를 protected control-plane으로 분류.
- [x] TASK-002 `harness_codex/runtime/validate_scope_diff.py`: plan `implementationBoundary` 기반 source/test/config/runtime/protected 판정 추가.
- [x] TASK-003 `.codex/skills/harness-code-planner/references/plan-template.md`: planner output에 `implementationBoundary` block 요구.
- [x] TASK-004 `.codex/skills/harness-code-planner/references/detailed-instructions.md`: config/build/script explicit exception 정책 문서화.
- [x] TASK-005 `.codex/skills/harness-implementation-executor/SKILL.md`: executor가 boundary 밖 수정을 멈추고 scope expansion request를 남기도록 지시.
- [x] TEST-001 `tests/test_executor_write_policy.py`: source/test boundary, config exception, protected control-plane/runtime artifact 동작 검증.

## 집중 검증
- [x] VERIFY-001 Syntax: `python3 -m py_compile harness_codex/runtime/artifact_boundary.py harness_codex/runtime/validate_scope_diff.py tests/test_executor_write_policy.py` -> local reconstructed files 기준 PASS.
- [ ] VERIFY-002 Focused tests: `pytest tests/test_executor_write_policy.py tests/test_scope_support_files.py` -> GitHub runner에서 확인 필요.
- [ ] VERIFY-003 Architecture test: N/A - runtime policy focused change.
- [ ] VERIFY-004 E2E 또는 maintenance verification: PR CI / focused pytest.
- [ ] VERIFY-005 Test gate: `.codex/test-gate.yaml` required stage PASS.
- [ ] VERIFY-006 Runtime server verification: N/A - server runtime 변경 없음.
- [ ] VERIFY-007 Static analysis: N/A - focused runtime policy change.
### 중단 조건
- protected control-plane이 runtime artifact로 허용되는 regression 발생 시 block.
- source/test boundary 밖 파일이 allow되는 regression 발생 시 block.

## 9. OWASP Security Review
- pending `security_plan_reviewer`; attack surface: executor write permission and harness control-plane protection.

## 10. 완료 조건
- 모든 체크박스가 `- [x]`.
- 필요한 테스트가 존재하고 통과.
- Focused tests와 test gate 결과 기록.
- active -> completed 전이는 `complete-work-item-plan`만 수행.

## 11. 검증 결과
- Syntax: PASS - local reconstructed files 기준 py_compile 통과.
- Focused tests: pending CI/local checkout.
- Architecture test: N/A.
- E2E 또는 maintenance verification: pending.
- Test gate: pending.
- Runtime server verification: N/A.
- Static analysis: N/A.
