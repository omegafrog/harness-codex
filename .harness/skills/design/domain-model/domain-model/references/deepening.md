# 전술 설계 단계 공통 규칙

`domain-model`, `aggregate-design`, `domain-service`, `application-service`, `integration-design`, `context-boundary` 순으로 진행한다. 같은 `tactical-design.md`의 BC별 구성 요소를 소유 stage가 채우고 마지막 두 stage가 검토한다. 문서 구조는 [템플릿](template.md)을 따른다.

## 진입과 재개

- workspace preflight를 `node .harness/scripts/harness-workspace-preflight.mjs --workspace-root <workspace_root> --json`으로 실행하고 실패하면 해당 출력으로 차단한다. `node .harness/scripts/harness-spec-path.mjs <workspace_root> <file>`로 요구사항, 이해관계자 분석 및 전술 설계 경로를 찾는다.
- `stakeholder-analysis.md`가 `판정: 생략`이면 근거 경로와 함께 `completed / OK`를 반환한다. `requirements.md`가 없거나 `상태: fixed`가 아니면 `blocked / INPUT_MISSING`을 반환한다.
- 재개 시 이전 결과, 이미 작성된 설계와 실제 승인 답변을 읽고 빠진 작업부터 이어간다. `context.user_revision`은 지정된 요소만 수정한다. 형식 이동은 [구형 문서 절차](template.md#구형-문서)를 따른다. 예전 문서명 `domain-model.md`의 경로 이전은 실행기가 담당한다.
- 운영 중 사용자 요구의 범위를 추가하지 않는다. 모든 요소는 기존 `BIZ`, `INV`, `EX` 또는 `AC`에 추적돼야 한다. 범위 추가는 사용자가 요구사항 단계에서 결정한다.

<a id="no-new-scope"></a>
## 규칙 근거 확인

`requirements.md`의 해당 업무, 규칙, 예외, 완료 조건, 이벤트 흐름을 읽고 연결된 승인·수정 답변 원문(`answers.json`, `question_id`)을 대조한다. 규칙의 발동 조건, 불변식이나 예외, 성공·실패 결과 중 빠진 정보가 있으면 문서의 소유 stage로 반환한다. 같은 판단을 모델 표·책임 표·Application Service에 여러 번 정의하지 않는다. 책임 표에서 정의하고 나머지 요소는 메서드와 요구 ID로 연결한다.

이미 확정된 동작의 사실이 불충분하거나 충돌하면 가장 앞선 소유 stage와 부족한 사실 및 근거를 기록한다. 요구사항 자체에 조건·예외·결과가 빠졌으면 `requirements-fix`, 관계와 결정 소유자가 불명확하면 `bounded-context`에 반환한다. Aggregate 일관성이나 호출 실패 시 사용자에게 보이는 결과처럼 설계를 바꾸는 업무 판단은 확정 근거를 먼저 찾는다. `aggregate-design`과 `application-service`는 이미 승인된 범위 안에서 실제 설계 선택이 남았을 때만 업무 결과의 차이, 권장안과 이유를 한 묶음의 한국어 질문으로 `action_required / USER_DECISION_REQUIRED`를 반환할 수 있다. 답변이 고정 요구사항을 바꾸거나 규칙·예외를 추가하면 답변 근거와 함께 `requirements-fix`로 반환한다. 변경된 요구사항은 다시 확정하고 사용자 승인을 받은 뒤 전술 설계에 반영한다.

새 설계 대안을 평가할 때는 [결정 근거 수집과 표시](../../../../research/knowledge-harvest/GUIDE.md#결정-소유-단계의-수집-요청과-근거-표시)를 적용한다. 각 안을 관련 요구 ID와 대조한다. 성능·보안·호환성 등 외부 사실이 평가를 가르면 출처에서 직접 확인하고 결과와 한계를 해당 설계 항목이나 ADR에 기록한다. 더 깊은 설계 비교 중 발견한 업무 기준의 변경은 위 소유 단계로 반환한다.

## 프로젝트 문서

- 용어는 `CONTEXT.md`와 요구사항 용어 표에서 찾는다. 새 개념에는 [용어 생애주기](language-lifecycle.md)를 적용한다.
- 변경의 모델·Aggregate·규칙 강제 위치·통신은 해당 BC의 `tactical-design.md`에만 기록한다. 현행 구현을 인용할 때는 코드 경로·행·commit을 적고 승인된 설계와 구분한다. 구현 결과는 최종 통합 시 `sync-contracts`에서 현행 계약에 반영한다.
- 지속되는 결정은 적용된 요소에서 `docs/adr/`의 구체적인 Markdown 파일이나 문서 절을 링크한다. 이미 같은 결정을 담은 ADR이 있으면 그 위치를 사용한다. 새로 기록할 때 결정, 근거(요구·답변 ID), 결과와 영향을 받는 경계를 적고 문서의 다른 결정을 보존한다. 실제로 바꾼 ADR·프로젝트 문서·클래스 다이어그램 파일은 결과의 workspace artifact에 개별 경로를 싣는다.
- `domain_context_pack`이 있으면 먼저 후보를 확인한다. 상세는 `node .harness/scripts/harness-domain.mjs get <ID>...`로, 후보가 부족하면 `discover` 또는 `search`로 조회한다. 사용한 공통 정의 ID를 근거로 남긴다.

<a id="automatic-rewind-to-the-owner"></a>
## 소유 stage로 반환

`blocked / DEPENDENCY_INCOMPLETE`의 `result.owner_stage`에 가장 앞선 **이전** 소유 stage를, `result.dependency_gap`에 그 stage가 변경할 요소·누락·근거를 기록한다. 실행기는 `launch --stage-id <owner_stage> --reopen-for <blocked execution_id>`로 해당 stage를 다시 열고 뒤 stage를 순서대로 갱신한다. 수정과 무관한 확정 결정은 유지한다. 반환하는 stage는 소유 stage의 요소를 쓰지 않는다. 이전 문서명 이동은 반환 중에도 실행기가 보존한다.

<a id="relaunch-after-a-block"></a>
## 최종 검증과 차단 후 재개

실행기는 `context-boundary`의 `completed / OK`가 제출되면 `harness-domain-model-check.mjs`로 고정 요구와 설계 문서의 정합성을 확인한 뒤 완료를 기록한다. 실패한 결과에 `gate_error`와 각 finding의 `owner_stage`가 반환된다. 차단된 stage를 재개할 때는 이전 오류를 참고하되 현재 문서에서 `node .harness/scripts/harness-domain-model-check.mjs --workspace-root <absolute workspace root>`를 실행하여 여전히 발생하는 오류를 근거로 삼는다. 소유 stage에서 바로 고칠 수 있는 오류는 수정하고, 앞 단계가 담당하는 오류는 위 반환 규칙을 적용한다.
