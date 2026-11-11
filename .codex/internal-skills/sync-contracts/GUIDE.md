---
model_tier: implementation
---
<!-- 내부 workflow 전용. 사용자 공개 스킬로 등록하지 않는다. -->

# sync-contracts

설치된 **대상 프로젝트**의 현행 계약은 `docs/contracts/product.md` 한 장과 `architecture.md` 한 장이다. ticket Spec은 변경 제안·승인 근거다. 다음 `spec-me`는 통합 계약·`CONTEXT.md`·`CONTEXT-MAP.md`와 실제 코드를 먼저 읽는다. manifest는 기능·구성요소·소유 관계·diagram·source_roots를 읽고, 대량 hash 비교는 CLI에 맡긴다. 하네스 자체의 모델을 대상 프로젝트에 복사하지 않는다.

## 갱신

1. 초기 도입은 기존 구현·테스트·기존 Spec을 조사해 전체 기능과 모델을 통합한다. 모르는 영역은 명시하고 완료로 위장하지 않는다. [형식 계약](references/format.md)을 따른다.
2. Product 단계는 기능·규칙·수용 조건을, Architecture 단계는 책임·불변식·통신·배포·메서드를 갱신한다. 기존 `implemented` 설명을 지우고 미래 설계로 덮지 않는다. `accepted-target`은 승인 근거와 적용 조건을 따로 적고, 구현 후 확인한 부분만 `implemented`로 전환한다.
3. 기존 owner 확장을 우선 검토한다. 기능 하나 때문에 Aggregate·VO·서버를 만들지 않는다. 모델의 의미가 바뀌면 사용자가 rename을 요청하지 않아도 언어 불일치를 조사해 현행 용어와 문서·코드·다이어그램을 함께 정리한다. 불명확한 의미는 질문하고 정상 완료하지 않는다.
4. 바뀐 규칙을 소유한 객체/함수와 실제 호출 경로를 대조한다. Aggregate 외부 규칙 누수·공개 setter 우회·불필요한 추상화·구형 경로 잔존을 독립 reviewer가 확인한다. 삭제한 기능은 `retired`와 대체 경로를 남기고, 역사 Spec을 현재 계약으로 재사용하지 않는다.
5. `plantuml-diagrams`의 `diagram_creator`로 전체 DDD 구조·클래스·기능별 sequence·상태 관점을 갱신한다. 원본과 SVG를 함께 보존한다. DDD 구조에는 이름만 두고 모든 이름을 해당 architecture section에 링크한다. 설명·속성·타입·규칙은 문서와 class diagram에 둔다. 적용할 상태/클래스가 없으면 manifest에 구체적 이유를 기록하며 형식적인 모델을 만들지 않는다.
6. 기능 ID → 규칙 → 모델/메서드 → source → 검증 근거를 연결한다. 영향 있는 성능 목표는 동일 workload·단위·환경·오류율로 before/after를 비교한다. 실행하지 않은 증거를 통과로 쓰지 않는다. `maintain-verification`은 이 통합 Product 계약을 기준으로 구현 drift를 조사하고, 회귀를 계약 수정으로 숨기지 않는다.
7. `sync-contracts`는 전체 feature 구현이 완료되고 변경 branch에 모든 plan이 통합된 최종 workflow에서만 실행한다. `spec-me`, `to-ticket`, 개별 plan 구현·리뷰, knowledge 작업은 공통 계약을 수정하거나 seal하지 않는다. 최종 구현 workflow는 독립 code review·검증·계약 영향 검토 후 `node .codex/scripts/harness-contracts.mjs seal --root <workspace_root> --summary '<검토한 변경>'`을 실행한다. 실제 구현이 바뀌어도 계약이 그대로인 경우에만 `--no-contract-change '<영향 없음의 근거와 확인 범위>'`를 추가한다. 단순 gate 통과용 사유는 허용하지 않는다. 계약/모델/다이어그램 변경은 `revision`을 증가시키며 Git이 이전 버전을 보존한다. 동일 입력의 seal은 버전을 올리지 않는다.
8. 최종 구현 workflow 시작 시 `git rev-parse HEAD`로 시작 commit SHA를 보존하고, 아래 공통 완료 명령을 실행한다. 이 명령이 실제 `before_complete` hook을 호출하고 pass/fail receipt를 local journal에 기록한다. `contract_docs`는 최종 `implement-wrapper` 또는 완결된 단일 구현 workflow에만 적용한다. `spec-me`와 `to-ticket`은 ticket_id와 현행 fresh `spec_reviews`를 포함하되 `contract_docs`를 요구하지 않는다. 계약 seal이 독립 리뷰나 다른 완료 gate를 대체하지 않는다.

   `node .codex/scripts/harness-workflow-complete.mjs --root <workspace_root> --workflow <workflow-id> --worktree-id <worktree.json의 worktree_id> --base-ref <시작 commit SHA>`

   worktree 안에서 실행할 때는 `--worktree-id`에 `<session_directory>/worktree.json`의 `worktree_id`를 반드시 넘긴다. 값이 없거나 다르면 완료 gate가 `Canonical worktree ownership mismatch`로 실패한다.

   pass 전에는 완료 선언·tracker Done·종속 plan 해제를 하지 않는다. `state=completed`는 `completion_kind`가 말하는 산출물만 완료한다: Spec 검토 완료는 `spec_ready_for_planning`, 계획 발행 완료는 `plan_set_ready_for_implementation`, 개별 plan 완료는 `plan_implemented`, 모든 구현을 통합한 완료는 `feature_implemented`다. 기능 계약 갱신은 마지막 종류에서만 수행한다. 실패는 변경 파일/원인과 복구 행동을 남긴다. 완료 조건에 계약 반영과 독립 의미 검토를 포함한다. 사용자 결정/외부 조건 대기는 `waiting`으로 세션을 유지하며, handoff·취소·실패는 각각 `handoff`·`aborted`·`failed`로 기록한다. 이들은 정상 완료가 아니다.

## Stage로 실행

최종 E2E가 통과하면 orchestrator가 이 skill을 독립 stage로 시작한다. 이 stage만 `docs/contracts/`를 쓴다.

1. Product·Architecture Spec, 계획, 실제 source와 테스트·E2E 증거를 읽고 위 갱신 절차대로 `product.md`, `architecture.md`, `manifest.json`, `diagrams/`를 작성한다.
2. `node .codex/scripts/harness-contracts.mjs check --root <workspace_root>`를 실행한다. 결과의 `content_violations`를 **한 번에 모두** 고친다. 메시지에 적힌 manifest 항목 형식을 그대로 쓴다. revision·날짜·요약·snapshot·`architecture.html`은 seal이 쓰므로 손으로 고치지 않는다.
3. `content_violations`가 비면 `node .codex/scripts/harness-contracts.mjs seal --root <workspace_root> --summary '<바뀐 내용>'`을 실행하고 `check`가 `pass`인지 확인한다.
4. 제품 코드·테스트·Spec·계획은 바꾸지 않는다. 계약을 source와 맞출 수 없는 코드 결함을 찾으면 `IMPLEMENTATION_REVISION_REQUIRED`로 근거와 함께 반환한다.
5. 같은 위반이 두 번 고친 뒤에도 남으면 더 반복하지 않고 남은 위반과 시도한 수정을 `blocked/INPUT_MISSING`으로 반환한다.
6. `check`가 pass이면 바뀐 계약 파일을 artifacts로 `completed/OK`를 반환한다. orchestrator가 이어서 완료 gate를 실행한다.

## 자동 검사와 의미 검토

`contract_docs` hook과 GitHub Actions는 누락·변경 snapshot·버전·날짜·소유 링크·필수 설명 필드·기능별 diagram·SVG 재생성을 검사한다. 자동 검사는 규칙의 정확성이나 완전한 기능 목록을 증명하지 않는다. reviewer는 source diff와 전체 계약의 영향 섹션을 읽고 변경 누락·동작 회귀·잘못된 DDD 경계를 별도로 판단한다.

`architecture.html`은 자동 생성한다. 로컬 브라우저에서 DDD 이름을 누르면 같은 페이지의 상세 섹션으로 이동한다. GitHub Markdown에는 SVG와 상세 문서 링크를 함께 둔다. GitHub 이미지 렌더링의 링크 동작을 가정하지 않는다.

신규 tracker mirror가 있는 프로젝트는 workflow 시작 시 workspace preflight를 실행하고, 종료 공통 명령의 `tracker_sync`도 통과해야 한다. 동기화 검사 실패를 문서 seal로 해결할 수 없다. `beads` 스킬의 공통 sync를 재시도하고 실제 canonical 상태와 mirror를 재확인한다.

## 소유 worktree

상위 workflow가 전달한 worktree를 그대로 쓰고 소유권·종료를 다루지 않는다. 직접 소유한 실행이면 [session-worktree](../../../.codex/internal-skills/session-worktree/GUIDE.md)를 따른다.

## 실행 산출물 경로

실행 중 생기는 로그·임시 파일·스크린샷은 [실행 산출물 경로](../../../.codex/internal-skills/skill-execution/references/runtime-artifact-paths.md)를 따른다.
