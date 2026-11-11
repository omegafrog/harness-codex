# 스킬·지침·가이드 프롬프트 축소 계획

작성일: 2026-11-08. 조사 기준: Harness source `176b7c3e`(origin/main 병합 직후).

이 문서는 Harness 소스 저장소 자체 변경 계획이다. AGENTS.md의 "Harness source changes" 규칙에 따라 orchestrator·workflow·worktree 절차를 실행하지 않고 현재 workspace에서 직접 수정·검증한다. 구현 범위는 사용자가 이 계획을 확인한 뒤 확정한다.

## 1. 목표

- 각 실행이 실제로 읽는 지침의 양을 줄인다. 저장소 전체 크기보다 **한 실행의 로드 양**을 우선 지표로 둔다.
- 같은 규칙을 한 곳(정본)에만 두고 나머지는 필요한 경우 링크 한 줄로 대체한다.
- 복사된 보일러플레이트가 만든 **잘못된 지시와 상호 충돌**을 제거한다.
- 동작·gate·승인·독립 리뷰 요구는 약화하지 않는다. 런타임 코드가 강제하는 규칙은 설명만 줄이고 강제는 유지한다.

비목표: 스킬 공개 범위 변경, 런타임 로직 변경, Spec/계획 template의 항목 축소(`architecture-spec/references/template.md` 등 산출물 형식 정의는 대상 밖).

## 2. 기준 측정 (176b7c3e)

대상: `AGENTS.md`, `.codex/agents/*.toml`, `.codex/skills/**`, `.codex/internal-skills/**`, `.codex/workflows/*` 중 `.md|.toml|.yaml` (victorialogs `assets/` 제외).

| 지표 | 값 |
|---|---:|
| 대상 전체 | 581,239 B |
| 완전 동일 문장(50자 이상) 중복 | 73종, 약 26 KB |
| 복사형 보일러플레이트 | 약 38 KB |
| `implement` 실행의 본문 + 직접 링크 문서 | 23 KB + 71 KB (12개) |
| `code-review` 실행의 본문 + 직접 링크 문서 | 20 KB + 49 KB (10개) |
| `frontend-design` 실행의 본문 + 직접 링크 문서 | 18 KB + 62 KB (7개) |

보일러플레이트 내역:

| 항목 | 위치 수 | 크기 |
|---|---:|---:|
| `## 실행 모델과 반환`의 model_tier 설명 | 33 | 12.8 KB |
| agent toml 세션 출력 단락 (`Require the caller-supplied session_directory …`) | 17 | 8.7 KB |
| `## 세션 출력` | 9 | 4.2 KB |
| `## 테스트·서비스 실행 전제` | 7 | 4.1 KB |
| `내부 절차를 호출할 때 공개 스킬 검색 대신 …` 링크 줄 | 16 | 3.8 KB |
| `## 소유 worktree 종료` | 6 | 2.5 KB |
| `## 통합 계약 연속성` | 7 | 2.3 KB |

## 3. 정본 배치 원칙

1. **런타임이 결정하는 값은 지침에 다시 쓰지 않는다.** model tier·model·effort는 각 skill 문서 frontmatter의 `model_tier`와 `harness-skill-execution.mjs binding`이 정한다. workspace 검사는 workflow `before_dispatch` gate가 수행한다. plan hash 정규화는 `harness-plan-review.mjs check`가 판정한다.
2. **공통 규칙은 설치되는 관리 자산 한 곳에 둔다.** consumer의 `docs/agents/EXEC.md`는 프로젝트 소유이며 설치되지 않는다. 실제 테스트 consumer(`harness-test`)의 EXEC.md에는 "세션 파일 출력 경계" 섹션이 없다. 따라서 실행 산출물 경로 규칙(로그·임시 파일·스크린샷 등을 어디에 쓰는가)의 정본은 `EXEC.md`가 아니라 `.codex/internal-skills/skill-execution/references/runtime-artifact-paths.md`(신규)에 둔다.
3. **링크는 그 실행이 실제로 따라야 할 문서만 건다.** 참고용 링크도 모델이 읽는 계기가 된다.
4. **agent toml에는 역할별 차이만 둔다.** 공통 절차는 역할이 읽는 GUIDE가 소유한다.
5. 한 파일 안에서는 같은 규칙을 한 번만 쓴다.

## 4. 작업 단계

각 단계는 독립 commit으로 나누고, 단계마다 §5의 검증을 수행한다.

### 단계 1 — 충돌·오류 지시 제거 (우선)

| # | 대상 | 변경 |
|---|---|---|
| 1-1 | `grill-with-docs`, `domain-modeling`, `implement`, `gh-open-pr`, `maintain-verification`, `evaluate-harness`, `frontend-design` GUIDE의 `## 통합 계약 연속성` | "sync-contracts에 따라 갱신" 문장이 AGENTS.md와 `code-review/GUIDE.md:120`(중간 plan은 deferred, 최종 통합에서만 sync)과 충돌한다. 설계 단계(`grill-with-docs`, `domain-modeling`)와 plan 단위 `implement`에서는 "현행 계약을 읽고 변경안은 ticket Spec에 기록" 한 줄로 바꾼다. 최종 통합을 수행하는 스킬(`implement-wrapper` 최종 단계, `sync-contracts`)에만 갱신 지시를 남긴다. `gh-open-pr`·`maintain-verification`·`evaluate-harness`·`frontend-design`은 각 흐름이 실제로 최종 통합 경로인지 확인한 뒤 같은 기준으로 정리한다. |
| 1-2 | `frontend-design/GUIDE.md` `## Workspace contract` 3-4단계 | `frontend-design.yaml`의 `before_dispatch: workspace` gate와 중복된다. `implement/GUIDE.md:11`처럼 "gate가 수행하며 별도 실행하지 않는다"로 바꾼다. standalone 실행에도 gate가 적용되는지 `harness-skill-execution`/dispatch 경로에서 확인하고, 적용되지 않으면 standalone 조건으로만 남긴다. |
| 1-3 | `implement/GUIDE.md:14` | runner가 주입하는 `skill-execution/worker-base.md`를 다시 가리키는 문장이다. worker-base는 모든 stage에 이미 주입되므로 문장을 삭제한다. (계획 작성 시 "근거 코드 없음"으로 잘못 적었고 구현 중 정정했다.) |
| 1-4 | `e2e-test/GUIDE.md:26` | "원본 checkout / 설치 consumer" 분기의 두 경로가 같다. 경로 하나로 합친다. |
| 1-5 | `to-ticket/references/github-batch-publish.md:21,27` | 동일 문장 중복을 하나로 합친다. |

### 단계 2 — 실행 모델 보일러플레이트 제거 (−약 12 KB)

- 33개 GUIDE/SKILL의 `## 실행 모델과 반환`에서 model_tier·model key·binding 해석 문장을 삭제한다.
- 남길 내용은 스킬별 고유 정보뿐이다. 예: "구현은 이 실행이 수행하고 필수 독립 리뷰는 서브에이전트에 위임한다", "사용자 결정과 단계 전환은 caller에 반환한다". 고유 정보가 없으면 섹션 전체를 삭제한다.
- 공통 문장 "사용자 결정과 workflow 단계 전환은 상위 caller에 반환한다"는 `skill-execution/GUIDE.md`에 한 번만 둔다.
- `spec-me/GUIDE.md:14`의 standalone 모델 설명과 `frontend-design/GUIDE.md`의 `## Model routing`도 같은 이유로 삭제한다. stage별 tier는 `frontend-design.yaml`이 이미 정한다.
- 확인: 각 skill 문서 frontmatter의 `model_tier`와 workflow yaml의 stage `model_tier`가 삭제된 설명과 일치하는지 대조한다(설명 삭제 전 값 손실 여부 점검).

### 단계 3 — 공통 섹션 통합 (−약 17 KB)

| 항목 | 정본 | 각 사용처 처리 |
|---|---|---|
| 실행 산출물 경로 (GUIDE `## 세션 출력` 9곳 + agent toml 17곳) | 신규 `skill-execution/references/runtime-artifact-paths.md`. 현재 `docs/agents/EXEC.md` §"세션 파일 출력 경계"의 Harness 공통 부분을 옮긴다. | GUIDE는 섹션 삭제 후 필요 스킬만 링크 한 줄. agent toml은 "Follow `.codex/internal-skills/skill-execution/references/runtime-artifact-paths.md`." 한 문장으로 교체. |
| 테스트·서비스 실행 전제 (7곳) | `e2e-test/references/verification-policy.md` | "일반 검증은 EXEC.md의 native CLI, `harness-exec`는 명시적 E2E 전용"을 정본에 두고 사용처는 링크 한 줄. `e2e-test` 자신의 실행 절차는 유지한다. |
| 소유 worktree 종료 (6곳) | `session-worktree/GUIDE.md` | 하위 단계(`code-review`, `e2e-test`, `implement`, `sync-contracts`)는 "상위 workflow의 worktree를 그대로 사용한다" 한 줄. 독립 workflow인 `frontend-design`, `gh-open-pr`만 링크를 남긴다. |
| "내부 절차를 호출할 때 공개 스킬 검색 대신 …" (16곳) | `skill-execution/GUIDE.md`의 한 문장 | 각 파일 첫 줄 삭제. 본문에서 실제로 쓰는 GUIDE만 해당 위치에 링크한다. |
| E2E 실패 시 자동 수정·재실행 금지, 최종 E2E 승인 요건 | `e2e-test/references/verification-policy.md` | `failure-learning.md`의 동일 문장을 링크로 대체. |
| VictoriaLogs 진단 로그 문단 4종 | `victorialogs-local-setup/GUIDE.md` | `implementation-guidance`·`testing-guidance`에는 적용 조건과 링크만 남긴다. |

설치·배포 영향: 신규 `runtime-artifact-paths.md`는 `skill-execution/references` 아래에 두어 기존 관리 자산 discovery에 포함되게 한다. 설치 consumer에서 경로가 생성되는지 단계 6에서 확인한다.

### 단계 4 — 대형 GUIDE 본문 정리

`implement/GUIDE.md` (23 KB → 목표 14 KB 이하)
- `pwd`/`git rev-parse` 확인(28-30행, Flow 5단계)을 한 번으로 합친다.
- testing-guidance 읽기(24행, Flow 8단계)를 한 번으로 합친다.
- tracker 상태 규칙(Flow 16, 51행, Rules 72-74·82·83행, `## Lifecycle 상태와 실행 단계`)을 "Tracker 상태" 한 섹션으로 모은다. 상태 이름 표 1개 + `harness-tracker.mjs sync/read` 명령 + 실패 처리만 남긴다.
- PR 규칙(Flow 18, Rules 72, 86행)을 한 문장으로 합친다.
- `## Harness source distribution`(18-20행)은 Harness 소스 저장소 전용인데 모든 consumer에 설치된다. AGENTS.md와 `.codex/internal-skills/implement/GUIDE.md`가 서로 참조하는 구조이므로 소스 전용 내용은 `harness-maintenance/GUIDE.md`로 옮기고, implement에는 "Harness 소스 저장소에서는 harness-maintenance를 따른다" 한 줄만 둔다. AGENTS.md의 참조도 함께 갱신한다.
- 첫 줄 링크에서 `spec-review`, `sync-contracts`, `session-worktree`, `ddd-design` GUIDE를 제거하고 실제 필요한 `ddd-design/references/model-continuity.md`만 본문에 남긴다.

`code-review/GUIDE.md` (20 KB → 목표 13 KB 이하)
- `## Process` 1-10단계, `## Waiting`, `## Rules`의 "독립 실행·대기·합치지 않음" 반복을 하나의 짧은 목록으로 합친다.
- `## 판정과 수정 절차` 2단계의 hash 정규화 설명을 "canonical hash 판정은 `harness-plan-review.mjs check` 결과를 사용한다" 한 문장으로 줄인다.
- reviewer JSON 계약(판정 4단계)과 `## Spec 밖 동작`을 이 GUIDE의 정본으로 확정한다(단계 5에서 toml 중복 제거).
- 첫 줄 링크에서 `sync-contracts`, `session-worktree`, `ddd-design` GUIDE를 제거한다.

기타
- `spec-me/GUIDE.md`: 기존 Spec 보존 규칙(20·41행)과 worktree 사용 설명(32·38행) 중복을 합친다.
- `gh-open-pr/GUIDE.md`: closing keyword 규칙과 plan PR 확인 항목 중복을 합친다.
- `ddd-design/GUIDE.md`: bounded context 비교 기준 문장 두 개를 하나로 합친다.

### 단계 5 — 리뷰어 agent 중복 제거

- `spec_reviewer.toml`과 `standards_reviewer.toml`은 61개 문장 중 약 45개를 공유하고, 공유분은 `code-review/GUIDE.md`의 판정 계약과도 겹친다.
- 공통 내용(최종 JSON 출력 형식, `basis`/`intent_ref`/`failure_scenario` 요건, `unrequested_behavior`, advisory 기준, `product-decisions.md` 재보고 금지, 편집·재귀 호출 금지)은 `code-review/GUIDE.md`에만 둔다.
- 각 toml에는 역할 선언, 축별 입력·검사 항목, "Use the code-review GUIDE output contract"만 남긴다.
- `code_researcher`·`implementation_agent`와 공유하는 실행 설정 점검 문장 3개(`execution.json`/EXEC 대조, 인프라 누락, 빈 dependency 목록 근거)는 필요한 역할에만 남기고 나머지는 삭제한다.
- 확인: `tests/claude_review_admission_consumer.test.mjs`, `tests/review_scope_guard.test.mjs`가 toml 문구를 단언하는지 확인하고, 단언이 있으면 의미를 유지하는 방향으로 함께 갱신한다. Claude 변환(`transforms.mjs`의 `developer_instructions` 추출)이 그대로 동작하는지 확인한다.

### 단계 6 — AGENTS.md 정리 (13.6 KB → 목표 7 KB)

AGENTS.md는 설치되지 않는 소스 저장소 전용 파일이지만 이 저장소의 모든 세션에 로드된다.
- 유지: Agent Context(언어 규칙), Harness source changes, 소스 push → consumer update 순서, cleanup 절차, 테스트 저장소(`harness-test`) 정보, Durable Context 목록.
- 축소: `작업 입력과 Workspace`, `Tracker lifecycle`, `Workflow worktree 종료`, `Session output`, `Fresh Spec review`, `Canonical contracts`의 상세 절차는 각 GUIDE에 이미 있다. 섹션별 1-2문장 요약과 정본 GUIDE 링크로 바꾼다.
- 단계 4에서 옮긴 `harness-maintenance` 참조를 반영한다.

### 단계 7 — 재발 방지 검사

- `tests/prompt_budget.test.mjs`(신규)를 추가하고 `package.json`의 `test` 목록에 넣는다.
  - §2 대상 파일 전체에서 50자 이상 동일 문장이 3개 이상 파일에 나타나면 실패한다(허용 목록으로 예외 관리).
  - 금지 패턴: "기본 `model_tier`는", "내부 절차를 호출할 때 공개 스킬 검색 대신".
  - GUIDE/SKILL/toml 안의 상대·`.codex/...` 링크가 실제 파일을 가리키는지 확인한다(설치 시 `.codex/skills/` → `.agents/skills/` 변환 대상은 원본 경로 기준).
  - 크기 상한은 두지 않는다(정당한 내용 추가를 막지 않기 위해). 측정값은 테스트 로그로만 출력한다.

## 5. 검증

단계마다:
1. `npm test` 전체 통과.
2. 변경 파일을 단언하는 테스트 확인: `spec-me`, `workflow-compose`, `to-ticket`, `tracker-publish`, `technology-selection`, `implementation-guidance`, `skill-execution/references/{input,workflow-map}.md`, `code-review/references/baseline.md`, `orchestrator/SKILL.md`, `tracker_publisher.toml`.
3. 삭제한 규칙마다 정본 위치에 같은 의미가 남아 있는지 diff로 대조한다(의미 손실 점검표를 commit 설명에 기록).

전체 완료 시:
4. 신규 관리 자산(`runtime-artifact-paths.md`)과 이동한 내용을 포함해 임시 consumer에 fresh install과 update를 수행하고 Doctor inventory가 통과하는지 확인한다. 설치된 `.agents/skills/*`·`.claude/*` 변환본에서 링크가 해석되는지 확인한다.
5. 설치 consumer에서 `git status --short`로 Harness 관리 파일이 ignore되고 프로젝트 소유 파일은 그대로인지 확인한다.
6. §2와 같은 방식으로 재측정해 전후 표를 남긴다. 목표: 대상 전체 −55 KB 이상, `implement` 본문+직접 링크 94 KB → 60 KB 이하, `code-review` 69 KB → 45 KB 이하.
7. 사용자가 원하면 `harness-test`에서 `docs/agents/EXEC.md`의 black-box 시나리오 1개를 실행해 spec-me → 구현 흐름의 동작 회귀가 없는지 확인한다(행동 검증은 사용자 승인 후 별도 실행).

## 6. 위험과 대응

| 위험 | 대응 |
|---|---|
| 보일러플레이트를 지우면서 스킬 고유 규칙까지 손실 | 삭제 전후 문장 대조표 작성. 고유 문장은 정본으로 옮긴 뒤 삭제. |
| 링크 제거로 필요한 문서를 읽지 않게 됨 | 링크 제거는 "그 실행이 해당 절차를 수행하지 않음"이 확인된 경우에만. 판단 근거를 commit 설명에 기록. |
| 1-1 수정이 최종 통합 경로의 계약 동기화를 누락시킴 | `implement-wrapper` 최종 단계와 `sync-contracts` 지시는 유지하고, 완료 hook의 `contract_docs` gate가 계속 강제하는지 테스트로 확인. |
| consumer 프로젝트가 기존 EXEC.md의 산출물 경로 규칙에 의존 | 프로젝트 소유 EXEC.md는 수정하지 않는다. Harness 정본을 추가만 하므로 기존 내용과 충돌하지 않는다. |
| 리뷰어 toml 축소로 출력 형식 준수율 저하 | 최종 JSON 형식 한 문장은 toml에 남긴다(파싱 실패 비용이 크므로). 나머지 판정 기준만 GUIDE로 이동. |

## 7. 진행 순서와 확인 지점

1. 이 계획에 대해 사용자 확인(전체 또는 단계 선택).
2. 단계 1 → 2 → 3 → 4 → 5 → 6 → 7 순서로 구현하고 단계별 commit.
3. §5 전체 검증 후 결과 보고. commit push와 consumer update는 AGENTS.md 순서(소스 push 확인 → consumer update)를 따르며 사용자 지시가 있을 때 수행한다.

## 8. 실행 결과 (2026-11-08)

커밋: `e15c6551` 단계 1, `625a6521` 단계 2, `855da15a` 단계 3, `9c80a97f` 단계 4, `15665fba` 단계 5, `61d0da47` 단계 6, `fbff3ee6` 단계 7.

| 지표 | 176b7c3e | 결과 | 목표 |
|---|---:|---:|---|
| 대상 전체 | 581,239 B | 523,514 B (−57.7 KB, −9.9%) | −55 KB 이상: 달성 |
| 완전 동일 문장 중복 | 73종, 26.5 KB | 38종, 9.2 KB | — |
| `AGENTS.md` | 13.6 KB | 7.7 KB | 7 KB: 근접 |
| `.codex/agents` | 58.2 KB | 44.5 KB | — |
| `implement` 본문 + 직접 링크 | 23.0 + 71.0 KB | 15.5 + 53.4 KB | 60 KB 이하: 미달(68.9 KB) |
| `code-review` 본문 + 직접 링크 | 20.0 + 49.0 KB | 17.0 + 31.5 KB | 45 KB 이하: 미달(48.5 KB) |
| `frontend-design` 본문 + 직접 링크 | 18.4 + 61.7 KB | 15.9 + 15.7 KB | — |

계획과 다르게 처리한 항목:
- `implement`의 `## Harness source distribution`은 `harness-maintenance`로 옮기지 않고 삭제했다. 같은 내용이 AGENTS.md에 있고, `harness-maintenance`는 consumer 업데이트 스킬이다.
- 내부 GUIDE 링크 헤더는 본문 링크로 바꾸지 않고, 모든 stage에 주입되는 `worker-base.md`에 일반 규칙 한 문장을 두었다.

구현 중 추가로 발견해 고친 문제:
- `implementation_agent.toml`이 구현자에게 정상 완료 전 통합 계약 갱신을 지시했다(단계 1-1과 같은 충돌).
- AGENTS.md의 Session output(작업 workspace `.io`)과 Fresh Spec review(요청 원문·근거 직접 읽기)가 현재 resolver·`spec-review` GUIDE와 달랐다.
- fresh install은 공개 스킬을 orchestrator·eli5·setup만 설치하므로 agent 9개의 `.agents/skills/<name>/SKILL.md` entrypoint가 존재하지 않았다. 내부 GUIDE 경로로 바꿨다. `harness-recover`의 setup 링크도 설치 후 깨지는 상대 경로였다.

검증:
- `node --test tests/*.test.mjs`: 103개 중 102개 통과. 실패 1개(`installed to-ticket uses skill binding …`의 `/dedicated workflow executor stage/` 단언)는 176b7c3e에서도 같은 이유로 실패하며 `npm test` 목록 밖이다.
- `npm test`: 45/45 통과(신규 `tests/prompt_budget.test.mjs` 포함). 신규 테스트 두 개는 176b7c3e에서 실패하고 현재 통과한다.
- 임시 consumer의 fresh install과 176b7c3e 설치 후 update: 신규 `runtime-artifact-paths.md`가 설치되고 `.git/info/exclude`로 ignore되며 앱 변경(`M app.txt`)은 그대로 보인다. Doctor의 `permission_conflict .codex/harness.yaml`과 untracked `.harness/`는 setup 없이 설치한 176b7c3e에서도 동일하게 나타난다.

남은 사항:
- 해결: 구현 리뷰 소유권은 fresh reviewer stage와 orchestrator로 정했다(`627a5c76`). `implement` GUIDE는 `REVIEW_REQUIRED`로 반환한다.
- 해결: 소스 push와 `harness-test` update를 수행했다. update는 Harness 관리 경로를 최신 릴리스와 같게 맞추도록 바꿨다(`01a0c172`, `a00f81d6`).
- 미달: `implement` 본문+직접 링크는 목표 60KB 대비 약 68KB, `code-review`는 목표 45KB 대비 48.5KB다.
- 잔여: 완전 중복 문장 38종(9.2KB)이 남아 있다. 각 3곳 미만 반복이라 테스트 기준은 통과한다.
- 미반영: 변경은 `implement-plan-review-plan-spec-5000` 브랜치에만 있고 `main`에 병합하지 않았다.
