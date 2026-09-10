# ADR-007: Config와 Permission 소유권

- 상태: Accepted
- 결정일: 2026-09-10

## Context

Harness workflow는 case·suite·journal·worktree·gate 정책을 선언해야 하지만 실제 sandbox와 permission enforcement를 복제하면 Codex와 권한 모델이 충돌한다. User global Codex config를 installer가 덮어쓰는 것도 허용하지 않는다.

## Decision

```text
.codex/harness.yaml
→ harness-level declarative config
.codex/agents/*.toml
→ role profile
Codex native config
→ filesystem/network/sandbox enforcement
harness runtime logic
→ workflow invariant, gate validation, evidence collection,
  policy result classification
```

`.codex/harness.yaml`은 eval defaults, suite/case paths, journal/worktree policy, gate thresholds와 native permission profile reference를 소유한다. Secret, credential, raw permission rule은 저장하지 않는다. `.codex/agents/*.toml`은 Codex native role schema가 허용하는 role definition, model defaults, instructions, sandbox와 permission profile reference만 소유한다. Harness context policy는 native role TOML에 임의 필드로 추가하지 않고 harness runtime config/defaults에서 해석한다.

새 permission engine과 별도 workspace trust 모델은 만들지 않는다. Installer는 harness-owned 파일만 설치·검증하고 user global Codex config를 수정하지 않는다.

Native permission rejection과 harness workflow violation은 별도 event로 기록한다.

```json
{"type":"native_permission_denied","action":"write","target":"..."}
{"type":"workflow_policy_violation","gate":"product_source_read_forbidden"}
```

## Consequences

- 실제 enforcement와 workflow 의미 판정의 책임이 분리된다.
- Permission profile reference가 stale이거나 없을 때 명확한 preflight 오류가 필요하다.
- Runtime은 native decision과 policy result를 함께 수집하되 동일 원인으로 합치지 않는다.
