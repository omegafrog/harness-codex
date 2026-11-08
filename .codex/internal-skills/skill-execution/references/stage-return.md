# Stage 반환 계약

각 stage 실행은 실행기가 제공한 출력 schema에 맞는 JSON 객체 하나를 마지막 응답으로 반환한다. 최상위 `schema_version`, `execution_id`, `skill`, `status`, `code`, `result`를 채운다. ID와 skill은 실행 입력을 그대로 사용하고, `result` 안의 같은 필드와 최상위 `status`, `code`를 일치시킨다. `result`에는 schema가 요구하는 `summary`, `artifacts`, `questions`와 해당 stage의 추가 필드도 넣는다. 해당 사항이 없으면 배열은 `[]`, schema에 `review_request`가 있으면 리뷰 요청이 없을 때 `null`이다. 실제 필수 필드와 stage별 추가 제약은 실행기가 제공한 schema와 해당 GUIDE를 따른다.

| status | 허용 code | 의미 |
|---|---|---|
| `completed` | `OK` | 이 stage의 요청 범위와 완료 gate를 통과했다. |
| `action_required` | `REVIEW_REQUIRED`, `SPEC_REVISION_REQUIRED`, `PLAN_REVISION_REQUIRED`, `IMPLEMENTATION_REVISION_REQUIRED`, `USER_DECISION_REQUIRED` | 상위 caller가 리뷰·다른 stage·사용자 결정으로 전환해야 한다. |
| `blocked` | `ENVIRONMENT_UNAVAILABLE`, `PERMISSION_REQUIRED`, `DEPENDENCY_INCOMPLETE`, `INPUT_MISSING`, `MODEL_BINDING_UNAVAILABLE` | 환경·권한·의존성·입력·모델 전제가 없어 실행을 계속할 수 없다. |
| `failed` | `EXECUTION_ERROR`, `INVALID_INPUT`, `ARTIFACT_WRITE_FAILED` | 실행·입력 검증·산출물 기록이 실패했다. |
| `cancelled` | `CANCELLED` | 실행이 취소됐다. |

Spec 수정이 필요하면 반드시 `action_required` / `SPEC_REVISION_REQUIRED`를 함께 반환한다. 작업이 실제로 막혔다는 이유로 `blocked`와 이 코드를 조합하지 않는다. tracker의 Blocked 상태와 stage 반환 `status`는 별개다. 계획 수정과 사용자 결정도 각각 `action_required` / `PLAN_REVISION_REQUIRED`, `action_required` / `USER_DECISION_REQUIRED`를 쓴다. 임의의 코드나 조합을 만들지 않는다.

사용자 결정이 필요하면 `result.questions`에 [질문 스키마](../schemas/question.schema.json)의 질문을 넣고 `action_required` / `USER_DECISION_REQUIRED`로 반환한다. 질문이 하나여도 배열에 담고 질문 문장은 `title`에 쓴다. 질문이 없으면 빈 배열로 둔다. stage 안에서 사용자 질문 도구를 직접 호출하지 않는다. orchestrator가 실제 답변을 전달하면 이전 결과·질문·답변을 읽어 같은 작업을 이어가며, checkpoint와 이미 확정된 답변을 결과 파일에 보존한다. 리뷰 요청이나 산출물은 해당 stage의 계약과 제공된 schema에 맞게 기록한다. 읽기 전용 reviewer의 새 보고서는 schema가 요구하는 `result.artifact_contents`로 반환한다.

모델은 `result_ref`를 만들지 않는다. runner가 마지막 응답을 검증하고 결과 위치를 정해 `result.json`과 `return.json`을 기록한다. 실행 상태나 결과 파일을 직접 고쳐 검증을 우회하지 않는다.
