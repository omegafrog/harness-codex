# ADR-010: Bounded Review-Repair Loop

## 상태

Accepted

## 결정

구현 후 `standards`와 `spec` reviewer가 남긴 structured finding 중 `implementation_defect`, `test_defect`, 그리고 plan 범위 안의 `in_scope_spec_mismatch`만 자동 repair 대상으로 허용한다. `requirement_ambiguity`, `architecture_decision`, `scope_expansion`, `spec_conflict`는 즉시 blocker로 남긴다.

자동 repair 대상은 승인 문서 원문을 인용한 `basis`가 있어야 하고 runtime이 인용을 대조한다. 근거가 없거나 인용이 틀린 지적은 `unbacked_requirement`, diff에 승인 없이 들어간 동작과 구현자가 신고한 `unplanned_additions`는 `unrequested_behavior`로 분류해 사용자에게 묻는다. 기본 권장은 거부다. `unrequested_behavior`의 거부는 Spec 변경 없는 제거 수정이며 사용자의 축소 결정이 막히지 않도록 repair 예산과 별도로 기록한다. `unbacked_requirement`의 거부는 지적 기각이다. 유지·반영은 `scope_expansion`으로 바뀌어 `spec-me`로 간다. 답변 기록이 없는 결정은 거부한다. `rule_impact: none`인 동작은 Spec 변경 없이 유지(`accept`)할 수 있고 결정은 리뷰 기록에 남는다. 같은 항목의 지적은 reviewer 원본을 고치지 않고 caller가 `scope_groups`로 묶어 한 번만 묻는다.

기본 repair round는 1회다. repair agent는 동일 plan에 대해 새롭고 비어 있는 context에서 실행하고, repair 후 두 reviewer를 모두 새 context에서 다시 실행한다. 새 commit과 두 reviewer의 provenance가 확인되지 않으면 완료로 판정하지 않는다.

## 책임 경계

- `src/wrapper/repair.mjs`는 finding 분류와 bounded decision만 수행한다.
- repair 실행과 reviewer 실행은 injected adapter가 담당한다.
- repair loop는 Codex agent loop, workflow routing, retry policy를 재구현하지 않는다.
- ambiguity나 architecture 판단이 필요한 finding은 agent/사용자 결정으로 넘긴다.

## 근거

품질을 회복할 수 있는 명백한 구현 결함은 한 번 자동으로 고칠 수 있다. 반면 요구사항·설계·범위 판단을 자동 수정하면 agent가 승인된 plan의 경계를 넘어갈 수 있으므로 deterministic blocker로 보존한다.
