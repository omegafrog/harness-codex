# Stage 반환 계약

각 stage 서브에이전트는 전달받은 schema 파일을 직접 읽고 지정된 출력 파일에 schema에 맞는 JSON 객체 하나를 작성한다. 형식 오류를 전달받으면 해당 키와 값을 고쳐 같은 파일에 다시 작성한다. 실행 ID는 작성하지 않는다. 실행기가 정본 입력의 ID를 최상위와 `result`에 채운다. `skill`, `status`, `code`는 `result`와 일치시킨다. `result`에는 schema가 요구하는 `summary`, `artifacts`, `questions`와 해당 stage의 추가 필드도 넣는다. 해당 사항이 없으면 배열은 `[]`, schema에 `review_request`가 있으면 리뷰 요청이 없을 때 `null`이다. 실제 필수 필드와 stage별 추가 제약은 실행기가 제공한 schema와 해당 GUIDE를 따른다.

`summary`는 최상위가 아닌 `result.summary`에 작성한다. 실행기가 저장하는 `result.json`은 직접 작성하지 않는다.

| status | 허용 code | 의미 |
|---|---|---|
| `completed` | `OK` | 이 stage의 요청 범위와 완료 gate를 통과했다. |
| `action_required` | `REVIEW_REQUIRED`, `SPEC_REVISION_REQUIRED`, `PLAN_REVISION_REQUIRED`, `IMPLEMENTATION_REVISION_REQUIRED`, `USER_DECISION_REQUIRED` | 상위 caller가 리뷰·다른 stage·사용자 결정으로 전환해야 한다. |
| `blocked` | `ENVIRONMENT_UNAVAILABLE`, `PERMISSION_REQUIRED`, `DEPENDENCY_INCOMPLETE`, `INPUT_MISSING`, `MODEL_BINDING_UNAVAILABLE` | 환경·권한·의존성·입력·모델 전제가 없어 실행을 계속할 수 없다. |
| `failed` | `EXECUTION_ERROR`, `INVALID_INPUT`, `ARTIFACT_WRITE_FAILED` | 실행·입력 검증·산출물 기록이 실패했다. |
| `cancelled` | `CANCELLED` | 실행이 취소됐다. |

`blocked` / `DEPENDENCY_INCOMPLETE`는 앞 stage의 산출물이 비었거나 부족해 계속할 수 없을 때 쓴다. 전술 설계 stage와 `tactical-technology`·`tactical-api`·`tactical-data`는 `result.owner_stage`에 빈틈을 소유한 가장 앞 stage의 ID를, `result.dependency_gap`에 그 stage가 추가하거나 고쳐야 할 내용(빠진 operation·호출·transaction 경계·행과 근거)을 반드시 적는다. 해당하지 않으면 두 필드는 `null`이다. `to-ticket`은 확정된 설계만 나누므로 `DEPENDENCY_INCOMPLETE`를 반환할 수 없고(`format_error`), 설계 결함은 `blocked` / `INPUT_MISSING`과 `DESIGN_NOT_FROZEN:`으로 시작하는 summary로 사용자에게 보고한다. `tactical-data`가 완료될 때 실행기가 design-freeze gate(`harness-design-freeze-check.mjs`)를 한 번 실행하며, 실패하면 `gate_error`이고 `to-ticket`은 gate가 통과하기 전에는 시작하지 않는다(`DESIGN_NOT_FROZEN`). 실행기는 이 pairing이 없거나 `owner_stage`가 앞 stage가 아니면 `format_error`로 돌려보내고, 있으면 orchestrator가 사용자에게 묻지 않고 그 stage를 다시 열어 앞으로 진행한다([상위 stage 되돌아가기](dispatch.md#상위-stage-되돌아가기)). 업무 결정이 필요한 경우는 이 코드가 아니라 `USER_DECISION_REQUIRED`를 쓴다. `tactical-ui`가 화면 설계를 기다리는 `DEPENDENCY_INCOMPLETE`는 `frontend-design-brief` 인계이므로 `owner_stage`가 `null`이다. 이 block은 `--user-revision`·`--restart-requirements`·사용자 질문이 아니라 오류·`finish`의 `next`(owner 재개 또는 `owner_stage`가 없는 옛 결과의 block된 stage 재실행)로 처리한다.

Spec 수정이 필요하면 반드시 `action_required` / `SPEC_REVISION_REQUIRED`를 함께 반환한다. 작업이 실제로 막혔다는 이유로 `blocked`와 이 코드를 조합하지 않는다. tracker의 Blocked 상태와 stage 반환 `status`는 별개다. 계획 수정과 사용자 결정도 각각 `action_required` / `PLAN_REVISION_REQUIRED`, `action_required` / `USER_DECISION_REQUIRED`를 쓴다. 임의의 코드나 조합을 만들지 않는다.

지금 답할 수 있는 질문은 최대한 모아 한 번에 반환하고, 앞선 답에 따라 달라지는 질문만 다음으로 미룬다. 사용자 결정이 필요하면 `result.questions`에 [질문 스키마](../schemas/question.schema.json)의 질문을 넣고 `action_required` / `USER_DECISION_REQUIRED`로 반환한다. 질문이 하나여도 배열에 담고 질문 문장은 `title`에 쓴다. 질문이 없으면 빈 배열로 두고, 결과 최상위에 단수 `question` 필드는 쓰지 않는다. stage 안에서 사용자 질문 도구를 직접 호출하지 않는다. orchestrator가 실제 답변을 전달하면 이전 결과·질문·답변을 읽어 같은 작업을 이어가며, checkpoint와 이미 확정된 답변을 결과 파일에 보존한다. 리뷰 요청이나 산출물은 해당 stage의 계약과 제공된 schema에 맞게 기록한다. 읽기 전용 reviewer의 새 보고서는 schema가 요구하는 `result.artifact_contents`로 반환한다.

모델은 `result_ref`를 만들지 않는다. 호출자가 출력 파일의 형식을 검증하고 결과 위치를 정해 `result.json`과 `return.json`을 기록한다. 실행 상태나 결과 파일을 직접 고쳐 검증을 우회하지 않는다.
