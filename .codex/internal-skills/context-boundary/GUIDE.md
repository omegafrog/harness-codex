---
model_tier: high_performance
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# context-boundary

## 목적

`integration-design` 다음에 수행하는 마지막 전술 설계 stage다. 근거가 있는 컨텍스트 관계마다 모델 소유권 보호 패턴과 코드 의존 형태를 결정하고, `tactical-design.md`의 6절과 `CONTEXT-MAP.md` 관계 행에 기록한다. 배포 토폴로지를 전제하지 않으며 프레임워크, broker, protocol, 저장 기술을 선택하지 않는다. 사용자가 `context-boundary`를 지정하면 파일이 아니라 이 stage와 기록된 상태를 뜻한다.

## 입력

[전술 설계 template](../domain-model/references/template.md)의 6절 구조와 [공통 규칙](../domain-model/references/deepening.md)의 반환·gate 복구 절차를 따른다.

사용자 요청, 확정된 `requirements.md`, `CONTEXT-MAP.md`, `CONTEXT.md`, `tactical-design.md`의 1~5절, 존재한다면 `docs/architecture/domain-model.md`를 읽는다. 전술 설계 stage 규칙에 따라 workspace preflight를 실행하고 `harness-workspace-preflight.mjs`, `harness-spec-path.mjs`로 plan-set 문서를 찾는다.

## 금지 사항

- 범위 추가: `requirements.md`의 기존 `BIZ`/`INV`/`EX`/`AC`에 추적되지 않는 관계·경계 결정을 만들거나, 기능을 범위에 포함할지 사용자에게 묻지 않는다. [No new scope](../domain-model/references/deepening.md#no-new-scope)를 따른다.

`tactical-design.md`에서는 `## 6`과 이 stage가 추가하는 `## 7` 결정 이력 행만 수정한다. 아래의 구형 이력 이동 예외 외에는 다른 절을 쓰지 않는다.

소스·테스트 코드를 살펴보지 않는다. 기본적으로 이전 전술 절, 요구사항, 관계 방향, 결정 소유자를 바꾸지 않는다. 다만 [심화 절차](#심화)에서 이 stage의 질문에 대한 사용자 답변으로 새 업무 규칙이 확인되면, 공통 deepening 규칙에 따라 해당 요구사항 행만 추가할 수 있다. 기능 이름만 보고 관계나 방향을 추론하지 않는다. modular monolith 배포를 전제하지 않는다. 사용자가 토폴로지를 지정하지 않았다면 배포 방식은 미정으로 둔다. framework, protocol, broker, 직렬화 형식, 저장 기술, Saga, Outbox, 분산 트랜잭션을 선택하지 않는다.

## 절차

1. `stakeholder-analysis.md`에 `판정: 생략`이 있으면 근거 경로를 포함해 `completed/OK`를 반환하고 파일은 쓰지 않는다.
2. `CONTEXT-MAP.md` 관계와 5절 통합을 대조한다. 이 plan set이 실제 사용하는 각 관계에 대해 근거가 있을 때만 관계 패턴, 코드 의존 형태, 경계 강제 방식을 결정한다. 근거가 관계를 설명할 때 Customer–Supplier, Conformist, ACL, Published Language 등을 후보로 고려할 수 있다.
3. 코드 의존은 5절 근거가 뒷받침하면 upstream 공개 API, downstream 소유 port와 조립 adapter, 또는 프로세스 내 event가 될 수 있다. 순환 의존을 만들지 않는다. event에도 계약 소유자가 있다. 각 컨텍스트는 자기 데이터를 소유하며 다른 컨텍스트의 table이나 Repository에 접근하지 않고 내부 타입을 경계 너머로 전달하지 않는다.
4. 확인된 구조에 비례하는 경계 강제 방식을 고른다. 서로 다른 경계 결정으로 이어질 중요한 근거가 빠졌고 선택이 필요할 때만 질문을 한국어 한 번의 묶음으로 한다. 업무상 결과를 설명하는 선택지, 권장안과 이유를 포함한다. 답은 `answers.json` 및 `question_id`와 함께 그대로 기록한다.
5. template 표를 사용해 `## 6. 컨텍스트 경계`를 쓰고, 이 plan set이 사용하는 관계마다 근거·출처를 적는다. 관계가 없으면 같은 표에 `해당 없음`과 근거를 명시한다. 근거가 없거나 모호하면 건너뛰지 말고 공백을 기록하거나 질문한다.
6. 이어진 작업에 구형 `## 6. 결정 이력`이 있으면 기존 행을 보존하고 해당 절 전체를 `## 7. 결정 이력`으로 옮긴 다음 6절을 작성하고 이 stage의 결정을 7절에 추가한다. 기존 결정을 다시 번호 매기거나 고쳐 쓰지 않는다.
7. 근거가 있을 때만 기존 `CONTEXT-MAP.md` 관계 행의 관계 패턴 열을 갱신한다. 해당 열이 없으면 기존 셀을 보존하면서 상태 열 앞에 추가한다. map 관계를 만들어내지 않는다. map을 바꾼 경우에만 artifact로 보고한다.
8. plan 문서와 변경된 project map을 artifact로 보고 `completed/OK`를 반환한다. 질문이 필요하면 `action_required` / `USER_DECISION_REQUIRED`를 반환한다.

## 심화

질문 답변으로 새 업무 규칙이나 예외가 드러나면, 답변에서 확인된 내용만 소유 `BIZ`에 `INV` 또는 `EX`와 `AC`로 추가한다. `answers.json`과 `question_id`를 인용하고 이력을 기록한다. 기존 모델과 동작이 규칙을 소유할 수 있을 때만 `### 1.4`, `### 2.2` 매핑 행과 출처가 있는 `DEC`를 추가한다. 새 모델, Aggregate, 일관성 결정, Domain Service, use case 또는 integration을 바꿔야 한다면 해당 절을 수정하지 말고 가장 앞서 다시 열 stage를 지정해 `blocked` / `DEPENDENCY_INCOMPLETE`를 반환한다.

## 최종 gate

이전 실행이 `blocked`였다면 이전 gate 오류는 당시 시도의 근거로만 보고 현재 문서에 gate를 다시 실행한 뒤 현재 오류로 block한다. [공통 재시작 규칙](../domain-model/references/deepening.md#relaunch-after-a-block)을 따른다. Runner는 이 stage가 `completed/OK`를 반환한 뒤에만 전술 gate를 실행한다. 실패하면 각 finding의 `owner_stage`와 함께 `gate_error`가 반환된다. 이 stage 소유 오류는 여기서 고칠 수 있다. 이전 stage 오류는 확정된 입력이므로 문서를 시작 당시의 commit 상태로 복구하고 가장 앞선 `owner_stage`를 지정해 `blocked` / `DEPENDENCY_INCOMPLETE`를 반환한다. 오류의 `code`, `id`, `message`를 근거로 포함한다. 사용자는 `--restart-requirements true` 또는 `--user-revision true --feedback`으로 해당 stage를 다시 연다. 앞 stage `owner_stage`의 오류로 block할 때는 `result.owner_stage`에 가장 앞 owner를, `result.dependency_gap`에 gate 오류 근거를 적는다. orchestrator가 사용자에게 묻지 않고 그 stage를 다시 열어 앞으로 진행하며, 이 stage는 마지막 stage이므로 다시 완료될 때 gate가 다시 실행된다. [자동 되돌아가기 규칙](../domain-model/references/deepening.md#automatic-rewind-to-the-owner)

## 완료 조건

5절의 각 integration 행은 출처가 있는 경계 결정에 대응해야 한다. 5절 integration 행이 없어도 6절에는 관계가 없다는 근거를 기록한다. 배포 방식이나 기술을 임의로 정하지 않는다. Runner는 `CONTEXT-MAP.md`를 변경 artifact로 보고한 경우에만 `docs/specs/<plan-set-id>/`와 함께 commit한다.
