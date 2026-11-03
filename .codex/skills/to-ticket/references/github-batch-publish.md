# GitHub batch publish

이 절차는 canonical plan 전체가 작성되고 fresh plan reviewer와 plan-review/spec-review gate가 통과한 뒤 별도 `tracker-publish` workflow stage에서 실행한다. 그 전에는 GitHub Issue/Project 조회·수정 API를 호출하지 않는다. repository, Project 설정은 `.codex/harness.yaml`에서 읽는다. 이 단계는 저장소 Issue를 만들지 않고 Project draft item만 만든다. 저장소 Issue 변환은 구현을 처음 시작할 때 수행한다.

## 발행

1. [GitHub Issue 본문 템플릿](github-issue-template.md)을 그대로 작성 틀로 사용해 Parent/Child draft body를 직접 채운다. 별도 자유 형식 초안을 만든 뒤 옮기거나 완성된 본문을 다시 대조하는 단계를 두지 않는다. 부모·의존 관계는 Issue 번호 대신 canonical plan ID로 표현한다. 각 placeholder를 채우는 동안 해당 템플릿의 필수 내용을 적용한다. `addProjectV2DraftIssue`로 설정된 Project에 초안을 만들고 제목, 본문, plan ID, Project item ID를 `<session_directory>/runtime/to-ticket/publish-state.json`에 기록한다. 첫 GitHub mutation 전에 plan ID별 빈 진행 상태를 만든다.
2. Project metadata는 `gh project view`와 `gh project field-list`를 각각 한 번만 호출해 project ID, 설정된 `Workflow Status` field ID, `Planned` option ID를 확인한다. 각 draft마다 metadata를 다시 조회하지 않는다.
3. `addProjectV2DraftIssue`를 한 GraphQL mutation의 alias로 묶어 전체 plan set의 parent/child 초안을 만든다. API 응답의 Project item ID와 plan ID mapping을 즉시 journal에 기록한다. Repository Issue 생성·parent 연결·Beads mirror는 이 단계에서 하지 않는다.
4. 반환된 item ID를 사용해 초안의 `Workflow Status`를 `Planned`로 설정하고, 모든 draft item과 상태를 publication journal에 보존한다. API 오류나 누락된 응답이 있으면 성공 항목을 기록하고 실패 항목만 재개한다.
5. Project item 목록을 한 번 조회해 각 plan ID에 해당하는 draft와 `Planned` 상태가 있는지 확인한다. draft에는 Issue 번호·URL·sub-issue 관계가 아직 없으므로 이 값들을 만들거나 추측하지 않는다.

각 child draft에는 상위 plan ID와 선행 plan ID를 명시한다. canonical plan의 테스트 계약과 필요한 비테스트 검증을 템플릿의 해당 위치에 옮겨 적는다. 명세가 원격에 게시되어 접근 가능한 경우에만 GitHub 링크를 만들고, 그렇지 않으면 로컬 경로와 미게시 상태를 표시한다. 확인하지 않은 URL을 만들지 않는다.

GitHub Issue 생성과 parent 관계에는 공식 [REST Issues API](https://docs.github.com/en/rest/issues/issues) 및 [REST Sub-issues API](https://docs.github.com/en/rest/issues/sub-issues)를 사용한다. Project 등록과 status는 공식 GraphQL [`addProjectV2ItemById`](https://docs.github.com/en/graphql/reference/projects#addprojectv2itembyid), [`updateProjectV2ItemFieldValue`](https://docs.github.com/en/graphql/reference/projects#updateprojectv2itemfieldvalue) mutation을 alias 묶음으로 보낸다.

## 부분 실패와 재개

GitHub 호출은 하나의 원자적 transaction이 아니다. 각 성공 응답 직후 `publish-state.json`을 갱신한다. 재개할 때 이미 저장된 Project item ID를 재사용하며 `addProjectV2DraftIssue`를 중복 호출하지 않는다. draft 생성과 Planned 설정을 plan ID별로 추적한다. 부분 batch 결과에 GraphQL `errors`가 있거나 응답 alias가 빠지면 성공 항목을 기록한 뒤 실패한 항목만 재시도한다. 생성 결과가 불명확하면 재생성하지 말고 Project items를 조회해 수동 복구 대상으로 멈춘다.

한 query alias 묶음에는 최대 10개 item을 넣는다. 구현 진입 시 초안 변환이 완료되기 전까지 `tracker_sync.ticket_refs`는 빈 배열이다. 구현 진입 절차가 초안을 실제 Issue로 변환한 뒤 Issue별 tracker lifecycle을 시작한다.

## Beads 연결과 계획 index

`tracker-publish`에서는 Beads에 tracker mirror를 만들지 않는다. 구현 진입 시 실제 Issue가 만들어진 뒤 Beads 항목에 Issue URL `external_ref`, v1 metadata, parent/dependency 관계를 부여한다. Project item ID와 plan mapping은 publication journal 및 completion receipt에 보존한다. `plans.md`와 canonical per-plan 문서는 review 통과 시점의 snapshot을 유지한다.
