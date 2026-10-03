# Knowledge Harvest

## 목적

Engineering 질문에 답하기 위해 출처를 발견하고 평가한 뒤, 원문에 연결된 Source와 원자적 Claim을 프로젝트 로컬 registry에 기록한다.

## 절차

1. 질문과 관련된 자료를 탐색하고 원래 URI, 출처 주체, 제목을 확인한다. 접근하지 못한 자료는 수집한 것처럼 표현하지 않는다.
2. 다음 우선순위를 따라 Source를 분류한다: Formal Standards, Industry Framework, Primary Technical, Established Expert, Empirical, Community.
3. authority, independent authority, recency, relevance, commercial bias, primary-source 여부, preference, domain metadata를 각각 기록한다. 같은 `independent_authority_id`를 가진 문서는 독립 근거 수에서 한 번만 센다. Community 자료는 단독 Principle 근거가 될 수 없다.
4. 접근 가능한 원문을 수집하고 `collection_status`, `collected_at`, `content_sha256` 또는 명시적인 `unavailable_reason`을 기록한다.
5. 원문에서 한 가지 주장만 포함하는 Claim을 추출한다. 각 Claim은 `source_id`, 정확한 `locator`, `retrieved_at`, 적용 `context`, `qualifiers`를 기록한다.
6. 저장/조회는 `node .codex/scripts/harness-knowledge.mjs source|claim save|show ...`로 수행한다. JSON 객체는 `.codex/schemas/knowledge/` 및 validation helper의 계약을 따른다.

## 프로젝트 Evidence

- 수동 측정 결과는 `node .codex/scripts/harness-knowledge.mjs evidence import --root <project-root> --json '<JSON>'`로 프로젝트 로컬 후보에 가져온다. 입력에는 `origin_project`, `environment`, `timestamp`, `type`, `execution_status`, `measurement_validity`, `observations`, `source_reference`, `decision_ids`, `summary`가 필요하다.
- 가져온 후보와 승인 대기/거절 이력은 `docs/specs/.runtime/506-06-local-evidence/evidence/`에만 기록된다. 실행 raw payload, stdout, secret, plan journal/checkpoint는 후보·요약에 넣지 않는다.
- 사용자가 제시된 요약을 확인하면 `evidence approve --id <id> --actor <user-id> --actor-role user`를 실행한 뒤 `evidence publish --id <id>`로 `knowledge/evidence/`에 등록한다. 요약 변경은 기존 승인을 무효화한다.
- 거절은 `evidence reject --id <id> --actor <user-id> --reason <reason>`으로 기록한다. 수정 요약은 `evidence stage --id <id> --json '{"summary":"..."}'`로 제출해 재승인을 받는다.
- `failed` 또는 `interrupted` execution은 `valid` 측정으로 기록하지 않는다. Evidence 쓰기/게시 실패는 기존 execute/verify 판정을 변경하지 않는다.

## Principle 승인 및 게시

7. 독립 corroboration은 `independent_authority_id`로 묶어 평가한다. 같은 authority의 여러 Source/Claim은 한 authority다. `consensus`는 Reviewer의 명시 assessment이며 Source 수로 계산하지 않는다.
8. Countersearch마다 검색 query, 검색 시각, 결과, 검색 범위(scope), assessment를 보존한다. 결과가 없어도 범위를 기록한다. Countersearch 누락, 범위 누락, 해결되지 않은 material counter-evidence, 불충분한 독립 authority는 Principle을 candidate로 유지한다.
9. Synthesizer는 `MUST`/`SHOULD`/`MAY`, `applies_when`, exceptions, 지지/반대 Claim 참조가 있는 candidate만 만든다. Reviewer의 accepted review 후 candidate를 reviewed로 전이할 수 있다. Agent는 사람 승인을 대신할 수 없다.
10. Human approver만 명시적인 `{role: "user", id}` actor로 reviewed Principle을 승인한다. 승인 hash는 해당 Principle의 substantive body에만 묶인다. 본문 변경은 재승인을 요구한다. Deprecated 처리에는 이유와 history를 보존한다. `publish`는 approved/hash-valid Principle만 저장·조회 가능하게 한다.

## 역할 경계

- Researcher는 출처 발견, 분류, 수집, Claim 추출만 한다. Principle, 요약 결론 또는 설계 결정을 만들지 않는다.
- Source/Claim 수집과 저장은 사용자 material-use approval 전에 제시 목적으로 할 수 있다. 이 기록은 Reviewer의 자료 사용 승인이나 Principle 승인이 아니다.
- 후속 단계는 workflow 선언의 순서대로 수행하고 각 gate의 근거를 저장한다. countersearch 및 human approval 없이 Principle을 publish하지 않는다.
- 원문이 없거나 위치를 확인할 수 없으면 Claim을 추측하지 않고 진단 또는 unavailable 상태를 보존한다.
