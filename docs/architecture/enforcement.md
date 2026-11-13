# 규칙과 실제 검사

자동 검사와 의미적 리뷰를 구분한다. 새 오류를 발견하면 `correct`로 반복 사례와 기존 검사 누락을 확인하고, 같은 역할의 검사기를 새로 만들기보다 아래 seam을 활용한다. 이 표는 오류 발생 이력을 추측하지 않는다.

setup의 질문·수신·완료 판정은 `.harness/src/workflow/setup-answers.mjs`와 `harness-setup.mjs`가 소유한다. 현재 배치 생성 후 실제 접수된 rollout 호출의 인자를 대조해 호출 ID와 항목 대응을 고정하고, 해당 폼에서 표시한 질문의 답만 누적한다. 다른 호출·중단 후 응답은 진행 근거로 쓰지 않으며 `can_continue`가 참일 때만 다음 CLI 실행을 허용한다. 설치·갱신은 기존 managed asset 탐색으로 helper·스킬 참조를 배포하고 Doctor는 helper/CLI 누락을 진단한다. `tests/setup_configuration.test.mjs`가 실제 관측한 UI 형식의 fixture로 부분·역순·중복·마지막 답·조건부 생략·최종 확인·중단·Git 가시성을 검증한다. 사용자 설명 요청에 먼저 답하기와 실제 응답을 CLI로 전달하기는 스킬의 수동 실행 규칙이며 hook 자동 수신이나 live UI 정상 진행을 이 회귀만으로 증명하지 않는다.

결과 listener는 검증한 event의 `delivery.observed_at`을 session에 보존하며, runner는 관찰된 결과를 Wake에 다시 전달하지 않는다. 이미 큐에 들어간 알림의 소비 중복·중단 요청 유지와 정상 실행 중 폴링 금지는 orchestrator와 `skill-execution/references/dispatch.md`의 의미적 실행 규칙이다. Spec `begin`은 확정 상태·intent 필드·위임 근거를, GitHub plan `begin`과 planning check는 필수 Issue 초안을 검사한다. 독립 리뷰와 최종 결과 검증은 계속 필요하다. 회귀 근거는 `tests/stage_result_events.test.mjs`, `tests/intent_and_excess_guidance.test.mjs`, `tests/plan_review_spec_paths.test.mjs`다.

| 규칙 | 현재 enforcement | 남는 판단/한계 |
|---|---|---|
| workflow 호출은 target worktree의 cwd 안에서만 허용한다 | primary checkout의 workflow-compose는 새 worktree를 만들고 경로를 반환한 뒤 멈춘다. `.harness/src/workflow/cli-context.mjs`는 다른 worktree를 지정하는 `--root`·`--worktree-ref`를 거부하고, startup hook은 현재 cwd의 worktree 입력만 기록한다. `tests/worktree_cwd_enforcement.test.mjs`는 installed consumer의 main 차단·local prepare/runner·update·Doctor·Git 가시성을 검사한다 | 실제 Codex 대화의 cwd 변경과 자동 결과 알림 후 사용자 동작은 fixture만으로 증명하지 않음 |
| 실행 경로와 발행 본문의 실행 정보는 agent가 선택하지 않고 정적 실행기가 생성한다 | `resolveExecutionWorkspace`가 정본 worktree.json과 Git root/common/등록/branch를 검증하고 stage 입력·plan-review에 주입한다. 발행 입력 준비기와 publication publish가 본문 파일을 생성하며 최종 Project body를 비교한다. `tests/execution_workspace.test.mjs`는 설치 consumer에서 main 유도·입력 변조·본문 변조·branch 불일치·업무 파일 보존과 Git 가시성을 검사한다 | 구형 승인 plan의 경로 문자열은 표시 이력만 보존하며 실행 입력으로 쓰지 않음. 본문 업무 의미는 독립 리뷰가 판단 |
| Spec 밖 동작은 자동 수정·확대되지 않고 사용자 유지/제거 결정을 받는다 | `.harness/src/wrapper/repair.mjs`의 `classifyReviewFindings`·`reserveImplementationRepair`가 `unplanned_additions` 신고, `basis` 인용 대조, 답변 기록을 강제하고 `tests/review_scope_guard.test.mjs`가 검사한다 | 인용이 실제로 그 수정을 요구하는지, diff의 숨은 추가를 찾았는지는 reviewer의 의미 판단이다. 실제 문서에 있는 관련 문장을 인용하면 기계 검사는 통과한다. `rule_impact`의 정직성은 reviewer가 검토하며 기계 검사는 표시값만 본다. `failure_scenario`는 존재와 ID만 검사하며 시나리오의 타당성은 reviewer와 사용자가 판단한다. 규칙의 `의도`·`충분한 수준`은 Spec·plan 리뷰가 확인한다 |
| Codex linked worktree의 worker가 `.git`에 쓸 수 없어도 구현 commit이 끊기지 않는다 | `.harness/src/workflow/stage-commit.mjs`가 `commit_request`의 경로만 sandbox 밖에서 commit하고 `tests/review_scope_guard.test.mjs`가 검사한다 | worker가 파일 목록을 정확히 쓰는지는 리뷰가 확인한다 |
| 구현 폭이 넓은 규칙과 기능은 의도·충분한 수준·출처를 기록하고, 위임 결정은 실제 사용자 답변을 근거로 한다 | `.harness/src/workflow/spec-review.mjs`의 `intentIssues`·`decisionsWithoutDelegation`이 `inspectSpecReviews`를 통해 Spec 완료와 계획 인계를 막고 `tests/review_scope_guard.test.mjs`가 검사한다 | 규칙 판별은 키워드 기반이며 필드 존재만 검사한다. 요청 해석·추정이라는 출처만으로 사용자 질문을 강제하지 않는다. 해석의 근거·승인 오기재, 충분한 수준의 관찰 가능성, 작업 없이는 실패하는 UC/BR/AC·공통 기본선의 타당성은 Spec·plan·구현 reviewer가 판단한다. 위임 검사는 `answers.json` 언급만 확인하며 그 답변의 의미는 검증하지 않는다 |
| 기존 implement-wrapper는 split plan을 하나씩 구현하고 통합 Spec 리뷰 뒤 최종 E2E 시나리오의 사용자 승인을 받으며 실패 시 자동 수정·재실행을 멈춘다 | orchestrator의 implementation reference·implement-wrapper·e2e-test·runner 지침; `tests/implement_wrapper_consumer.test.mjs`의 신규/갱신 consumer 배포·링크·Doctor·Git 가시성 검사 | 순서·실제 승인·실패 후 조치는 agent가 준수하는 의미적 계약이며 범용 runtime 자동 gate는 아니다. 설치 검사는 실제 모델 실행의 준수 여부를 증명하지 않음 |
| workflow 입력 참조와 결과 artifact는 workspace 내부 파일 또는 디렉터리를 가리킨다 | `.harness/src/workflow/skill-execution.mjs`의 경로·workspace 경계 검사, `tests/skill_execution_schema_compatibility.test.mjs`의 설치 소비자 회귀 | 파일 내용을 실제로 읽는 참조는 regular file만 허용하며, 디렉터리 내용의 완전성은 artifact 작성 스킬과 리뷰어가 판단 |
| 전달 workspace와 실제 Git worktree가 일치해야 한다 | `.codex/scripts/harness-workspace-preflight.mjs`, `tests/workspace_preflight.test.mjs`, dispatch의 before_dispatch hook | 작업별로 hook/명령을 실제 실행했는지 확인 필요 |
| 승인된 decision과 review만 인계한다 | `.harness/src/workflow/stage-gates.mjs`, `tests/decision_gate_cli.test.mjs`, `tests/workflow_system_targets.test.mjs` | 선택이 없는 경우 decision metadata는 필요하지 않으며 실제 선택·근거의 의미는 작성자와 reviewer가 판단 |
| tracker 구조 입력을 검증 후 렌더한다 | `.harness/src/tracker/contracts.mjs`, `.harness/src/tracker/render.mjs`, `tests/tracker_contract.test.mjs` | acceptance/test-contract 문자열의 의미적 요구사항 완전성은 reviewer 판단 |
| 원본 workflow가 오래된 설치 스킬을 선택하지 않는다 | `.harness/src/workflow/loader.mjs`, `tests/workflow_loader.test.mjs`의 source/consumer 우선순위 검사 | consumer의 설치 사본 최신화는 installer update가 담당 |
| 현재 저장소의 진행 중 workflow는 Codex session ID 변경과 무관하게 재개하고, 중복 stage 실행은 막는다 | `.harness/src/workflow/startup-state.mjs`, `.harness/src/workflow/stage-input.mjs`, `.harness/src/workflow/execution-state.mjs`; `tests/orchestrator_hook.test.mjs`, `tests/skill_execution.test.mjs`, installed-consumer case in `tests/installer_update.test.mjs` | 같은 저장소에 여러 활성 workflow가 있으면 orchestrator가 정확한 대상을 판단해야 함; 다른 Git common directory나 검증되지 않은 worktree는 계속 차단 |
| stage 결과는 실제 native 서브에이전트에 연결하고 형식을 검증해 terminal 상태로 기록한다 | `.codex/scripts/harness-native-stage.mjs`, `.harness/src/workflow/output-schema.mjs`, `.harness/src/workflow/stage-checkpoint.mjs`; `tests/worktree_record_contract.test.mjs` | 실제 CLI별 서브에이전트 도구의 실행 및 메시지 전달은 별도 검증이 필요하다 |
| workflow completion은 소유 linked worktree를 제거하지 않고 완료 산출물과 등록을 보존한다 | `.harness/src/workflow/completion.mjs`의 canonical worktree identity 검사와 `worktree_retained` receipt; `tests/workflow_completion_retention.test.mjs`의 installed consumer gate·worktree 등록·Git 가시성 검사 | `finish`에 의한 명시적 삭제는 사용자의 별도 요청이며 이 완료 gate의 일부가 아님 |
| 스킬의 supporting reference도 갱신된다 | `.harness/src/installer/update.mjs`, `tests/installer_update.test.mjs`의 reference 배포·변경·충돌 보존 검사 | 로컬 수정 충돌은 자동 덮어쓰지 않음 |
| checkpoint가 손상된 journal을 완료 증거로 사용하지 않고 status-only handoff에서 측정·추적 증거를 보존한다 | `.harness/src/wrapper/checkpoint.mjs`, `tests/wrapper_checkpoint.test.mjs` | measurements 값의 사실성·조건 동등성은 별도 검증 필요; 명시적 evidence 필드 교체는 허용 |
| 업무 규칙은 선언된 owner에서 보호한다 | `ddd-design/references/model-continuity.md`, Spec reviewer의 실제 source/caller/우회 경로 검토와 프로젝트별 domain/dependency 검사 | 범용 JavaScript 구조 검사로 DDD 의미를 자동 판정하지 않음 |
| 승인된 구형 경로 제거를 실제 파일로 확인한다 | `.harness/src/gates/lifecycle.mjs`의 `retirement`, wrapper completion의 실제 workspace 검사, `tests/lifecycle_gates.test.mjs` | 제거 목록은 승인된 canonical plan의 `## 제거 대상` 절에서 읽으며 자동 추론하지 않음(`implement-wrapper` 최종 gate는 `.harness/src/workflow/implementation-completion.mjs`, `tests/implement_wrapper_completion.test.mjs`); 용어의 의미와 호환 예외는 독립 리뷰가 판단; 옵션 없는 legacy 직접 API는 기존 동작 |
| 성능 개선은 실제 작업·오류·조건·편차로 뒷받침한다 | `evaluate-harness/references/measurement.md`, plan의 실행 증거 계약, Standards/Spec review | 측정 계약은 자동 통계 gate가 아니며 raw 결과 확인 필요 |
| blind 실험은 신원과 rubric 누출을 확인한다 | `evaluate-harness/references/blinded-comparison.md` | 기존 suite 실행이 자동 blind가 되지 않으며 coordinator의 사전 확인 필요 |
| E2E 선택과 dynamic agent oracle은 필요한 경로에만 둔다 | `.codex/internal-skills/e2e-test/references/verification-policy.md`, to-ticket/implement/runner 지침 | 의미적 수동 정책이다. 자동 runtime 판정/집행은 없다. Plan·Spec·oracle·budget을 사전 검토하고 결과 증거를 대조한다 |
| Harness 갱신 후 정리는 설치 산출물과 프로젝트 변경을 구분하고 미커밋 준비 문서를 보존한다 | `AGENTS.md`, `setup/SKILL.md`, `implement/GUIDE.md`의 정리 절차; 설치형 Harness 경로는 `git check-ignore -v`로 확인 | `.gitignore`/`.git/info/exclude`는 tracked modifications를 보호하지 않으므로 변경·미추적 파일 백업과 소유권 분류는 정리 주체가 확인한다 |

## 통합 계약 완료 gate

Spec·계획 리뷰의 반복 제한은 `.harness/src/workflow/review-attempts.mjs`와 리뷰 CLI의 `begin/record/abort/resolve`가 관리한다. 대상별 실행 중복, 미변경 입력 재요청, 최초 검토 후 재검토 2회 초과를 차단하고 원본 판정·지적·stale을 session에 보존한다. Spec review는 Architecture 축만 수행하며 Product Spec은 요구사항 입력으로 snapshot에 포함한다. 시작된 검토의 pass 기록은 기존 Spec·계획 gate에서 확인한다. 사용자 결정의 진위, 리뷰 전 문서 일괄 반영과 reviewer 역할 선택은 호출자의 검토 계약이다. 근거: 세션 `01a1682e-92be-7642-94d2-e4ce85d070e5`의 반복 Spec·계획 리뷰 및 Learning 자료 승인 대기. 신규·업데이트 설치의 실행·Git 가시성은 `spec-review-check` profile로 확인한다.

`.harness/src/contracts/contracts.mjs`는 consumer 프로젝트의 `docs/contracts/` bundle을 검사한다. `contract_docs`는 모든 workflow의 `before_complete`에 등록되며 `harness-workflow-complete.mjs`가 이를 실제 호출해 pass/fail receipt를 기록한다. 시작 SHA 누락은 차단된다. `executeImplementPlan`도 실제 검증된 workspace에서 직접 검사하므로, agent가 누락하거나 pass를 주장해도 source/문서 snapshot이 어긋나면 완료 reconciliation과 종속 plan 해제가 차단된다. 순수 `evaluateCompletion`에도 pass verdict가 필수다.

`check`는 형식만 검사하므로 의미 검토를 별도로 강제한다. `sync-contracts` stage는 seal 뒤 `.codex/scripts/harness-contract-review.mjs`로 `contracts-<plan-set-id>` review history에 회차를 열고(`begin`), fresh `contract_reviewer`(`fork_turns: none`; fork 시작은 PreToolUse fresh-agent hook이 거부)의 판정을 기록한다(`record`). reviewer ID와 판정은 `harness-agent-event.mjs`가 stage execution의 `subagents.jsonl`과 history에 남기며 stage가 쓰지 않는다. 회차의 입력은 sealed `revision`과 manifest snapshot hash이므로 계약이나 source가 바뀌면 이전 통과는 stale이다. 반복 제한은 `review-attempts.mjs`가 소유한다: 5회차(`CONTRACT_REVIEW_ROUNDS`)를 넘거나 같은 blocker·major 지적이 연속 두 회차 남으면 `begin`을 거부하고 stage가 사용자에게 묻는다. `implement-wrapper` 완료 gate의 `contract_review`(`implementation-completion.mjs`)와 `sync-contracts` stage 반환 검증이 같은 history와 hook 로그를 다시 읽으며 `--state` 값은 쓰지 않는다. 검증: `tests/contract_review.test.mjs`, `tests/implement_wrapper_completion.test.mjs`.

문서에는 전체 Product 규칙과 DDD 구성요소별 상세를 보존한다. `.puml`의 모든 DDD 이름은 stable section으로 연결하고, renderer가 SVG에 원본 SHA를 붙인다. `seal`은 검토 사유와 변경 snapshot을 기록하고 revision을 올리며 `check`는 base보다 증가했는지 검사한다. source만 바뀌고 계약이 같으면 구체적인 영향 없음 근거를 요구한다. `architecture.html`은 같은 페이지 안에서 SVG 이름→상세 이동을 제공한다.

자동 검사가 증명하는 범위는 파일·형식·소유 관계·링크·버전·입력 정합성이다. 전체 기능 목록의 완전성, source_roots 축소의 타당성, DDD 규칙 캡슐화, 통신·분리 배포 결정의 근거와 실제 기능 회귀는 독립 reviewer와 실제 실행 evidence로 검증한다. receipt를 작성했다는 사실을 설계 승인이나 실제 제품 테스트 통과로 해석하지 않는다.

## implement-wrapper 최종 완료 gate

`.harness/src/workflow/completion.mjs`는 `implement-wrapper`의 `required_outcome`·`tests`·`review`·`retirement`·`evidence`를 `.harness/src/workflow/implementation-completion.mjs`가 정본 기록에서 도출한 verdict로 대체하고 `plan_review`에는 worktree 기록의 `plan_set_id`를 전달한다. `--state`의 같은 키(`DERIVED_STATE_KEYS`)는 버려지고 `ignored_state_keys`에 남는다. 모델이 쓴 boolean은 어떤 check도 통과시키지 못한다.

| check | 읽는 기록 | 통과 조건 |
|---|---|---|
| `review` | plan별 `runtime/reviews/implementation-<plan>-evidence.json`, `runtime/orchestrator/subagents.jsonl` | 계획 세트의 모든 plan에 `repair`가 기록한 `passed`가 있고, standards·spec 두 리뷰가 독립·fresh·서로 다른 context이며 같은 commit을 대상으로 하고, 그 reviewer를 subagent hook이 기록(fork 아님·종료)했고, commit이 HEAD 이력에 있으며 plan 본문 hash가 리뷰 당시와 같다. 실패 plan·역할은 `details.problems`에 남는다 |
| `contract_review` | `runtime/reviews/contracts-<plan-set>.json`, 그 reviewer가 속한 stage execution의 `subagents.jsonl`, `docs/contracts/manifest.json` | `contract_docs`가 통과한 sealed revision·snapshot과 마지막 통과 회차의 입력이 같고, 그 회차의 reviewer를 subagent hook이 `contract_reviewer`로, fork 없이, 같은 attempt로 시작·종료 기록했다. 기록이 없거나 revision이 낡았거나 hook 로그가 없으면 `contract_review_*`로 차단한다 |
| `tests` | `docs/agents/execution.json`의 `purpose: e2e` profile 중 `e2e` plan이 이름을 든 것, `runtime/execution/<profile>-<uuid>/receipt.json` | 각 profile의 마지막 verdict receipt가 통과이고 `head`가 HEAD 이력에 있으며 이후 문서 외 변경이 없고 실행 시 문서 외 미커밋 변경이 없고 `config_hashes` 파일이 같다. 실패 receipt가 있으면 `e2e_learning`은 `pending`으로 보고하며 판정을 바꾸지 않는다 |
| `required_outcome` | tracker의 plan별 canonical 상태(local-markdown은 plan frontmatter, GitHub는 Beads 매핑 뒤 Project 상태) | 모든 plan이 `completed`이고 위 `tests`가 통과다 |
| `retirement` | canonical plan의 `## 제거 대상`(또는 `## 승인된 제거 목록`) 절 불릿의 backtick 경로 | 승인된 경로가 workspace에 없다. 절이 없으면 승인된 제거 없음으로 `removed_paths: []`와 도출한 사유로 통과한다 |
| `evidence` | plan별 `runtime/plans/[<plan-set>/]<plan>/checkpoint.md`, 위 리뷰 evidence, 선택된 receipt와 step log | 모두 존재하고 checkpoint가 비어 있지 않다 |

파일 기반 기록이므로 session 디렉터리에 쓸 수 있는 주체의 직접 위조까지 막지는 못한다. gate가 막는 것은 `--state`로 통과 값을 주장하는 자기 증명이다. `tests/implement_wrapper_completion.test.mjs`가 설치형 consumer에서 통과·각 기록 누락 차단·직접 쓴 state 무시·Git 가시성·Doctor를 검사한다.

## orchestrator 메인 세션 쓰기 가드

orchestrator가 구현·계약 stage를 우회해 제품 코드, 테스트, `docs/contracts/`를 직접 고친 사례(E2E spec 두 번, 계약 한 번)를 안내문만으로 막지 못했다. PreToolUse hook이 집행한다: Codex는 `~/.codex/hooks.json`의 사용자 hook "Guarding Harness orchestrator writes"(`providers/codex.mjs`의 `codexWriteGuardHook`, `$setup`이 등록하고 `/hooks` 신뢰가 필요하며 Doctor `codex_write_guard_hook_untrusted`가 상태를 보고), Claude Code는 설치기가 `.claude/settings.local.json`의 `PreToolUse`에 등록하고 Doctor `claude_orchestrator_hook_missing`이 검사한다. 두 provider는 같은 `.codex/scripts/harness-write-guard.mjs`를 쓴다.

| 항목 | 규칙 |
|---|---|
| 적용 대상 | 활성 workflow worktree(`.io/worktree.json`의 `state: "active"`)의 메인 세션만. stage runner는 `HARNESS_SKILL_EXECUTION_ID`를 환경에 두므로 stage와 그 하위 agent는 제외되고, payload에 `agent_id`가 있으면(하위 agent) 제외된다. |
| 거부 | worktree 안이면서 `.io/**`와 `docs/agents/{implementation-guidance.md,testing-guidance.md,EXEC.md,execution.json}`·`docs/verification/e2e-lessons.md`가 아닌 경로에 대한 Codex `apply_patch`(patch 본문의 `Add/Update/Delete File`·`Move to`), Claude Code `Edit`·`Write`·`MultiEdit`·`NotebookEdit`, 두 provider의 `Bash` 명령 중 대상이 글자로 보이는 리다이렉션·`tee`·`sed -i`·`perl -i`·`cp`·`mv`·`install`·`ln`·`truncate`·`dd of=`·`touch`·`sh -c` 내부 스크립트 |
| 볼 수 없음 | 스크립트·인터프리터·포매터·`git apply`·`patch`가 내부에서 쓰는 파일, 변수·명령 치환으로 만든 대상, MCP 파일 도구. 차단은 우회 불가능한 경계가 아니라 안내를 집행하는 장치다 |

검증: `tests/orchestrator_write_guard.test.mjs`(판정·셸 파서·Codex 사용자 hook 필터·설치/갱신/Doctor), `tests/stage_context_runtime.test.mjs`(사용자 hook 등록과 신뢰).

## Tracker lifecycle와 mirror gate

`.harness/src/tracker/lifecycle.mjs`의 공통 코드가 신규 v1 mirror를 exact external_ref로 연결한다. GitHub project/field metadata는 한 번의 read/check/sync invocation 안에서만 resolve하며 해당 ref의 issue/item/status는 각 검증 시 다시 읽는다. 호출 간 캐시나 오류시 성공 fallback은 없다. `readTrackerStatus`는 mirror 없이 configured exact ref의 canonical 상태를 읽으며 incomplete pagination은 오류로 둔다. `syncTrackerStatus`는 canonical 상태 변경·재조회 후 Beads를 반영하고 재조회한다. phase/classification은 metadata로 분리한다. 부분 실패는 local journal에 남기며 canonical을 rollback하지 않는다. `inspectTrackerSync`는 mirror 일관성 gate다.

모든 workflow의 `tracker_sync`와 시작 workspace preflight, 실제 dispatch 전 검사, 실제 wrapper completion이 이를 호출한다. 중복/미연결 ref, 네 상태 밖의 값, metadata 누락, canonical/mirror 불일치는 실행·정상 완료·종속 plan 해제를 차단한다. 설치 runtime에도 같은 module/CLI가 배포된다. 기존 데이터는 이동·재분류하지 않고 새로 등록된 version1 mirror에 적용한다. GitHub 기본 Status와 Issue closure는 이 코드의 갱신 대상이 아니다.

## Workflow worktree 종료 gate

`.harness/src/workflow/worktrees.mjs`가 allocating 소유 receipt를 Git add 전에 기록하고 reserve/register/finish를 경로별 PID lock으로 직렬화한다. 일반 main checkout/비소유 linked worktree는 삭제하지 않는다. `completeWorkflow`의 outer finally는 preflight/manifest/검증/기록 실패도 처리한다. state JSON 파싱 오류와 CLI SIGINT/SIGTERM도 종료 경로로 연결한다. owned plan allocation 실패·실행/리뷰 오류·완료는 WorktreeManager의 같은 archiver를 사용한다.

미커밋·untracked·ignored 파일·staged index를 worktree 밖 영속 세션의 recovery/에 복사하고 hash/HEAD/index 일치를 확인한 후 제거한다. HEAD와 staged blobs를 별도 ref로 보호하므로 GC 이후에도 복구 근거를 유지한다. branch는 삭제하지 않는다. runtime journal·로그는 처음부터 같은 session_directory에 직접 기록하여 제거 후에도 경로를 유지한다. 제거 후 등록 해제와 receipt 상태를 확인하며, 삭제 후 receipt 실패도 다음 finish가 archive/ref를 검증하여 복구한다. 실패는 경로·복구 자료·재시도 원인을 반환하고 정상 완료가 아니다.

프로세스 강제 사망은 즉시 finally를 실행할 수 없다. 다음 시작의 pending receipt 확인과 중단된 writer 확인 후 finish 재시도로 처리한다. 다른 활성 실행, Git lock, 백업 실패는 강제로 우회하지 않는다. recovery의 민감 ignored 파일은 외부로 게시하지 않는다.

## 세션 출력 경계

`.harness/src/workflow/session-output.mjs`의 공통 resolver가 workspace별 Git common 세션 경로와 상대 출력 경로를 결정하고 이탈·symlink·공유 hardlink·특수 파일 대상을 거부한다. 재사용한 세션 root도 0700으로 제한한다. plan/completion/tracker/eval/external-port/knowledge/review/E2E manifest가 이를 호출한다. 완료 CLI의 --state 입력도 세션 상대 경로만 허용한다. agent/process의 TMPDIR/TMP/TEMP와 browser 출력 지정은 EXEC·skill·profile·dispatch 계약으로 적용한다. 외부 도구 전역 cache와 telemetry를 OS sandbox로 차단하지는 않는다. 최종 source·문서·registry와 Git/Beads 관리 metadata는 원래 경로를 유지한다.

## 실행 전제 누락

일반 단위·회귀 검증을 `harness-exec`에 감싸는 지침은 test profile과 런타임 환경 주입을 불필요하게 강제했다. 일반 검증은 EXEC에 기록한 기본 CLI로 직접 실행하고, `execution.json`은 명시적 사용자 흐름 E2E profile만 둔다. `.harness/src/workflow/execution.mjs`는 `purpose: "e2e"`가 아닌 profile 실행을 거부하지만, 기존 profile manifest의 readiness 검증은 그대로 허용한다. argv/env 검사→설정 prepare/verify→dependency readiness→설정 변경 재검증을 통과한 경우에만 E2E command를 spawn한다. 빈 profile 객체는 E2E가 없는 프로젝트를 뜻한다. `tests/execution.test.mjs`는 비 E2E profile 거부 및 E2E의 missing value, stale config, missing infra, config drift main 미실행을 확인한다. profile 요구의 충분성은 실제 entrypoint·config loader·infra·CI 리뷰 대상이다.

## Fresh Spec 적대적 리뷰

`spec-me`가 확정된 결정과 근거를 바탕으로 Product·Architecture Spec을 작성하고 수정한다. 완료 결과와 `to-ticket`·`tracker-publish` 입력 준비는 정본 worktree의 plan set에 대한 독립 Architecture 리뷰를 확인한다. 리뷰한 Product·Architecture Spec과 필수 입력의 hash가 바뀌면 다음 단계로 진행하지 않는다. 기계 검사는 실제 문서의 의미적 완전성을 보장하지 않으므로 독립 reviewer가 판단한다.

`spec-me`는 구현 수정으로 직접 라우팅하지 않는다. 수정 단계의 피드백은 해당 단계의 기존 provider/session과 결과를 연결해 전달하며, 살아 있는 stage에는 새 입력을 준비하지 않는다. 질문을 낸 실행의 `decision-answers.json`은 확정 답변이고 재개 실행의 `answers.json`은 전달 입력이다. 기존 답변이나 위임이 새 질문과 실제로 같은 조건인지는 `spec-me`가 확인하며, 기계적으로 의미가 비슷하다는 이유로 승인을 추정하지 않는다. 회귀 검사는 `tests/worktree_record_contract.test.mjs`의 설치 소비자 흐름에서 수행한다.

spec-me는 Product Spec coverage를 입력 gate로 확인하고, 완성된 Architecture Spec만 새 reviewer로 검토한다. reviewer는 Product/Architecture Spec 두 문서만 직접 읽으며 parent/writer 분석을 상속하지 않는다. 공통 [Architecture Spec 리뷰 기준](../../.codex/internal-skills/spec-review/references/review-criteria.md)에 따라 DDD 분류와 규칙 소유권, 비즈니스 로직 단위 테스트 명세, 기술 선택 근거의 연결, 요구 구현에 필요한 인프라 완전성을 평가한다. `.harness/src/workflow/spec-review.mjs`가 두 Spec의 입력 hash, reviewer ID/author 분리·fresh 옵션 기록, pass 판정과 미해결 중대 finding 부재를 검사한다. stage gate와 lifecycle spec_reviews가 같은 함수를 사용하며 completeWorkflow는 spec-me/to-ticket의 해당 hook 제거도 복원한다. `tests/spec_review.test.mjs`와 installed completion 검사가 Architecture review 누락·self author·상속·중대 지적·stale Spec/Product 및 hook 제거를 검사한다. hash는 실제 subagent 실행·읽기·의미적 판단을 증명하지 않는다. caller는 원본 tool/agent 결과를 보존·대조하며, 실제 fresh 리뷰를 부모 자기 검토로 대체하지 않는다.

## 설치/업데이트의 반복 수동 수리 방지

사용자 보고에서 force가 agent에만 적용되어 스킬을 손으로 교체했고, PR 템플릿 누락·stale lock·내부 eval profile의 native 미검증 오류가 남았다. install/update를 `updateProject`의 공통 native 자산 경로로 연결했다. 명시적 force만 관리 파일을 세션에 먼저 백업 후 교체하며, 기본 재설치는 기존 baseline으로 로컬 수정을 보존한다. PR 템플릿을 inventory에 포함하고 supporting files/tools/contracts/CI의 doctor inventory도 정합화했다. upstream에 없는 lock 항목은 원장만 정리하고 이전 파일은 보존한다. `eval.permission_profile`은 event label이고 실제 sandbox/network를 검사하며, 실제 native 참조만 inventory 증명을 요구한다. 검사 자체를 생략하거나 이름만 주어 미검증 권한을 승인하지 않는다. 설치·업데이트 및 doctor 회귀 검사는 EXEC의 installer-maintenance 계열 profile로 수행한다.

## 구현 전 프로젝트 준비

`inspectProjectReadiness`는 공유 실행 manifest validator와 실제 `inspectContracts`를 호출한다. install/update가 준비 부족과 다음 skill을 출력하고 doctor는 `project_preparation_required` 오류를 보고한다. `implement`는 `--for-implementation` preflight를 적용하며 실제 wrapper dispatch는 `project_readiness` lifecycle check를 강제하므로 agent의 pass 주장으로 우회하지 않는다. 기본 workspace 검사에는 준비 조건을 추가하지 않아 최초 setup/spec/계약 bootstrap 자체를 막지 않는다.

파일이 없을 때 caller는 setup의 source 조사와 sync-contracts를 수행하고 재검사한다. 기존 사용자 프로필·구현 commit·stash·tracker 상태를 보존한다. 형식 검사만으로 실제 검증 범위·모델의 의미를 증명하지 않으며 이 부분은 caller/독립 reviewer가 검토하고 실행 launcher가 실제 readiness를 검사한다.

## E2E 실패 학습과 이력 보존

반복 실패를 원인 확인 없이 다시 실행하던 흐름을 e2e-test의 failure-learning reference로 연결한다. runner는 증거/cleanup, caller는 원인 조사·실제 profile/readiness/회귀 검사 수정·재검증·프로젝트 e2e-lessons 갱신을 소유한다. 매 시도는 새 세션 하위 run 경로를 사용하며 다음 실행은 현행 lesson/예방 검사를 먼저 읽는다. 같은 원인의 반복 발생은 두 증거를 기준으로 correct를 적용한다. 미확정 원인을 영구 규칙으로 승격하지 않는다. E2E 실행은 E2E/full-stack/browser end-to-end 명시 요청 또는 cheaper checks로 입증할 수 없는 변경 critical cross-boundary 위험으로 제한하고, 일반 검증/서비스 실행 요청은 E2E 요청으로 해석하지 않는다. UI 변경만으로 full-stack 실행을 요구하지 않는다. Agent 응답은 승인 oracle과 trace를 기준으로 검증하며, 동적 prose를 고정하거나 runner가 test/source를 수정하지 않는다. 최초 시도와 진단 후 최대 한 번 재실행 budget을 handoff 간 공유한다. 이 policy는 manual review이며 자동 강제되지 않는다.

`mergeTests`는 ID별 e2e_failures를 누적하고 원본 증거를 보존한다. 현재 테스트 결과는 lifecycle tests gate와 wrapper 완료 판정이 확인한다. `e2eLearningComplete`는 학습 상태만 별도로 보고하며 과거 실패의 원인 분석·지침 갱신 미완료로 테스트 통과나 workflow 완료를 막지 않는다. `not_reusable`은 판단 근거만 기록한다. `tests/e2e_learning.test.mjs`와 e2e-learning-check 프로필은 성공 결과와 학습 pending의 공존, 실제 테스트 실패 차단 및 이력 보존을 검증한다. 원인과 예방 효과의 타당성은 증거 리뷰로 판단한다.

## 요구사항·계획·구현 추적

`.harness/src/workflow/plan-review.mjs`는 Product/Architecture Spec과 전체 canonical plan을 독립 리뷰가 직접 대조하도록 하며, session runtime에는 current-input hash만 저장한다. `to-ticket` 완료는 독립 `plan_reviewer`가 전체 canonical 계획을 읽은 현재 hash를 요구한다. wrapper dispatch는 workspace preflight 뒤 Spec·전체 계획·tracker body를 다시 읽고, 미통과 시 implementer spawn 전에 차단한다. completion은 구현/검증 파일 hash와 계획된 직접 실행 검증의 결과를 확인한다. feature-level E2E는 모든 split plan 통합 후 한 번 실행하며 `harness-exec` receipt를 남긴다. lifecycle completion도 현재 plan-review snapshot 검사를 재실행한다.

`tests/plan_review.test.mjs`와 `node --test` 직접 검증이 Spec·계획 snapshot, stale review, dispatch 차단을 검사한다. 자동 검사는 구조·현재성·receipt 형식을 증명하지만 Spec의 의미적 범위가 plan 전체에 빠짐없이 반영되었는지는 자동 검사로 증명하지 않으며 독립 reviewer가 판단한다. 독립 reviewer가 원문과 전체 계획에서 counterexample을 찾아 판단한다. Receipt 구조 검사는 작성 주체의 암호학적 신원을 증명하지 않는다.

구현 plan의 테스트 파일과 실행 방법은 해당 canonical plan의 테스트 계약에 보존한다. 독립 plan reviewer는 Product/Architecture Spec과 전체 plan을 직접 읽고 테스트 계약이 각 split plan의 업무 규칙 단위 테스트 및 통합 후 마지막 E2E 규칙을 따르는지 판단한다. 자동 plan-review gate는 Spec과 plan의 현재 snapshot만 확인하고 coverage inventory를 만들지 않는다. 설치 소비자 회귀는 `installer_update.test.mjs`에서 확인한다.

## Spring Boot Diagnostic Log Schema v1

사용자가 제공한 정규화 LogRecord 계약을 victorialogs-local-setup assets의 JSON Schema/Markdown으로 배포한다. validateDiagnosticLog와 helper validate-logs는 일곱 이벤트의 필수 Resource/Attributes·typed 값·outcome·timestamp·Trace/Span을 원본 JSON/JSONL에서 검사한다. 설치 helper는 활성 workspace의 구현/테스트 메모리와 offline profile을 연결한다. diagnostic-log-check 및 installer-maintenance-python profile은 올바른 이벤트와 누락·타입·outcome 오류, 설치 후 profile 실행·중복 없는 지침 갱신·collector 보완을 검사한다. generic Logstash/OTLP wire format·저장 후 string 표현은 구분한다. 실제 context 유무·async 전파·MDC 정리·monotonic duration·redaction과 수집 의미는 emitter 관련 집중 검증/리뷰 범위이며 형식 검사로 자동 증명한다고 주장하지 않는다.

구현 리뷰의 반복 제한은 `reserveImplementationRepair`가 공통 review-attempt 원장에 원본 저장소·plan별로 예약한다. wrapper runtime과 `harness-code-review.mjs repair`가 같은 검증을 사용한다. checkpoint는 원래 review_fixed_point를 유지하며 fresh reviewer context 재사용을 거부한다. 한도 reset은 기존 예약의 planning snapshot과 다른 새 snapshot이 독립 계획 리뷰·dispatch를 통과할 때만 허용한다. 세션 `01a170ef-39f1-7250-99d1-29efa09e08c8`의 #370에서는 수정 예약이 9회, reset이 8회 기록됐고, 한 reset 사유는 사용자의 일반 진행 지시 `계속 해`였다. 이 사례는 사용자 결정의 진위를 수동 확인하는 문구만으로 반복 제한이 구조적으로 보장되지 않음을 보여준다. `implementation-review-check`는 동일 snapshot reset 거부, 승인된 snapshot 변경 뒤 재개, 재개·worktree 교체, 설치/갱신 소비자의 동작과 Git 가시성을 검사한다. `canonical_plan` metadata로 실제 정본과 가상 hash 키를 구분한다. 중간 plan 완료는 snapshot drift만 deferred로, 최종 feature 완료는 실제 계약 pass로 검사한다. 규칙의 전 경로 보완과 commit/검토 입력의 의미상 일치는 reviewer/caller의 검토 계약이다.

세션 `01a1682e-92be-7642-94d2-e4ce85d070e5`의 후반부는 raw/canonical hash 혼동과 예약→경쟁 저장→기회 공격→복구 경로의 순차 보완을 보였다. `validateCanonicalPlanReference`는 reviewer 생성 전에 정본 참조·digest·정규화 metadata를 검사하고 plan-review snapshot은 Spec 및 canonical plan 변경을 판정한다. Spec begin target은 admission과 호출 대상의 수동 복사를 줄인다. 설계 blocker의 `next_action:spec-me`와 재개 조건은 repair 예약 없이 checkpoint까지 전달된다. `implementation-review-check`가 spawn 이전 거부·상태만 바뀐 hash 유지/업무 내용 변경 탐지·예약 없이 설계 인계·설치 소비자 배포를 검사한다. 전이 표의 모든 경로가 실제로 충분한지, finding이 설계 변경인지, 수동 caller가 target을 지키는지는 작성자·reviewer의 의미 검토 범위다. 전체 latency/token 개선은 동일 workload의 비교 실행 전까지 미측정이다.

리뷰 승인 요청의 연쇄 대기는 `harness-review-status`가 기존 scope별 기록·pending·한도를 읽어 caller의 통합 질문을 지원한다. create:false 경로 조회는 mkdir/chmod 없이 같은 경로 안전성을 적용하고, 손상된 원장은 성공/미실행으로 숨기지 않는다. 실행 중인 모든 reviewer의 결과 수집은 기존 Promise.all로 유지한다. planning 입력의 정렬 hash fingerprint를 reviewer 입력에 고정하고 생성·repair 예약·완료에서 비교해, 다른 snapshot이 새로 승인돼도 옛 리뷰로 진행하지 못한다. `implementation-review-check`는 통합 조회 무변경·linked root·부분 손상·resolve 반영·양쪽 결과 대기·재승인 snapshot 차단·설치/갱신 배포를 검사한다. 실제 사용자 질문의 묶음·승인 범위와 활성 입력 편집 중단은 공통 리뷰 조정 문서의 수동 계약이다.
