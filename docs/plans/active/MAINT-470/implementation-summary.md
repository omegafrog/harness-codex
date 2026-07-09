# MAINT-470 Implementation Summary

## 변경 요약

- `artifact_boundary.py`에 `.harness/system`, `.harness/agents`, `.harness/contracts`, `.harness/docs`, `.harness/workflows` control-plane 보호 경로를 추가했다.
- `validate_scope_diff.py`를 category-aware policy로 변경했다.
  - runtime artifact는 별도 허용한다.
  - protected control-plane은 non-evolve에서 block한다.
  - source는 `implementationBoundary.source` 안에서만 허용한다.
  - test는 `implementationBoundary.tests` 안에서만 허용한다.
  - build/config/script는 `implementationBoundary.configExceptions`가 있을 때만 허용한다.
  - `implementationBoundary`가 없는 legacy plan은 기존 ChangeSet/plan/manifest fallback을 유지한다.
- planner template과 detailed instruction에 `implementationBoundary`를 추가했다.
- implementation executor instruction에 boundary 밖 수정을 직접 하지 말고 `scopeExpansionRequest`를 남기도록 추가했다.
- focused policy tests를 추가했다.

## 검증

- Local reconstructed file syntax check: PASS
- Full focused pytest: not run in connector-only environment
