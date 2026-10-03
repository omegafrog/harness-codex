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

## 역할 경계

- Researcher는 출처 발견, 분류, 수집, Claim 추출만 한다. Principle, 요약 결론 또는 설계 결정을 만들지 않는다.
- Source/Claim 수집과 저장은 사용자 material-use approval 전에 제시 목적으로 할 수 있다. 이 기록은 Reviewer의 자료 사용 승인이나 Principle 승인이 아니다.
- 후속 독립 corroboration, countersearch, synthesis, review, human approval, publish 단계는 이 harvest 절차에서 완료된 것으로 표시하지 않는다.
- 원문이 없거나 위치를 확인할 수 없으면 Claim을 추측하지 않고 진단 또는 unavailable 상태를 보존한다.
