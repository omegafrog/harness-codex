# Harness 사용자 경로 검증 지도

현재 소스 기준으로 시작한 검증 지도다. 아래 `not-run`은 실제 사용자 경로를 실행했다는 뜻이 아니다. 단위/계약 테스트 성공만으로 live 검증 상태를 바꾸지 않는다. 실행 환경·명령·격리는 [EXEC.md](../agents/EXEC.md)를 따른다. 실행 증거는 작업 트리 외부에 보존하고 종료 후에도 존재하는지 확인한다.

| 기능 | 사용자 진입점 / 소유 source | 전제와 조작 | 관찰 가능한 성공·부작용 | live 상태 |
|---|---|---|---|---|
| 외부 프로젝트 설치/갱신 | `bin/harness-install.mjs`, `src/installer/` | 소유한 격리 consumer Git 저장소에 `install`, 이어서 `update`; 명령은 EXEC 참조 | `.agents/skills`, `.codex/agents/workflows/scripts` 설치와 lock 생성; 사용자 파일 보존, 변경된 배포 스킬 반영 | not-run |
| 설치 진단 | `bin/harness-doctor.mjs`, `src/doctor/doctor.mjs` | 설치된 격리 consumer에서 doctor; permission profile 조건 확인 | JSON `passed`/diagnostics와 exit code가 실제 설정 상태를 반영; 프로젝트 파일 비변경 | not-run |
| workspace 불일치 차단 | `.codex/scripts/harness-workspace-preflight.mjs` | 소유한 격리 worktree의 실제 루트와 다른 expected-root로 각각 실행 | 일치/불일치가 JSON valid와 exit code에 반영되고 검사 자체는 저장소를 변경하지 않음 | not-run |
| Harness suite 실행 | `bin/harness-eval.mjs`, `src/eval/runner.mjs` | 설정된 suite, 인증·모델·recording 전제; 명령은 EXEC 참조 | result/report/events·품질/효율/실패 분류 일치, cleanup 결과와 raw 증거 보존; 외부 서비스 제약은 inconclusive로 구분 | not-run |
| 변경 설계부터 구현 인계 | `.codex/workflows/spec-me.yaml`, `to-ticket.yaml`, `implement-wrapper.yaml` | 대표 기존 모델 확장 과제, spec-me 인터뷰·승인·tracker 및 Beads 전제 | 기존 owner/근거 → 승인 설계 → slice별 rule/target → 실제 enforcement/검증 → 리뷰 → 모델 갱신이 연결됨; 외부 mutation은 해당 단계의 사용자 승인 필요 | not-run |

## 유지보수

`maintain-verification`은 영향받는 source/Spec/기능을 대조하고, 실제 실행한 feature만 commit·명령·증거·성공/실패/차단 결과로 갱신한다. 문서 drift, 검증 도구 gap, 제품 회귀를 구분하고 회귀를 문서 수정으로 숨기지 않는다. 부분 실행이면 전체 지도 통과로 보고하지 않는다.

## 통합 계약 연결

현재 요구 동작은 [전체 Product 계약](../contracts/product.md)이 기준이다. 이 지도는 실제 실행 상태와 근거를 보존하며 요구를 복제하지 않는다. `maintain-verification`은 기존 기능의 계약과 실제 호출 경로·실행 결과를 비교한다. 통합 계약의 구조/version gate 통과와 제품 동작 검증을 별개로 기록한다. 신규 contract checker의 단위·격리 통합 결과는 [Luna 검증 기록](luna-workflow-check.md)에 추가한다.
