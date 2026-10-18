# Luna workflow 제어 검증

모델: 모든 구현 후보·독립 리뷰·테스트 실행 agent는 `gpt-6-luna`, reasoning effort `medium`. 작은 임시 Node.js 프로젝트로 검사했고 repository에 별도 테스트 framework나 큰 fixture를 추가하지 않았다. 실제 전체 spec-me/tracker/E2E 실행이나 blind A/B 성능 실험은 아니다.

## 검사와 관측 결과

| 검사 | 관측 결과 |
|---|---|
| 폐기 명칭과 historical 자료 | `Booking → Reservation`의 승인 기록과 옛 Spec을 함께 제공. 초기 후보는 구형 wrapper/이름을 남겨 실패했다. 독립 리뷰가 이를 지적했고 수정 후 현행 source/사용 안내는 canonical term을 사용했다. historical Spec과 외부 JSON `bookingId` 예외는 보존했다. |
| 작은 기능의 DDD 경계 | 선택적 취소 사유는 기존 `cancelReservation`에서 처리했고 새 source module/context/server는 추가하지 않았다. shipped 상태 거부와 입력 불변성도 확인했다. |
| 구형 구현 정리 | 최초·fresh 후보 모두 기능 검사에는 통과했지만 정리/증거 조건에서 실패했다. 승인된 제거 목록을 실제 파일로 검사하는 `retirement` hook은 남은 wrapper를 `retired_path_still_present`로 차단하고, 제거 후 `retired_paths_absent`로 통과했다. |
| 실제 completion 통합 | 테스트·독립 리뷰가 passed여도 제거 경로가 남으면 completion은 `in-progress`, tracker 요청은 `In Progress`, dependent는 대기했다. 제거 후 완료 및 dependent 준비를 허용했다. |
| 규칙 유출·병렬 구현 리뷰 | 별도 불량 diff의 미연결 신규 helper, shipped guard 우회, 폐기어 재도입, 누락된 추적/모델 갱신을 Spec reviewer가 blocker로 지적했다. |
| 성능 주장 | 오류 50/100이 섞인 단회 40→30ms 비교를 개선 증거로 인정하지 않았다. 정상 예제에는 성능 목표가 없어 측정 `해당 없음`으로 기록했으며 수치를 만들지 않았다. |
| 추적성과 재개 | 최종 예제에 UC-1/BR-1 → owner/source/검증과 모델 disposition을 기록했다. checkpoint는 traceability/measurements를 보존하지만 과거 `passed:true`가 최신 `status:failed`에 남지 않음을 검증했다. |

## 최종 확인

- 수정 후 독립 oracle: 사유 전달(domain+CLI), 사유 없는 응답 호환, shipped 거부, 입력 불변, bookingId 보존 등 다섯 동작 assertion 통과. 구형 파일/현재 참조 정리·historical 보존·UC/BR 증거도 통과했다.
- 최종 Standards와 Spec reviewer는 각각 source 관점의 blocker 없음으로 판정했다. reviewer의 source 검토와 테스트 실행 agent의 실제 실행 결과를 구분했다.
- 예제의 source 변화는 3개 파일에 5줄 추가/5줄 삭제이며 wrapper 삭제를 포함한다. 새 source module은 0개다. 전체 산출물은 Spec·계획·검증 기록을 포함해 11개 파일, 37줄 추가/8줄 삭제다. 코드량은 관측값이며 품질 판정 기준을 대신하지 않는다.
- 관련 회귀 검사 82개 중 81개 통과. 마지막 checkpoint 수정 후 관련 46개를 재검사해 45개 통과했다. 두 실행의 유일한 실패는 기존 model-binding 검사의 고정된 `gpt-5.6-luna` 기대값과 현재 `gpt-6-luna` 설정 불일치이며 기존 `harness-lqp` 범위다.
- 변경 스킬 16개 형식 검증, Markdown 상대 링크, agent TOML, `git diff --check`를 확인했다.

## 재현 위치와 한계

최종 임시 프로젝트: `/tmp/reservation-console-3pz7_7gc`. 초기 실패 결과: `/tmp/reservation-console-verdict.json`, 제거 전 gate 결과: `/tmp/reservation-console-retirement-gate.json`, 최종 독립 결과: `/tmp/reservation-console-final-verdict.json`. 경로는 로컬 임시 증거이며 배포/장기 보관을 의미하지 않는다.

`retirement`는 승인된 제거 목록의 실제 부재를 확인한다. 목록에 없는 dead code를 자동 추론하거나 용어의 업무 의미를 판정하지 않는다. wrapper workflow의 완료 hook은 disposition을 요구하고, 직접 `executeImplementPlan` API에서는 전달한 `retirement` 옵션을 검사한다. 옵션을 생략한 legacy 직접 API 호출에는 해당 보장을 주장하지 않는다. 현행 glossary에 기록되지 않은 폐기어는 추측하지 않으며 승인된 대체 관계의 기록이 필요하다.

두 초기 후보의 실패를 숨기지 않았다. 이번 결과는 제한된 예제에서 리뷰·수정·실제 완료 검사가 작동한다는 근거이며, 모든 프로젝트에서 첫 시도부터 같은 결과를 보장하거나 품질 향상의 통계적 근거가 되지는 않는다.

## 명시적 rename 요청 없는 설계 검증

후속 수정에서 Product/Architecture 설계와 인터뷰가 기존 정의를 새 모델의 의미·책임·identity·lifecycle에 대조하도록 연결했다. 같은 의미의 보정은 직접 반영하고, 의미 선택이 필요한 변경은 관련 설계 topic에서 권장안과 함께 해결한다. 모델이 확정한 명칭 변경에 별도의 rename 요청을 요구하지 않는다.

`gpt-6-luna / medium` 설계 agent와 별도의 같은 모델 검증 agent가 소비자 `.agents/skills` 형태의 작은 문서 프로젝트 세 개를 확인했다. 입력에는 rename 요청이나 기존 폐기 기록이 없었다.

| 사례 | 관측 |
|---|---|
| 결제 완료만 뜻하던 Order가 같은 orderId의 draft→paid lifecycle로 확장 | 같은 이름의 정의를 실제 CONTEXT.md에서 보정했다. 별도 draft 모델/service는 추가하지 않았다. 용어 검증 통과; 취소 조건의 세부 결정은 별도로 미해결이다. |
| Subscription이 정기 계약과 독립 이용 권한을 혼합 | Billing Subscription과 Access Grant로 의미를 분리하고 실제 glossary/context map을 갱신했다. 최초 결과는 옛 혼합 의미의 폐기 이력을 누락해 실패했다. 지침 보완과 제한된 수정 후 scoped 대체 기록까지 통과했다. 현재 Billing 명칭은 유지했고 통신 결정은 미해결로 남겼다. |
| active가 유료 멤버인지 로그인 가능 계정인지 미정 | 임의로 glossary/대상 조건을 변경하지 않고 무료 계정 포함 여부를 묻는 업무 질문으로 남겼다. 불확실성 처리 검증 통과이며 설계 완료 판정은 아니다. |

변경 스킬 6개 형식·상대 링크, writer TOML 및 실제 spec-me workflow의 domain-modeling 참조 로딩을 확인했다. 실행 코드나 새 테스트 framework는 추가하지 않았다. 초기 결과 `/tmp/proactive-language-verdict.json`, 수정 후 `/tmp/proactive-language-final-verdict.json`, 문서 예제 `/tmp/commerce-notes-cmtfjkqm`에 로컬 근거가 있다. 실제 설치 프로젝트의 전체 spec-me 흐름이나 모든 도메인의 의미 감지를 입증한 것은 아니다.

## 통합 Product·DDD 계약과 정상 완료 gate (2026-10-16)

실행/독립 검토 모델: 사용자 지정 `gpt-6-luna`, reasoning `medium`. 테스트는 작은 Git consumer fixture와 기존 dispatch fixture를 재사용했다. 별도 제품 서버·DB·broker를 추가하지 않았다.

- 계약 형식의 10종 구성요소(외부 시스템·Context·Aggregate·root·entity·VO·domain/composition service/method)를 fixture에 포함했다. 초기 seal, Git HEAD 없는 초기 저장소, HTML 최초 생성, 변경 없는 재검증, source drift, 영향 없음의 검토 사유, 누락 필드/child 링크/sequence, stale SVG, 낮은 revision, 잘못된 경로·owner cycle·실행 SVG 거부를 확인했다.
- 실제 공통 완료 CLI에서 pass→completed와 journal 기록, stale source→in-progress/비정상 종료, 시작 SHA 누락·cwd 불일치 차단, manifest에서 contract_docs를 제거해도 검사 강제 적용을 확인했다.
- 실제 `updateProject`로 consumer에 runtime·독립 CI checker·workflow를 설치했다. 설치된 완료 CLI의 spec-me hook 실행과 workspace preflight import를 확인했다. 절대 경로·상위 경로·symlink state 파일은 거부했다. 기존 사용자 수정 workflow는 보존됐다.
- 실제 `executeImplementPlan` 경로에서 계약 누락이 완료와 종속 plan 해제를 차단하고, 유효한 계약 bundle이 있는 완료 경로는 통과함을 확인했다. 독립 reviewer 결과 등 기존 외부 경계는 기존 테스트 fixture를 사용했으며 live Codex/GitHub 실행으로 해석하지 않는다.

집중 Node 검사: `contracts`, `installer_update`, `lifecycle_gates`, `wrapper_reconciliation`, `workspace_preflight`, `workflow_loader` **54/54 통과**. dispatch의 계약 누락/정상 완료 시나리오 **2/2 통과**. 새 계약 테스트와 공용 fixture는 약 230줄 이내로 유지했고 제품별 대형 샘플 구현은 만들지 않았다.

독립 Luna 리뷰에서 YAML hook 선언만 있고 실행 경로가 없는 문제와 시작 SHA 누락을 발견하여 공통 완료 명령·실제 hook 실행·receipt 보존으로 수정했다. 이어 설치 runtime의 source-relative import 오류를 발견하여 plans-index와 workspace inspector의 구현을 `src`로 옮기고 portable script bridge로 연결했다. 완료 state 파일의 경로 검증도 추가했다.

실제 서버 기반 전체 E2E와 GitHub hosted Actions는 실행하지 않았다. 위 검사는 계약의 구조적 정합성과 완료 제어를 검증하며 DDD 의미 정확성이나 기존 전체 제품 기능의 live 회귀 부재를 증명하지 않는다. 기존 전체 suite의 선행 실패는 앞 절과 Beads `harness-lqp`에 기록된 범위 그대로 별도 추적한다.

추가 확인: 로컬 PlantUML 도구 테스트 **6/6 통과**, `sync-contracts` 형식 validator 통과. 브라우저의 실제 클릭 검사에서 메서드 링크 성공과 Context package 링크 누락을 발견했다. package URL 문법으로 수정하고 SVG의 실제 anchor 26/26을 확인했다. 자동 검사도 단순 URL 텍스트 대신 `<a href>` 존재를 확인하도록 강화하고 회귀 fixture를 추가했다. domain-service에도 entity와 같은 속성·타입·설명(무상태인 경우 명시)을 요구하고 owner 문서가 하위 메서드 section을 연결하도록 보완했다.

수정 후 실제 Chromium에서 DDD 이름 `completeWorkflow`와 `harness/control-plane`을 클릭하여 각각 `#complete-workflow-method`, `#control-plane`으로 이동하고 해당 상세 section이 표시됨을 확인했다. 로그·screenshot은 `/tmp/canonical-check/`에 보존하고 소유 browser/static server를 종료했다. 이 브라우저 검사는 static 문서 탐색 검증이며 제품 서버 E2E가 아니다.

정상 완료 검토 범위에는 production source뿐 아니라 `docs/specs/`와 `docs/plans/`도 포함했다. ticket Spec/plan만 바뀌는 설계 workflow도 통합 계약 검토 없이 통과할 수 없으며, `docs/plans/.runtime/`의 checkpoint·완료 receipt는 snapshot feedback을 막기 위해 제외한다.

## Tracker lifecycle와 Beads mirror 통일 (2026-10-16)

사용자 요청에 따라 기존 데이터 이전은 제외했다. 신규 tracker mirror의 네 lifecycle 상태만 공통 코드로 갱신하고 `backlog` 분류와 `test/review` 단계를 metadata로 분리했다. 이 저장소의 `status.custom`은 명시적으로 빈 값으로 설정한 뒤 `bd statuses --json`에 custom 목록이 없는 것을 확인했다. Beads 내장 보조 상태는 도구 기능으로 남는다.

`gpt-6-luna` reasoning `medium`이 격리 fixture와 fake gh/bd runner로 공통 동기화를 검증했다. canonical 갱신·재조회→Beads 반영·재조회, 중복/없는 exact ref의 변경 전 차단, configured Workflow Status만 갱신, Issue closure와 기본 Status 비변경, phase/classification 분리, active backlog/metadata 누락/closed Issue의 미완료 상태 거부, 실패 후 canonical 비rollback과 status 생략 재시도를 확인했다. local ticket은 frontmatter만 변경하고 본문을 보존한다.

실제 lifecycle 시작/종료 hook과 실제 wrapper pre-spawn 경계는 isolated fake bd executable로 불일치 시 차단되는 것을 확인했다. Git linked worktree에서 main worktree의 공유 Beads 발견, 설치된 consumer의 새 module/CLI 배포·import, 기존 공통 완료 명령 호환도 검사했다. 실제 GitHub/Beads 업무 Issue의 상태는 테스트로 변경하지 않았다.

집중 실행 `tracker_lifecycle`, `lifecycle_gates`, `contracts`, `wrapper_dispatch`, `installer_update`, `workflow_loader`, `tracker_contract`: **85개 중 84개 통과**. 유일 실패는 기존 `wrapper_dispatch`의 `gpt-5.6-luna` 기대값과 실제 `gpt-6-luna` 설정 불일치이며 앞서 `harness-lqp`에 기록한 실패와 같다. 테스트를 통과시키기 위해 모델 설정을 변경하지 않았다.

독립 Luna 리뷰가 필수 metadata·닫힌 Issue의 미완료 상태·local ticket 원자적 교체를 지적하여 수정했고 재검토에서 추가 blocker는 없었다. journal에 시도·결과를 남기고 mirror 반영 후 canonical을 다시 읽어 동시 변경도 오류로 반환한다. 실제 bd CLI의 `--set-metadata key=1`이 숫자 타입으로 저장되는 것은 소유한 작업의 임시 metadata key로 확인 후 제거했다.

외부 GitHub 상태 변경과 hosted Actions, 전체 suite는 이번 범위에서 실행하지 않았다. GitHub 보드 view는 setup에서 Workflow Status group/filter와 기본 Status 숨김을 안내하며 기존 보드를 재작성하지 않는다.

## Workflow 중단·완료 worktree 정리 (2026-10-17)

검증 모델은 사용자 지정 `gpt-6-luna`, reasoning `medium`이다. 실제 Git 저장소와 linked worktree를 작은 임시 fixture에 생성했다. 기존 사용자 worktree나 source checkout은 테스트로 삭제하지 않았다.

- completed/aborted/failed/handoff별 소유 tree 삭제와 tracked/untracked/ignored/runtime/index 백업을 확인했다. 동일 finish 재시도, primary/비소유 linked tree 보호, branch 변경 시 삭제 거부, 외부 symlink 비역참조, 잠금 실패 후 unlock·재시도를 확인했다.
- staged blob과 working 파일을 다르게 만든 뒤 snapshot/ref를 확인하고 임시 repository에서만 `git gc --prune=now`를 실행하여 staged object가 살아 있음을 확인했다.
- CLI create의 새 branch/기존 branch 재사용, 이미 checkout된 branch allocation 실패 후 정리, 경쟁 reservation에서 단일 소유자 유지, actual completeWorkflow의 preflight 전 오류/AbortSignal과 CLI state JSON 파싱 오류가 정리 경로로 연결되는 것을 확인했다.
- WorktreeManager의 dirty/missing-evidence owned tree는 검증된 archive 후 삭제되도록 이전 보존 기대값을 수정했다. unowned sequential execution_line은 임의 reset/삭제하지 않는 기존 보호를 유지한다. 부모 workflow가 자기 소유 session을 종료할 때만 정리한다.
- 설치된 consumer runtime에 worktree module과 CLI가 배포·resolve되는 것을 확인했다. source/consumer 경로가 같다고 가정하지 않는다.

집중 검사: worktree lifecycle **14/14**, owned manager cleanup **2/2**, installer **12/12** 통과. 기존 공유 경로까지 확장한 `eval_contract`, workspace/loader/lifecycle/contracts/installer/worktree/wrapper 검사: **153개 중 152개 통과**. 유일 실패는 기존 wrapper_dispatch 모델 기대값 `gpt-5.6-luna`와 실제 `gpt-6-luna`의 불일치이며 `harness-lqp`에 기록된 선행 실패다. 로그: `/tmp/harness-worktree-final-check.txt`.

독립 Luna 리뷰가 Git remove 성공 후 receipt 기록 오류의 재시도 불가, add 이후 소유권 공백, staged object GC, 중복 allocation race를 발견하여 각각 absent-path 검증 복구·add 전 reservation·staged tree 보호 ref·reserve/register/finish 공통 경로 lock으로 수정했다. 최종 재검토에서 추가 blocker는 없었다.

root preflight와 계약 revision 8 검사는 통과했고 pending 소유 receipt 목록은 비어 있었다. 기존 stale/prunable Git worktree 등록은 이번 작업이 만든 소유 증거가 없으므로 건드리지 않았다. SIGINT/SIGTERM은 CLI/AbortSignal 경로로 다루며 SIGKILL/전원 종료 시 즉시 finally 실행을 보장하지 않는다. 다음 진입에 receipt를 확인하고 중단된 writer를 확인한 후 finish를 재시도한다. archive 공간/특수 파일/Git lock 실패도 성공으로 위장하지 않는다.

최종 정상 종료 확인: primary root에서 실제 spec-me 완료 명령은 tracker_sync/contract_docs pass와 completed를 반환하되 cleanup은 not-owned로 root를 보존했다. 별도 sealed fixture의 소유 linked worktree에서도 실제 completeWorkflow gate 통과 후 제거됨을 확인했다. 추가한 정상 종료 integration을 포함한 worktree 검사 14/14가 통과했다. broad 153개 결과는 이 test-only 추가 이전 실행 결과다.
