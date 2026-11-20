---
model_tier: low_performance
---

# Knowledge Harvest

필요한 조사·추출·검토는 fresh 서브에이전트에 위임한다. 각 서브에이전트의 model·effort는 `node .harness/scripts/harness-skill-execution.mjs binding --root <workspace_root> --skill <skill>`이 반환한 값만 쓴다.

## 목적

비즈니스 요구사항과 기술 선택에 필요한 사실의 출처를 찾고 평가한다. 원문에 연결된 Source와 원자적 Claim을 프로젝트 로컬 registry에 기록한다.

## 절차

1. 요청받은 결정과 비교 기준을 확인한다. 범위·업무 결과·권한·성능 등 선택지 평가에 영향을 줄 사실을 먼저 특정하고, 기존 Source/Claim이나 승인된 프로젝트 Evidence의 조건이 맞으면 재사용한다. 부족한 사실은 아래 수집 기준으로 탐색하고 원래 URI, 출처 주체, 제목을 확인한다.
2. 다음 우선순위를 따라 Source를 분류한다: Formal Standards, Industry Framework, Primary Technical, Established Expert, Empirical, Community.
3. authority, independent authority, recency, relevance, commercial bias, primary-source 여부, preference, domain metadata를 각각 기록한다. 같은 `independent_authority_id`를 가진 문서는 독립 근거 수에서 한 번만 센다. Community 자료는 단독 Principle 근거가 될 수 없다.
4. 접근 가능한 원문을 수집하고 `collection_status`, `collected_at`, `content_sha256` 또는 명시적인 `unavailable_reason`을 기록한다.
5. 원문에서 한 가지 주장만 포함하는 Claim을 추출한다. `locator.excerpt`에는 원문에서 그대로 복사한 최소 충분 구절을 넣고, 추출 직전 그 구절이 수집한 원문에 실제로 존재하는지 직접 대조한다. 요약/번역을 원문 인용처럼 기록하지 않는다. 직접 대조할 원문이 없으면 Claim을 권위 있는 근거로 저장하지 말고 source를 unavailable로 남긴다. 각 Claim은 `source_id`, 정확한 `locator`, `retrieved_at`, 적용 `context`, `qualifiers`를 기록한다.
6. 저장/조회는 `node .harness/scripts/harness-knowledge.mjs source|claim save|show ...`로 수행한다. 이 명령은 [지식 검증기](../../../src/knowledge/validation.mjs)의 규칙에 따라 JSON 객체를 검증한다.

### 결정 근거 수집 기준

해당 결정에 필요한 유형을 골라 조사한다. 같은 사실에 대해 결론을 바꿀 만한 반례가 있거나 비교 자료가 충돌하면 함께 수집하고, 조건 차이로 설명되는지 확인한다.

| 근거 유형 | 우선 찾을 자료 | 원문에서 확인할 조건 |
|---|---|---|
| 유사 서비스의 정책과 동작 | 상용·공개 서비스의 공식 도움말, 공개 정책, 관찰 가능한 제품 동작 | 제품·플랜·역할·지역·시점과 공개적으로 확인 가능한 범위. 확인한 사례는 비교 선택지의 근거로 제공한다. |
| 사용자 행동과 수요 | 집계된 제품 지표와 지원 문의, 조사 방법이 공개된 사용자 연구와 도메인 통계 | 표본과 분모, 조사 기간, 대상 집단과 이번 서비스 사용자의 유사성 |
| 법·계약·보안 표준과 외부 제약 | 관할 기관의 원문, 승인된 계약 및 정책, 적용되는 보안 표준과 공인 지침, 연동 시스템의 공식 제한 | 관할·규격 버전과 조항·적용 대상·효력 시점, 보호 데이터와 위협 조건, 의무 또는 권고 여부 |
| 성능·용량·비용의 수치 | 측정 조건이 공개된 벤치마크, 운영 지표, 공개 가격 자료, 프로젝트 실측 | 지표·단위·백분위수, 부하와 데이터 크기, 환경·버전·측정일. 다른 조건에서 측정한 값은 비교 가능 범위를 기록한다. |
| 기술의 설계 의도와 지원 범위 | 공식 개발 문서, 표준·RFC, 유지보수자가 승인한 설계 기록, 호환성·지원 정책 | 해당 버전과 기능 범위. 공식 보장, 개발자가 밝힌 설계 의도, 출처를 바탕으로 한 추론을 구분한다. |
| 운영과 전환 비용 | 장애 보고서, 보안 공지, 마이그레이션 가이드, 프로젝트에서 재현한 결과 | 장애·제약이 나타나는 조건, 영향 버전, 필요한 복구·전환 작업 |

원문으로 확인한 사실은 Claim으로 저장하고 적용 조건과 비교 한계는 기존 `context`와 `qualifiers`에 담는다. 외부 벤치마크의 수치도 Claim으로 기록한다. 프로젝트 실측은 아래 Evidence 절차를 적용한다. 비공개 계약이나 내부 지표는 호출자가 허용한 기존 프로젝트 자료 경로로 참조한다.

수집 결과를 호출자에게 돌려줄 때는 선택지나 판정 기준마다 실제로 확인한 사실, Claim ID 또는 승인된 Evidence ID, 출처 제목·URI·확인일, 적용 조건과 한계를 짧게 정리한다. 그러면 호출자는 사용자에게 질문할 때나 위임받은 결정을 설명할 때 해당 근거를 함께 제시할 수 있다. 확인에 실패한 사실은 미확인으로 표시하고 어떤 판정을 유보해야 하는지 적는다. 사용자의 업무 정책 결정과 기술 선택은 호출 단계가 소유한다.

### 결정 소유 단계의 수집 요청과 근거 표시

- 업무 정책, 성능 목표, 보안 기준 또는 기술 선택을 새로 제안하거나 바꿀 때는 선택지와 비교 기준을 정하고 어느 판단에 외부 사실이나 측정이 필요한지 구분한다. 관련 사용자 결정·프로젝트 계약과 기존 저장 근거를 먼저 확인한다. 후보의 가능 여부, 기준 충족, 권장안에 영향을 주는 사실에 근거가 없으면 위 1~6단계를 호출한다. 직접 결정하는 경우와 사용자에게 선택을 묻는 경우에 같은 수집 기준을 적용한다.
- 각 후보마다 근거가 뒷받침하는 내용과 조건·한계, 해당 요구의 충족·미충족·미확인 여부를 적는다. 수치가 기준으로 제안되면 단위, 측정 조건, 프로젝트에 적용할 목표값을 정한 이유를 함께 설명한다. 보안 기준은 대상 자산·위협·판본과 해당 조항을 적는다. 사례에서 확인한 수치와 이 프로젝트의 목표값, 확인한 지원 범위와 추천은 구분한다. 사용자 선호나 위임 범위가 최종 선택을 가르면 그 이유도 적는다.
- 질문을 반환할 때는 각 선택지의 기존 `consequence`에 실제 효과와 핵심 사실, Claim/Evidence ID, 출처 링크와 적용 한계를 담는다. 기술 질문의 기존 `evidence`에도 기준별 Claim을 기록한다. `rationale`에는 어떤 기준과 근거로 권장했는지 적는다. 순수한 선호 차이에는 사용자 요청·답변 또는 프로젝트 제약을 근거로 보여 준다. 확인하지 못한 필수 기준은 미확인으로 명시한다.
- 결정이 끝나면 소유 문서의 항목 또는 ADR에 선택지별 판정, 채택한 안, 다른 안을 택하지 않은 이유, 관련 Claim/Evidence ID와 재검토 조건을 남긴다. 사용자 선택과 위임받은 판단의 출처는 구분한다. `result.summary`에도 새로 채택한 중요한 결정, 선택을 가른 사실과 출처 링크, 적용 조건을 적어 사용자가 바로 확인할 수 있게 한다. 자료는 근거 ID로 연결하고 티켓은 기존 요구·설계 ID를 따라간다.

### 프로젝트에 저장하고 다시 찾기

- 외부 출처와 검증한 주장은 `knowledge/sources/<source-id>.yaml`, `knowledge/claims/<claim-id>.yaml`에 저장한다. Claim의 `source_id`로 Source에 연결된다. 승인된 프로젝트 실측은 `knowledge/evidence/<evidence-id>.yaml`에서 참조한다. 검색에 도움이 되도록 Claim의 `statement`와 `context`에 제품·표준·기능·지표 이름을 명시한다. 같은 근거를 다시 쓸 때는 ID를 재사용한다. 버전이나 조건이 달라 기존 결정을 뒷받침할 수 없게 되면 새 근거를 저장하고 해당 결정에서 인용을 갱신한다.
- 새로 저장하거나 변경한 Source/Claim은 결정 소유 단계가 질문 또는 완료를 제출할 때 workspace `artifacts`에 각각 `kind: knowledge_source` 또는 `kind: knowledge_claim`과 실제 파일 경로로 반환한다. 새 Claim이 가리키는 Source도 아직 커밋되지 않았다면 함께 반환한다. 질문에 사용된 근거 파일은 질문 대기 시점에 보관하고, 소유 문서는 결정이 끝난 뒤 기록한다. 이미 커밋된 근거는 ID로 재사용한다. 조사를 이어가야 하거나 다른 단계로 돌려보낼 때의 미완성 자료는 실행 세션에 둔다.
- 키워드와 ID는 `rg -ni '검색어|Claim-ID' knowledge/` 또는 `grep -Rin '검색어' knowledge/`로 찾는다. `node .harness/scripts/harness-knowledge.mjs claim show --id <claim-id>`로 원문 위치·적용 조건을 확인하고 `source show --id <source-id>`로 출처를 확인한다. `rg -n -F '<claim-id>' docs/specs docs/implementation docs/adr`로 해당 근거를 인용한 결정을 찾는다.

## 프로젝트 Evidence

- 수동 측정 결과는 `node .harness/scripts/harness-knowledge.mjs evidence import --root <project-root> --json '<JSON>'`로 프로젝트 로컬 후보에 가져온다. 입력에는 `origin_project`, `environment`, `timestamp`, `type`, `execution_status`, `measurement_validity`, `observations`, `source_reference`, `decision_ids`, `summary`가 필요하다.
- `decision_ids`에는 하나 이상의 안전한 decision ID를 넣고, summary/observation/context에는 한 줄의 정규화 문장만 넣는다. 비밀값, 실행 로그·stdout, plan journal/checkpoint를 포함하지 않는다.
- 가져온 후보와 승인 대기/거절 이력은 `<session_directory>/runtime/knowledge/evidence/`에만 기록된다. 실행 raw payload, stdout, secret, plan journal/checkpoint는 후보·요약에 넣지 않는다.
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
- Reviewer는 새로 발견한 Source/Claim에 의존하기 전에 그 내용·맥락·출처를 사용자에게 보여 주고 `recordMaterialApproval`/`writeMaterialApproval`로 별도 자료 사용 승인을 받는다. Principle 승인은 자료 사용 승인을 대신하지 않는다. 거절되거나 대기 중인 자료는 제외한다.
- Human approver 단계는 후보 전체, 독립 corroboration, countersearch 범위·결과, Reviewer 평가, 예외와 미해결 사항을 제시하고 명시적 승인 또는 보류를 받는다. 침묵을 동의로 보지 않고 사용자를 대신하거나 게시하지 않는다. 승인은 `principle approve --actor <user-id> --actor-role user`로 사람 actor와 시각을 보존해 기록한다.
