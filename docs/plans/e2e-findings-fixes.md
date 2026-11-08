# 소비자 E2E에서 드러난 남은 문제와 해결 계획

2026-11-08 `harness-test` E2E(run `e2e-20261108-175035`, Codex gpt-6-luna medium)에서 확인한 문제 중 아직 고치지 않은 것을 정리하고 해결 순서를 정한다. 이미 고친 것(provider 단일화, Ghostex 제거, 결과 전달 재개, Codex subagent hook, 리뷰 신원 hook 바인딩, orchestrator sandbox·model 유지, artifact 해시 계산, 초안 완료 검사, orchestrator의 background·소스 열람 규칙)은 제외한다.

## 진행 순서 요약

| 단계 | 내용 | 이유 |
|---|---|---|
| 1 | P1 정지한 stage가 보이지 않는 문제 | 사용자가 알 수 없는 정지가 E2E를 두 번 막았다 |
| 2 | P2 시작 hook 출력 축소, P3 후보·질문 전달 | 모든 workflow 첫 화면에 영향 |
| 3 | P4 plan 리뷰 admission 읽기 실패 | 원인을 모르는 실패 |
| 4 | P5 질문 batch, P6 compose 요청 변형 | 사용자 경험 |
| 5 | P7 dead manifest hook·wrapper 정리, P8 EXEC.md·기존 실패 테스트 | 정리 |

각 단계는 소스 수정, 설치·update 경로, Doctor, 설치된 consumer 회귀 테스트, `harness-test` update와 E2E 재확인까지 한 번에 끝낸다(AGENTS.md 규칙).

## P1. stage가 조용히 멈춘다

**관찰:** 두 번의 정지에서 state는 `running`인데 프로세스는 없었고, 사용자에게 가는 알림이 없었다(`progress.json`도 갱신되지 않았다). 원인은 (a) workspace-write sandbox 안의 background 실행기(고침), (b) foreground로 시작한 실행기(규칙으로 막음)였지만, 다른 원인으로 죽어도 같은 증상이 반복된다.

**해결:**
1. 실행기가 시작할 때 `runner_started`를 쓰기 전에 죽는 경우를 잡는다. `harness-agent-run.mjs --background true`는 launcher가 `runner_started` 이벤트(또는 `process-events.jsonl`)가 생길 때까지 최대 10초 기다리고, 없으면 `failed/EXECUTION_ERROR`로 종료하며 시작 응답에 `status: "failed"`를 돌려준다.
2. 실행 중 죽은 실행기를 찾는 reconcile: `harness-prepare-input.mjs`와 시작 hook이 `running` stage의 owner·child PID가 모두 죽었는지 확인해 state를 `failed`로 기록하고 `delivery` 이벤트를 발행한다(기존 `assertExecutionStopped`, `processIdentity` 재사용). 결과는 기존 결과 전달 경로로 orchestrator에 간다.
3. 결과 전달이 실패하면(`unsupported`·`pending`) 시작 hook의 `progress`에 `undelivered_results`로 노출해 다음 사용자 프롬프트 때 orchestrator가 읽게 한다.

**테스트:** 실행기가 죽는 fake provider로 (1) 시작 실패 응답, (2) reconcile 후 `failed` 이벤트와 전달, (3) 전달 실패 시 progress 노출을 설치된 consumer에서 확인한다.

## P2. 시작 hook 출력이 Codex에서 잘린다

**관찰:** UserPromptSubmit `additionalContext`가 약 2,500~2,950 token이었고 Codex가 중간을 잘랐다. orchestrator는 잘린 본문과 `.io/tmp/hook_outputs/…` 경로만 받았다.

**해결:** 관찰 상태 JSON에서 orchestrator 선택에 필요하지 않은 필드를 줄인다.
- `worktree_candidates`는 요약(후보 ID 8자리, 단계, 상태, 원 요청 80자)만 넣고 상세는 `progress.json` 경로로 가리킨다.
- 전체 상태는 `<session>/runtime/orchestrator/startup-state.json`에 쓰고 hook은 그 경로와 `decision_hint`만 준다.
- 목표 크기는 1,200 token 이하로 하고 테스트로 상한을 건다.

**테스트:** 후보 10개·긴 요청 fixture에서 hook 출력 바이트 상한과, 상태 파일에 전체 후보가 있는지 확인한다.

## P3. orchestrator가 후보를 빼고 질문 문구를 바꾼다

**관찰:** hook 후보 4개 중 `blocked` 후보 하나가 선택지에서 빠졌다. 질문 도구 첫 호출은 존재하지 않는 `question` 필드로 실패했고, 최종 메시지는 선택지 문구를 바꿔 썼다. stage가 반환한 질문도 `consequence`·`rationale`·추천 표시가 일부 빠진 채 제시됐다.

**해결:**
1. 후보 선택 질문을 orchestrator가 쓰지 않고 Harness가 만든다. `startup-state.json`에 `candidate_question`(제목, 선택지 ID·라벨·설명, 추천 없음)을 미리 만들고 SKILL은 "이 질문을 글자 그대로 제시한다"만 말한다. `blocked`·`failed` 후보도 상태를 라벨에 표시해 모두 넣는다.
2. 질문 제시 형식을 하나로 정한다: 제목, 번호 있는 선택지(`label` — `consequence`), 추천 선택지는 "(추천)"을 덧붙인 같은 줄, 이유(`rationale`)는 다음 줄. SKILL에 이 형식을 한 번만 쓴다.
3. 질문 도구 인자 형식(`title`, 문자열 `options`)을 SKILL에 예시와 함께 적는다.

**테스트:** 후보 `blocked` 포함 fixture에서 `candidate_question`이 모든 후보를 담는지, 질문 렌더 함수가 consequence·추천을 보존하는지 확인한다.

## P4. plan 리뷰 1회차에서 reviewer가 admission을 읽지 못했다

**관찰:** `plan_reviewer`가 "runner-owned admission JSON을 지정된 경로에서 읽을 수 없다"고 blocker를 냈다. 파일은 실행 디렉터리에 있었고, 이후 회차는 통과했다. read-only reviewer가 stage 시작 전 만든 `.io` 파일에 접근하지 못했는지, `reviewer_input_ref` 경로 해석이 잘못됐는지 알 수 없다.

**해결:**
1. 먼저 재현한다. 1회차 reviewer rollout(`~/.codex/sessions/…`)에서 실제로 시도한 경로와 오류를 확인한다.
2. 원인에 따라: 경로가 상대 경로라서 틀렸다면 `reviewer_input_ref`를 절대 경로로 주고, sandbox 문제라면 reviewer 프로필의 읽기 허용 경로에 session runtime을 포함한다.
3. 실패한 회차가 revise로 소비되지 않게, admission을 읽지 못한 reviewer 결과(blocked)는 회차를 소비하지 않는 `pre-dispatch` 경로로 처리하는 방안도 검토한다.

**테스트:** 재현된 원인에 맞춰 설치된 consumer에서 reviewer가 admission을 읽는 경로를 확인한다.

## P5. 독립 질문이 여러 번에 나뉘어 나온다

**관찰:** spec-me가 Product 질문을 3·2·1개로 나눠 반환했다. GUIDE에 "모아서 한 번에"가 있지만 지켜지지 않았다. 강제 장치는 비용이 커서 만들지 않기로 했다.

**해결:** 강제하지 않고 GUIDE 문구만 구체화한다. product-spec GUIDE의 질문 단계에 "반환 전에 `topics.md`의 모든 주제를 한 번 훑어, 아직 답이 없고 서로 의존하지 않는 질문을 전부 한 배열에 넣는다. 한 번 반환한 뒤 이어서 묻는 질문은 직전 답에 따라 새로 생긴 것이어야 한다"를 넣는다. 다음 E2E에서 질문 회차 수를 관찰 항목으로 둔다.

## P6. orchestrator가 원 요청을 바꿔 compose에 넘긴다

**관찰:** 사용자 프롬프트에 없던 마침표가 붙은 요청이 `worktree.json`·`progress.json`·input에 기록됐다.

**해결:** SKILL의 compose 호출 절에 "요청 원문을 글자 그대로 `--request`에 넘긴다(앞뒤 공백 제거 외 변경 금지)"를 명시한다. compose 스크립트는 `$orchestrator` 같은 호출 접두어만 제거한다.

## P7. 실행되지 않는 코드와 선언

**관찰:** workflow manifest의 `before_dispatch`·`before_handoff` 목록과 `.harness/src/wrapper/{scheduler,dispatch}.mjs`는 기본 흐름에서 실행되지 않는다. 문서는 이미 이를 실제 CLI로 바꿨다.

**해결:** 소비자가 없음을 grep으로 확인한 뒤 wrapper의 dispatch·scheduler(및 `buildImplementPrompt` 소비 테스트), manifest의 두 목록과 loader 검증을 제거한다. `repair.mjs`·`review` gate 등 실제 사용되는 부분은 남긴다. installer의 retire 경로로 consumer에서 제거한다.

## P8. 정리

1. `harness-test`의 `docs/agents/EXEC.md`: 실행 binding이 setup과 같은 provider여야 한다는 점, Codex hook 신뢰 선행 조건, 매 실행의 `</dev/null`, 다음 질문 절차(`codex exec resume`)와 결과 전달 재개를 반영한다. (테스트 저장소 문서라서 사용자 승인 후 수정한다.)
2. 기존 실패 테스트 `installed to-ticket uses skill binding …`: 지금은 없어진 발행 방식을 실제 GitHub에 호출한다. 현행 `harness-publication.mjs` 계약에 맞게 fake `gh`로 다시 쓰거나 삭제한다.
3. stage 안에서 `rm -f`가 막히는 문제는 영향이 작아 관찰만 한다.

## 검증

- 단계마다 `npm test`와 전체 테스트, 설치된 consumer 회귀 테스트를 통과시킨다.
- 1~4단계가 끝나면 `harness-test`를 최신으로 맞추고 새 workflow를 처음부터 E2E로 돌려 spec-me → to-ticket → 발행 승인 → tracker-publish까지 정지 없이 가는지 확인한다. 이후 구현·리뷰·최종 E2E 구간은 별도 라운드로 검증한다.
