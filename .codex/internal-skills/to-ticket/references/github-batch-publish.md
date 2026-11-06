# GitHub batch publish

이 절차는 canonical plan 전체가 작성되고 fresh plan reviewer와 plan-review/spec-review gate가 통과한 뒤 별도 `tracker-publish` workflow stage에서 실행한다. 그 전에는 GitHub Issue/Project 조회·수정 API를 호출하지 않는다. repository, Project 설정은 `.codex/harness.yaml`에서 읽는다. 이 단계는 저장소 Issue를 만들지 않고 Project draft item만 만든다. 저장소 Issue 변환은 구현을 처음 시작할 때 수행한다.

## 발행

1. [GitHub Issue 본문 템플릿](github-issue-template.md)을 작성 틀로 사용한다. 필요한 비테스트 검증을 템플릿의 해당 위치에 옮겨 적는다. 완성된 본문을 다시 대조하는 단계를 두지 않는다. static publication CLI가 제공한 본문으로 Project draft item만 만든다. `harness-publication.mjs publish`가 전체 Project 조회·중복 차단·발행·Planned 검증을 소유한다.
2. Project metadata는 `gh project view`와 `gh project field-list`를 각각 한 번만 호출해 project ID, 설정된 `Workflow Status` field ID, `Planned` option ID를 확인한다. 각 draft마다 metadata를 다시 조회하지 않는다.
3. `addProjectV2DraftIssue`를 한 GraphQL mutation의 alias로 묶어 전체 plan set의 parent/child 초안을 만든다. API 응답의 Project item ID와 plan ID mapping을 즉시 journal에 기록한다. Repository Issue 생성·parent 연결·Beads mirror는 이 단계에서 하지 않는다.
4. 정적 publish CLI가 실제 Project의 Planned 상태를 검증한다. 실패·응답 불명확 시 자동 재시도하지 않고 사용자에게 반환한다.
5. Project item 목록을 한 번 조회해 각 plan ID에 해당하는 draft와 `Planned` 상태가 있는지 확인한다. draft에는 Issue 번호·URL·sub-issue 관계가 아직 없으므로 이 값들을 만들거나 추측하지 않는다.

각 child draft에는 상위 plan ID와 선행 plan ID를 명시한다. canonical plan의 테스트 계약과 필요한 비테스트 검증을 템플릿의 해당 위치에 옮겨 적는다. 명세가 원격에 게시되어 접근 가능한 경우에만 GitHub 링크를 만들고, 그렇지 않으면 로컬 경로와 미게시 상태를 표시한다. 확인하지 않은 URL을 만들지 않는다.

GitHub Issue 생성과 parent 관계에는 공식 [REST Issues API](https://docs.github.com/en/rest/issues/issues) 및 [REST Sub-issues API](https://docs.github.com/en/rest/issues/sub-issues)를 사용한다. Project 등록과 status는 공식 GraphQL [`addProjectV2ItemById`](https://docs.github.com/en/graphql/reference/projects#addprojectv2itembyid), [`updateProjectV2ItemFieldValue`](https://docs.github.com/en/graphql/reference/projects#updateprojectv2itemfieldvalue) mutation을 alias 묶음으로 보낸다.

## 부분 실패와 재개

발행 상태와 plan mapping은 configured Project에서 `harness-publication.mjs inspect`로 조회한다. 별도 발행 상태 파일을 읽거나 쓰지 않는다. Issue 변환 뒤 Beads mirror를 만들며 canonical 계획 snapshot은 보존한다.

한 query alias 묶음에는 최대 10개 item을 넣는다. 구현 진입 시 초안 변환이 완료되기 전까지 `tracker_sync.ticket_refs`는 빈 배열이다. 구현 진입 절차가 초안을 실제 Issue로 변환한 뒤 Issue별 tracker lifecycle을 시작한다.

## Beads 연결과 계획 index

발행 상태와 plan mapping은 configured Project에서 `harness-publication.mjs inspect`로 조회한다. 별도 발행 상태 파일을 읽거나 쓰지 않는다. Issue 변환 뒤 Beads mirror를 만들며 canonical 계획 snapshot은 보존한다.
