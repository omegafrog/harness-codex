# GitHub batch publish

이 절차는 canonical plan 전체가 작성되고 fresh plan reviewer와 plan-review/spec-review gate가 통과한 뒤 한 번만 시작한다. 그 전에는 GitHub Issue/Project 조회·수정 API를 호출하지 않는다. repository, Project, assignee 설정은 `.codex/harness.yaml`에서 읽는다.

## 발행

1. 모든 parent/child 최종 body를 로컬에서 렌더하고 template heading, placeholder, SVG, status, dependency를 검사한다. Issue body 초안과 API 응답은 `<session_directory>/runtime/to-ticket/` 아래에 보존한다. 첫 GitHub mutation 전에 plan ID별 빈 진행 상태를 `publish-state.json`에 만든다.
2. Project metadata는 `gh project view`와 `gh project field-list`를 각각 한 번만 호출해 project ID, 설정된 `Workflow Status` field ID, `Planned` option ID를 확인한다. 각 Issue마다 metadata를 다시 조회하지 않는다.
3. parent를 `POST repos/<OWNER>/<REPO>/issues`로 만들고 응답의 `id`, `node_id`, `number`, `html_url`을 저장한다. 그 `id`를 `parent_issue_id`로 넣어 dependency 위상 순서대로 child를 만든다. 생성 응답에서 모든 ID와 URL을 얻으므로 `gh issue view`로 다시 조회하지 않는다. 의존 Issue 링크는 이미 생성된 선행 child의 응답에서 채운다.
4. child 생성 후 실제 번호를 넣어 parent body를 완성하고, parent Issue에 REST `PATCH repos/<OWNER>/<REPO>/issues/<PARENT-NUMBER>`를 한 번 수행한다. 모든 parent/child API 응답과 완료 단계를 `publish-state.json`에 즉시 기록한다.
5. Project V2에 Issue를 등록하는 `addProjectV2ItemById`를 한 GraphQL mutation에 alias로 묶는다. 반환된 Project item IDs를 저장한다. 이어서 각 `updateProjectV2ItemFieldValue`를 한 GraphQL mutation의 alias들로 묶어 모든 item의 설정된 `Workflow Status`를 `Planned`로 바꾼다. Issue별 `gh project item-add`/`item-edit`를 반복 호출하지 않는다. API errors나 누락 alias가 하나라도 있으면 다음 단계로 넘어가지 않는다.
6. 부모의 sub-issues 목록을 REST로 한 번 조회해 예상 child 전체가 연결되었는지 확인한다. 완료 lifecycle의 `tracker_sync` gate가 전체 Project 상태를 확인하고 Beads가 활성화된 경우 mirror도 확인한다. 이 gate는 Issue 상태를 최대 20개씩 한 GraphQL query로 조회하므로 일반적인 plan set에서는 Issue별 query 대신 한 번의 상태 조회가 된다.

GitHub Issue 생성과 parent 관계에는 공식 [REST Issues API](https://docs.github.com/en/rest/issues/issues) 및 [REST Sub-issues API](https://docs.github.com/en/rest/issues/sub-issues)를 사용한다. Project 등록과 status는 공식 GraphQL [`addProjectV2ItemById`](https://docs.github.com/en/graphql/reference/projects#addprojectv2itembyid), [`updateProjectV2ItemFieldValue`](https://docs.github.com/en/graphql/reference/projects#updateprojectv2itemfieldvalue) mutation을 alias 묶음으로 보낸다.

## 부분 실패와 재개

GitHub 호출은 하나의 원자적 transaction이 아니다. 각 성공 응답 직후 `publish-state.json`을 갱신한다. 재개할 때 이미 저장된 Issue number/ID를 재사용하며 `POST create`를 반복하지 않는다. 부모/child 생성, parent body 갱신, 관계 확인, Project add, Planned 변경, Beads ref 연결 단계별 완료 항목을 추적한다. 부분 batch 결과에 GraphQL `errors`가 있거나 응답 alias가 빠지면 성공한 항목을 기록한 뒤 실패한 항목만 재시도한다. Project mutation이 성공했는지 로컬 기록 전에 중단되어 결과가 불명확하면, 재시도 전에 모든 Issue를 한 번에 조회해 Project membership/status를 조정하고 빠진 항목만 적용한다. Issue 생성 응답이 사라져 생성 여부가 불명확하면 다시 만들지 말고 수동 복구 대상으로 멈춘다.

한 query alias 묶음에는 최대 10개 Issue를 넣는다. `tracker_sync`는 configured Project item과 `Workflow Status` 값을 모두 확인하며 pagination이 남거나 항목/상태가 모호하면 통과하지 않는다. `to-ticket`에서는 개별 Issue 조회·상태 쓰기·`harness-tracker sync --ticket`을 사용하지 않는다.

## Beads 연결과 계획 index

Beads가 활성화된 경우 모든 Issue 및 Project 상태 확인을 마친 뒤 각 Bead에 정확한 `external_ref`와 v1 metadata를 연결한다. parent/child Issue ID·number·URL은 `<session_directory>/runtime/to-ticket/publish-state.json`과 completion state의 tracker refs에 보존한다. `plans.md`와 canonical per-plan 문서는 review 통과 시점의 snapshot을 유지한다. 최종 완료 gate가 전체 tracker와 활성화된 mirror의 상태를 다시 읽어 발행 결과를 검증한다.
