# harness-codex

`harness-codex`는 제품 요구사항, 엔지니어링 변경, 버그 수정 요청을 **파일 기반 실행 계약**으로 바꾸는 저장소 로컬 runtime입니다.

대화 이력에 의존하지 않고, ChangeSet, work item, stage artifact, plan, verification evidence, RunState를 파일로 남겨 다음 단계와 다음 실행이 같은 맥락을 이어받게 합니다.

README는 현재 지원하는 public workflow 계약만 설명합니다. 내부 실험 명령, 과거 호환 명령, 아직 공식 경로가 아닌 설계 아이디어는 이 문서의 기준이 아닙니다.

## 언제 어떤 workflow를 쓰는가

| 상황 | 사용할 workflow | 이유 |
| --- | --- | --- |
| 새 기능, 도메인 정책 변경, 유스케이스 추가 | ChangeSet staged workflow | 요구사항 → 언어 → 유스케이스 → 설계 → 계획 → 구현 증적을 남겨야 함 |
| 버그 수정, 작은 리팩터링, 회귀 수정, 운영성 보완 | Bug workflow | 전체 요구사항/DDD 절차를 강제하지 않고 증상, 영향 파일, 재현/검증 기준만 좁게 다룸 |
| 중단된 작업 재개, 다음 단계 확인 | Inspect/resume workflow | active ChangeSet과 RunState를 읽고 orchestration agent가 후속 작업을 판단함 |
| 이전 실패 패턴, 설계 문서, 코드 관계 탐색 | Memory/graph workflow | 검토된 장기 메모리, 파일 캐시, Graphify 기반 context를 사용함 |

## 핵심 개념

- **ChangeSet**: 하나의 일관된 변경을 끝까지 추적하는 최상위 단위입니다.
- **work item**: ChangeSet 안에서 실제로 계획, 구현, 검증되는 단위입니다. 일반적으로 `UC-*` 또는 `BUG-*` 같은 식별자를 가집니다.
- **stage artifact**: 각 단계가 다음 단계로 넘기는 문서 산출물입니다.
- **plan**: 구현자가 따라야 하는 체크리스트이자 변경 범위, 검증 기준, 완료 조건입니다.
- **RunState / RunReport**: 실행 상태, 실패 종류, 재개 지점, 검증 결과를 기록하는 runtime 증적입니다.
- **contract gate**: 다음 단계로 넘어가기 전에 필수 문서, work item 범위, plan 완료 상태, 검증 목표를 확인하는 차단 지점입니다.
- **memory / graph context**: 완료된 ChangeSet, 실패 패턴, 결정 기록, 소스/문서 그래프를 검색해 반복 작업의 탐색 비용을 줄이는 보조 context입니다.
- **public workflow entrypoint**: `harness orchestrate TEXT`가 유일한 workflow 실행 진입점입니다. Orchestration agent가 workflow progression과 specialist delegation을 담당하며, Runtime은 agent/decision step을 직접 실행하지 않습니다.

Runtime service는 `urn:harness:runtime-tool:v1` XML 계약으로 호출합니다. Request의
`toolId`와 `operation`은 고정 envelope에 두고, 프로젝트별 입력·출력은 recursive
generic value(`map`, `list`, `string`, `integer`, `number`, `boolean`, `null`)로 전달합니다.
Result는 `completed`, `failed`, `blocked` 중 하나만 반환하며 workflow route나 retry 판단을
포함하지 않습니다. 계약 파일은 `schemas/runtime-tool-request-v1.xsd`와
`schemas/runtime-tool-result-v1.xsd`입니다.

## 빠른 시작

대상 저장소 루트에서 실행합니다.

설치된 대상 저장소에서는 짧은 wrapper를 사용합니다.

```bash
./harness help
```

`harness-codex` 자체를 개발할 때는 Python module entrypoint를 사용할 수 있습니다.

```bash
python3 -m harness_codex help
```

처음에는 저장소 로컬 agent context를 준비합니다.

```bash
./harness init --description "이 저장소의 목적과 기술 스택 요약"
```

새 기능이나 큰 변경은 ChangeSet으로 시작합니다.

```bash
./harness requirements-definition --title "변경 제목" --idea "제품 또는 엔지니어링 목표"
./harness changes active
./harness help
./harness changes active
```

버그 수정이나 작은 리팩터링은 경량 bug workflow로 시작합니다.

```bash
./harness bug start \
  --title "문제 제목" \
  --symptom "관찰된 증상과 재현 조건" \
  --path src/example.py

./harness bug triage BUG-YYYYMMDD-001
./harness bug plan BUG-YYYYMMDD-001
./harness bug run BUG-YYYYMMDD-001 \
  --implement-command 'codex exec "fix according to docs/plans/active/BUG-YYYYMMDD-001/plan.md"' \
  --verify-command './venv/bin/python3 -m pytest -q -s tests/runtime' \
  --max-loops 2
./harness bug complete BUG-YYYYMMDD-001
```

## ChangeSet staged workflow

큰 기능 변경은 같은 ChangeSet ID를 기준으로 아래 순서를 진행합니다.

```bash
./harness requirements-definition --title "변경 제목" --idea "짧은 목표"
./harness ubiquitous-language-definition CHG-YYYYMMDD-001
./harness use-case-definition CHG-YYYYMMDD-001
./harness event-storming CHG-YYYYMMDD-001 --uc UC-001
./harness ddd-architecture-definition CHG-YYYYMMDD-001 --uc UC-001
./harness ddd-design-integration CHG-YYYYMMDD-001 --plan
./harness ddd-design-integration CHG-YYYYMMDD-001 --apply
./harness technical-decisions CHG-YYYYMMDD-001 --uc UC-001
./harness plan-writing CHG-YYYYMMDD-001 --uc UC-001
./harness help
./harness changes active
```

여러 유스케이스가 affected work item에 포함된 경우 `event-storming`, `ddd-architecture-definition`, `technical-decisions`, `plan-writing`은 필요한 `UC-*`마다 실행합니다. `ddd-design-integration`은 UC별 후보 DDD를 단순 병합하지 않고 ChangeSet 단위 canonical contract로 조정하는 단계이므로 ChangeSet 단위로 실행합니다.

### 단계별 책임과 산출물

| 단계 | 범위 | 주요 입력 | 주요 산출물 |
| --- | --- | --- | --- |
| `requirements-definition` | ChangeSet | 사용자 요청 | `docs/design/요구사항.md`, active ChangeSet |
| `ubiquitous-language-definition` | ChangeSet | 요구사항, ChangeSet | `docs/design/ubiquitous-language.md` |
| `use-case-definition` | ChangeSet | 요구사항, 유비쿼터스 언어 | `docs/design/유스케이스.md`, `docs/use-cases/<UC-ID>/use-case.md`, `e2e-goal.md` |
| `event-storming` | UC 하나 | use-case, e2e goal | `docs/use-cases/<UC-ID>/event-storming.md` |
| `ddd-architecture-definition` | UC 하나 | event storming, architecture baseline | `docs/use-cases/<UC-ID>/ddd-design.md` 후보 |
| `ddd-design-integration` | ChangeSet | UC별 DDD 후보, ubiquitous language, `ARCHITECTURE.md` | `docs/changes/active/<CHG-ID>.ddd-integration.md`, `.json` |
| `technical-decisions` | UC 하나 | DDD 후보, integration contract, architecture | `docs/use-cases/<UC-ID>/technical-decisions.md` |
| `plan-writing` | UC 하나 | 설계 문서, repository settings | `docs/plans/active/<UC-ID>/plan.md` |
| `orchestrate` | ChangeSet/workflow | active ChangeSet, workflow YAML, 문서 artifact | specialist 위임, 검증 결과, 완료/차단 상태 |

## 구현 실행 경계

`orchestrate`가 유일한 workflow 실행 명령입니다. orchestration agent가 미완료 work item을 판단하고 specialist subagent에 계획·구현·검토를 위임합니다. Runtime은 XML 계약·hash·gate와 durable session state만 관리합니다.

실행 원칙은 다음과 같습니다.

1. orchestration agent가 workflow YAML, active plan, ChangeSet 문서와 RunState를 읽습니다.
2. agent가 `agent_id`, `skill_id`, `needs`를 선택하고 기존 XML handoff로 specialist를 호출합니다.
3. Runtime은 invocation/result XML, hash, gate와 session checkpoint만 검증·기록합니다.
4. specialist는 지정된 task와 `reviewTask`만 수행하고 기존 `subagent-result.xml`을 반환합니다.
5. 중단 시 `checkpoint.json`과 기존 RunState를 기준으로 `harness resume RUN-ID`를 사용합니다.

완료된 plan은 다음 경로로 이동합니다.

```text
docs/plans/active/<WORK-ITEM-ID>/plan.md
        ↓
docs/plans/completed/<WORK-ITEM-ID>/plan.md
```

## Bug workflow

`harness bug`는 전체 ChangeSet 설계 절차를 타기에는 과한 버그 수정, 회귀 수정, 작은 리팩터링을 위한 경량 workflow입니다.

```bash
./harness bug start --title "버그 제목" --symptom "증상" --severity medium --path path/to/file
./harness bug triage BUG-YYYYMMDD-001
./harness bug plan BUG-YYYYMMDD-001
./harness bug verify BUG-YYYYMMDD-001
./harness bug run BUG-YYYYMMDD-001 --implement-command '...' --verify-command '...' --max-loops 2
./harness bug complete BUG-YYYYMMDD-001
```

`bug start`는 `docs/maintenance/<BUG-ID>/` 아래에 최소 문서를 만듭니다.

```text
docs/maintenance/<BUG-ID>/index.xml
docs/maintenance/<BUG-ID>/change-intent.md
docs/maintenance/<BUG-ID>/triage.md
docs/maintenance/<BUG-ID>/verification-goal.md
```

`bug plan`은 `docs/plans/active/<BUG-ID>/plan.md`를 만들고, `bug run`은 별도 git worktree에서 구현/검증 loop를 제한 횟수 안에서 실행합니다. 같은 실패 fingerprint가 반복되거나 최대 loop를 넘으면 blocked로 종료합니다.

Bug workflow를 사용해도 다음 원칙은 유지합니다.

- 재현 테스트 또는 재현 증거를 확보합니다.
- 영향 후보 파일을 좁혀서 시작합니다.
- 승인되지 않은 기능 확장과 관련 없는 리팩터링은 제외합니다.
- 반복 가능한 실패는 완료 후 memory 후보로 승격할 수 있습니다.

## 재개와 상태 확인

`harness help`는 agent를 실행하거나 파일을 변경하지 않고 active ChangeSet을 읽어 다음 안전한 명령을 제안합니다.

```bash
./harness help
./harness help orchestrate
./harness changes list
./harness changes active
./harness changes show CHG-YYYYMMDD-001
./harness changes contents CHG-YYYYMMDD-001
./harness stages list CHG-YYYYMMDD-001
./harness contracts validate CHG-YYYYMMDD-001
./harness contracts validate CHG-YYYYMMDD-001 --work-item UC-001 --json
./harness resume run-<RUN-ID>
./harness report run-<RUN-ID>
./harness dashboard
./harness ui-server
```

orchestration agent는 현재 ChangeSet과 RunState를 읽고 첫 번째 실행 가능한 specialist 작업을 선택합니다. 차단·재시도·복구·완료 판단도 orchestration agent가 수행합니다.

## Memory, cache, graph context

장기 메모리는 검토된 completed ChangeSet과 승인된 evolution 결과를 기준으로 검색합니다. 임의 raw 실행 로그를 그대로 지식으로 승격하지 않습니다.

```bash
./harness memory list
./harness memory list --kind failure_pattern
./harness memory search "plan verification failed" --limit 5
./harness memory reindex
./harness memory cache read docs/plans/active/UC-001/plan.md --metadata
./harness memory cache warm docs/design/요구사항.md docs/design/유스케이스.md
./harness memory cache stats
./harness memory graph status
./harness memory graph build docs src
./harness memory graph query "Which modules are related to verification gate?" --budget 1200
```

Graph context는 넓은 코드 스캔을 대체하기 위한 보조 조회 수단입니다. stale 상태이면 먼저 rebuild를 수행합니다.

```bash
./harness memory graph rebuild
```

## 운영과 설치 관리

```bash
./harness run app status
./harness run app --foreground
./harness run app stop
./harness run wiki serve
./harness completion install --shell auto
./harness update --dry-run
./harness update --ref main
./harness reset --runs
./harness reset --runs --apply
```

`reset`은 기본적으로 dry-run 성격입니다. 실제 삭제가 필요할 때만 `--apply`를 붙입니다.

## 저장소별 설정 파일

대상 저장소는 다음 파일로 실행 경계와 검증 기준을 명시합니다.

```text
.codex/repository-settings.md
.codex/test-gate.yaml
AGENTS.md
ARCHITECTURE.md
```

- `.codex/repository-settings.md`: 저장소 구조, 허용/금지 변경, 구현 경계.
- `.codex/test-gate.yaml`: test gate와 검증 명령.
- `AGENTS.md`: agent가 따라야 하는 저장소 공통 지침.
- `ARCHITECTURE.md`: shared architecture baseline.

## 파일/상태 경로

```text
docs/changes/active/<CHG-ID>.md
docs/changes/completed/<CHG-ID>.md
docs/design/요구사항.md
docs/design/ubiquitous-language.md
docs/design/유스케이스.md
docs/use-cases/<UC-ID>/use-case.md
docs/use-cases/<UC-ID>/e2e-goal.md
docs/use-cases/<UC-ID>/event-storming.md
docs/use-cases/<UC-ID>/ddd-design.md
docs/use-cases/<UC-ID>/technical-decisions.md
docs/changes/active/<CHG-ID>.ddd-integration.md
docs/changes/active/<CHG-ID>.ddd-integration.json
docs/maintenance/<BUG-ID>/
docs/plans/active/<WORK-ITEM-ID>/plan.md
docs/plans/completed/<WORK-ITEM-ID>/plan.md
.harness/runs/<RUN-ID>/
```

ChangeSet 문서의 procedure table은 사용자에게 보이는 mirror입니다. Runtime 판단의 기준은 `.harness/runs/<RUN-ID>/`에 기록되는 RunState와 검증 증적입니다.

## 개발자 검증

`harness-codex` 자체를 수정한 뒤에는 최소한 runtime test와 JavaScript syntax check를 실행합니다.

```bash
./venv/bin/python3 -m pytest -q -s tests/runtime
./venv/bin/python3 -m pytest -q -s
node --check harness_codex/runtime/dashboard_assets/dashboard.js
```

README와 CLI 계약을 함께 바꾼 경우 다음도 확인합니다.

```bash
python3 -m harness_codex help
python3 -m harness_codex help changes
python3 -m harness_codex help orchestrate
python3 -m harness_codex help bug
```

## 설계 원칙

- 파일 산출물이 단계 간 계약이다.
- ChangeSet이 runtime context의 루트다.
- `--plan`은 안전하게 확인하고, `--apply`만 변경한다.
- work item 범위 밖 변경은 검증 대상이다.
- 검증 실패는 숨기지 않고 failure kind와 재개 지점으로 남긴다.
- bug/refactor는 전체 설계 workflow를 강제하지 않고 경량 workflow로 처리한다.
- memory와 graph는 탐색을 돕지만, 검토되지 않은 내용을 자동 정본으로 만들지 않는다.
