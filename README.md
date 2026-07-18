# harness-codex

`harness-codex`는 Codex skill과 ChangeSet 문서를 보조하는 로컬 utility 모음입니다.

## 구조

- `.codex/`: Codex가 발견하는 agent와 skill 정의
- `harness_codex/`: 문서 조회·검증·대시보드·completion·업데이트 utility 소스
- `.harness/`: 기존 ChangeSet 문서, 템플릿, 상태 같은 프로젝트 데이터

`.harness/runtime` 설치 사본과 runtime orchestration은 없습니다. runtime은 agent 생성, step 실행, routing, retry, session polling을 하지 않습니다.

Runtime은 호출자 소유 계약을 위한 범용 utility만 제공합니다.

- `ContractEnvelope`: 호출자가 제공한 schema·payload digest 검증
- `ProbeRequest` / `ProbeObservation`: 호출자가 선언한 deterministic probe 관측
- `RequirementSet`: opaque requirement dependency와 invalidation 계산
- `EvidenceEnvelope` / `EvidenceResolution`: fingerprint 기반 증거 저장·재사용 판정
- `ProgressEventDeduplicator`: 상태 전환·heartbeat 기반 진행 보고 중복 억제

구체적인 단계, 도구, 명령, 경로, intent, remediation와 완료 판단은 `.codex/`의
오케스트레이션 계약이 소유합니다. 기존 repository-aware preflight·gate·verification
import는 두 릴리스 동안 deprecated compatibility shim으로 유지됩니다.

## 작업 진행

Harness 저장소의 실행·변경·검토·조회 요청은 모두 `$harness-orchestrate-instruction`으로 시작합니다. 이 skill은 사용자 프롬프트 원문 전체를 `orchestration` agent에 먼저 전달하고, agent가 반환한 skill만 실행합니다. utility 요청은 해당 runtime skill로 라우팅합니다. 구현 요청은 제품 의미 변경의 긍정 근거가 있을 때만 `feature`, 승인된 기존 동작 복구는 `bugfix`, 외부 불변 조건을 보존하는 운영·구성·내부 변경은 `refactor`로 분류합니다.

## Utility CLI

```bash
./harness help
./harness changes list
./harness contracts validate <CHG-ID>
./harness dashboard
./harness completion install
```

CLI는 workflow 실행 진입점이 아닙니다.
