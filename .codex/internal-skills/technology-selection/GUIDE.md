<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# 기술 선택

중요한 기술 선택이 미완료이거나 기존 결정이 확정된 요구·제약을 충족하지 못할 때만 이 절차를 수행한다. 유효한 기존 결정은 재사용한다. Product 요구, System Targets, 기존 ADR·제약·승인된 프로젝트 지식과 명시적 사용자 답변·위임을 먼저 확인한다.

1. 요구 ID별 필수·선호 기준과 우선순위를 확정한다. 기준은 요구에서 도출한다(예: 읽기 부하가 큰 요구 → 캐시 필요 → "원자적 증감 연산", "OSI 승인 오픈소스 라이선스"). 기능, 구축 시간, 운영 책임, 비용, 데이터 제어, 성능과 변경 가능성 중 적용되는 것만 선택한다. 수치는 목표·단위·조건·출처를, 정성 기준은 판정 조건을 기록한다. 미확정 값을 만들지 않는다.
2. 같은 역할을 하는 후보(또는 후보 조합)를 2개 이상 구성한다. 기존 구성이 유효하면 후보로 포함한다. 실제 대안이 없으면 단일 후보와 그 이유를 근거와 함께 기록한다.
3. 후보×기준마다 근거를 [공신력 있는 출처](references/authoritative-sources.md)의 등급 순서로 수집한다. 먼저 `knowledge/claims/`·`knowledge/sources/`에 저장된 Claim을 찾아 `node .codex/scripts/harness-knowledge.mjs claim show --id <id>`로 확인하고, 수집일과 버전 조건이 맞으면 재사용한다. 없으면 [knowledge-harvest](../knowledge-harvest/GUIDE.md) 1~6번으로 Source와 Claim(원문 구절·절·버전·확인일)을 저장한다. 실측, 외부 측정, 문서 사실, 추정, 미확인을 구분하고 확인하지 못한 판정은 `unknown`으로 둔다. community 출처만으로 판정하지 않는다.
4. 후보마다 기준별 충족·미충족·미확인, 그 근거 Claim, 직접 운영할 작업, 추가 구현 범위, 감수할 단점을 정리한다. 사용자에게는 `decision_kind: "technology"` 질문으로 후보를 선택지로 제시하고, 각 선택지의 `evidence`에 기준·판정·`claim_id`·출처 제목·URL·확인일을 넣는다. 추천과 그 이유를 함께 준다. 비교 없이 "판단을 맡길지"만 묻지 않는다. 사용자가 이미 같은 조건의 선택을 위임했거나 승인된 프로젝트 결정이 있으면 그 근거를 남기고 다시 묻지 않는다. 독립 질문은 한 묶음으로 `spec-me`에 반환한다.
5. Architecture Decision에 기준·평가·선택·수용한 단점·불확실성·재검토 조건을 기록한다. `documented` 평가는 인용한 Claim을 `claim_ids`로 남긴다. Architecture Spec 13절에는 결정별 후보·기준·판정·출처 비교표와 사용자 선택을 쓴다. 형식은 `.codex/schemas/decision/architecture-decision.schema.yaml`과 runtime validator를 따른다. `review_mode`는 기본 `Normal`이며 사용자가 Learning을 요청하면 `Learning`과 해당 `review_id`를 기록한다. 사용자 선택 또는 위임은 자료 열람 동의와 구분한다.

Source와 Claim은 프로젝트 `knowledge/` registry에 저장하고 Spec 문서와 함께 commit된다. 저장 자체에는 별도 승인이 필요 없다. 원문 전체는 저장하지 않고 인용 구절·URL·`content_sha256`만 남긴다. 기존 승인된 Principle/Evidence는 재사용할 수 있으며, 여러 프로젝트가 쓰는 Principle로 게시할 때만 `knowledge-harvest`의 검토·승인·게시 절차를 따른다. 이 GUIDE는 Product/Architecture Spec 작성, 독립 Spec 리뷰와 티켓 발행을 소유하지 않는다.
