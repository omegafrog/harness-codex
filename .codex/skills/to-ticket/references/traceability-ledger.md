# 추적 원장 작성 예시

계획 집합마다 `docs/plans/<plan-set-id>/traceability.json`을 만든다. `<plan-set-id>`는 원장 위치와 일치해야 하며 `ticket_id`는 `docs/specs/<ticket_id>/` 아래 Spec의 소유 ticket이다.

```json
{
  "schema_version": 2,
  "plan_set_id": "change-123",
  "ticket_id": "123",
  "spec_paths": [
    "docs/specs/123/product-spec.md",
    "docs/specs/123/architecture-spec.md"
  ],
  "requirements": [
    {
      "id": "BR-38",
      "source_path": "docs/specs/123/product-spec.md",
      "source_anchor": "BR-38",
      "statement": "실행 규칙을 누락하지 않는다.",
      "owner": "plan-123a",
      "plan_ids": ["plan-123a"],
      "disposition": "covered",
      "coverage": [
        {
          "plan_id": "plan-123a",
          "acceptance_criteria": ["모든 선언 규칙이 계획에 연결된다."],
          "verification_cases": ["누락 규칙을 검출하는 focused test"]
        }
      ]
    }
  ],
  "handoffs": [],
  "plans": [
    {
      "id": "plan-123a",
      "content_path": "docs/plans/change-123/plan-123a.md",
      "requirement_ids": ["docs/specs/123/product-spec.md#BR-38"],
      "acceptance_criteria": ["모든 선언 규칙이 계획에 연결된다."],
      "counterexamples": ["수용 조건을 만족해도 원 규칙을 어기는 구현"],
      "verification_cases": ["누락 규칙을 검출하는 focused test"],
      "verification_files": ["tests/feature.test.mjs"],
      "verification_profile": "unit"
    }
  ],
  "review": {
    "reviewer_id": "fresh-reviewer-context-id",
    "author_ids": ["writer-context-id"],
    "fork_turns": "none",
    "verdict": "pass",
    "findings": [],
    "inputs": {}
  },
  "implementation": {}
}
```

- 실제 Product/Architecture 선언을 모두 inventory에 기록한다. `requirement_ids`는 반드시 `source_path#id` 형식이며 원장과 양방향으로 일치해야 한다. `disposition`은 `covered` 또는 사유가 있는 `excluded`다.
- 계획은 원문인 local `content_path` 또는 `{ "canonical": { "kind": "github", "repository": "owner/repo", "issue": 456 } }` 중 하나를 가리킨다. `plans.md`는 ID index일 뿐 canonical 본문이 아니다.
- 다중 계획 규칙에는 `integration_owner_plan_id`와 `integration_verification`을 요구사항 항목에 추가한다.
- schema_version 2의 각 covered 요구사항은 모든 `plan_ids`별 `coverage` 항목을 가진다. 항목의 수용 기준과 검증 사례는 해당 plan의 목록과 정확히 일치해야 한다. 제외 요구사항은 빈 `coverage`와 구체적 제외 이유를 가진다.
- 각 plan은 업무 규칙을 검증할 단위 테스트 경로를 `verification_files`에 명시한다. 업무 로직 테스트를 추가하지 않는 계획은 빈 배열을 쓴다. 경로는 정본 계획 본문에도 적고 선택한 `verification_profile.config_inputs`에 포함한다. 이 프로필 설정은 planning snapshot에 포함되므로, 파일이나 실행 프로필 변경은 구현 dispatch 전에 새 독립 계획 리뷰를 요구한다. 프로필 명령이 명시된 테스트 파일을 실제로 실행하는지는 plan reviewer가 확인한다.
- `handoffs`에는 계획 간 생산자·소비자 plan, 생산 기준, 소비 기준, 소비 측 검증 사례를 기록한다. 각 문구는 해당 plan의 acceptance criteria 또는 verification cases에 실제로 있어야 한다.
- schema_version 2는 새 계획의 `planning` gate에서 필수다. 기존 schema_version 1은 이미 승인된 계획의 dispatch/completion 호환성을 위해 계속 읽지만 새 계획 검토에는 사용할 수 없다.
- `snapshot` 명령 결과의 `inputs` 전체를 fresh reviewer가 실제 원문과 함께 읽은 후 `review.inputs`에 저장한다. 직접 입력을 요약하거나 수동 hash를 만들어 넣지 않는다.
- 구현 완료 때 requirement마다 `implementation[plan-id].requirements`에 `requirement_id`, 구현 파일 `files`, 검증 파일 `verification`(각각 `path`, 실제 SHA-256), `receipt`(harness-exec 결과의 session-relative path)를 기록한다. profile은 plan의 `verification_profile`과 receipt에서 같아야 한다.

검사는 `node .codex/scripts/harness-plan-traceability.mjs snapshot|check|impact --root <workspace_root> --plan-set <plan-set-id>`로 수행한다. `check`의 정확한 phase/plan 인자와 실행 profile은 `docs/agents/EXEC.md`를 따른다. 기계 검사는 연결과 현재성만 확인하며 규칙 분해의 의미적 정확성을 대신하지 않는다.

`plan_set_id`는 `docs/plans/<plan-set-id>/`의 소유자이고 `ticket_id`는 원본 Spec 디렉터리의 소유자이므로 서로 다른 값일 수 있다. 각 계획의 `verification_profile.config_inputs`에는 구현 파일과 검증 파일을 모두 넣어야 한다. 완료 evidence는 해당 파일 hash를 기록하고 같은 profile의 `harness-exec` 실행 receipt를 session directory의 `runtime/execution/<profile>-<run-id>/receipt.json`에서 참조한다. Receipt와 로그는 session 출력의 수명 주기를 따르므로 완료 검사가 수행되는 workspace에서 그 session이 접근 가능해야 한다. session/worktree가 정리되어 receipt가 사라졌다면 검증을 다시 실행해 새 evidence를 기록한다.

검사는 선언된 Spec·Context·통합 계약·다이어그램도 계획 리뷰 입력으로 해시한다. 계획 생성 중 통합 계약은 수정하지 않는다. 최종 구현 통합 시 계약을 갱신하면 영향 분석 후 최신 전체 입력으로 fresh independent plan review를 다시 수행한다.
