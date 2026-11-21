# Harness 공통 도메인 지식 관리 구현 계획

상태: 구현 전 계획
대상: `omegafrog/harness-codex`의 `main` (`4a14a693` 기준)

## 범위와 소유권

기능별 Spec은 사용자 결정과 기능의 변경 근거를 보존하고, `docs/domain/`은 프로젝트의 현재 도메인 정의를 보존한다. 기존 Stage ID·순서·승인과 Worktree 격리를 유지한다. `CONTEXT.md`는 용어, `CONTEXT-MAP.md`는 Context 경계와 관계를 계속 소유한다. 이미 `docs/domain/stakeholders/`를 읽고 쓰는 Stakeholder 레지스트리를 재사용한다. 기존 통합 계약과 완료 gate는 계속 운영하며, 공통 도메인에 별도 정본을 두고 양쪽의 책임을 문서화한다.

아래 각 단계는 소스와 함께 설치·갱신 경로를 검증한다. Phase 6에서는 두 경로를 처음 구현하는 대신 실제 프로젝트에서 누적 동작을 확인한다.

## 1. 정본과 구조 검증

- `.harness/src/domain/schema.mjs`와 `repository.mjs`에 버전별 Frontmatter, 종류별 필드, ID·파일 경로·소유 Context 일치 규칙을 구현한다. 본문은 원문 그대로 보존한다. 읽고 쓰는 경로는 프로젝트 루트 내부의 일반 파일로 제한한다.
- `CONTEXT-MAP.md`의 기존 행에 안정적인 Context ID를 연결하는 호환 형식을 정의한다. Subdomain은 전역 ID와 관련 Context 목록을 갖는다. 이름 변경 시 ID를 유지한다. 소유권 이전은 이전 ID 폐기와 새 ID 및 대체 관계로 표현해 과거 참조를 추적할 수 있게 한다.
- `validation.mjs`에서 중복 ID, 존재하지 않는 참조, 소유권, 폐기·대체 관계, 종류별 상태를 검증한다. Stakeholder 파일은 기존 파서로 처리한다. 공통 항목이 없는 저장소도 유효한 시작 상태다.
- 완료 조건은 정상 문서 왕복, 구형 프로젝트 호환, ID·참조·경로 탈출·symlink 거부를 fixture로 입증하는 것이다.

## 2. 인덱스, 검색과 CLI

- `harness-domain.mjs`에 `index`, `validate`, `discover`, `search`, `get`을 추가한다. 생성한 프로젝트·Context `INDEX.md`는 동일 입력에서 바이트가 같아야 한다. `index --check`는 원본과 생성물의 차이를 검증한다.
- `search.mjs`에서 정확한 ID·용어·Alias 일치를 우선하고 BM25와 한국어 문자 n-gram으로 후보를 정렬한다. 동점은 ID로 정렬한다. 참조를 따라 교차 Context 후보를 제한적으로 반환한다. 폐기 표현은 상태와 대체 ID를 함께 제공한다.
- `discover`는 기본 후보 5개와 검색 근거를, `get`은 복수 ID의 정본 원문과 버전을 반환한다. 정의가 없으면 빈 결과를 반환한다. 버전은 정본과 용어·Context 입력의 콘텐츠 해시와 인덱스 버전에서 계산한다. 런타임 역색인은 Worktree의 `.io`에 저장한다.
- 완료 조건은 한국어 표현, Alias, 교차 Context 및 폐기 사례를 고정 데이터로 검증하고 Recall@5·호출 수·지연 측정 방법을 확정하는 것이다. 전체 Workflow의 변경 전 기준선은 Stage 연동 전에 동일 입력으로 채집한다.

## 3. Stage 입력과 재사용

- `stage-input.mjs`에서 첫 요구사항 Stage 전에 Context Pack을 준비하고 기존 실행 입력의 artifact 참조로 넘긴다. `stakeholder-persona` 입력 계약은 유지한다. Stage별 allowlist는 제안서의 표를 따른다. Pack에는 후보 ID, 요약, 출처와 버전만 남기고 필요한 원문은 일괄 `get`으로 조회한다.
- 입력 요청·정본 버전·검색 버전이 같은 Pack을 재사용한다. Reopen이나 사용자 지시로 요청이 바뀌면 재검증한다. 변경된 항목과 관련 후보를 재조회하고, 참조 범위를 확정할 수 없으면 Pack 전체를 다시 만든다.
- 관련 GUIDE에 CLI 조회와 재사용 판단을 연결한다. 새 Event Storming 템플릿에 `EVT-xx`, `POL-xx`, `TRN-xx`를 도입하고 기존 완료 문서는 그대로 둔다.
- 완료 조건은 기존 규칙·이벤트가 공통 ID로 이어지고, Stage 입력에는 지정한 종류만 포함되며, 빈 저장소 및 이전 실행 입력으로도 진행할 수 있는 것이다.

## 4. 확정 동기화와 실행 상태

- `sync plan`은 재사용·생성·확장·수정·폐기·소유권 이전을 분류하고, 로컬 ID와 공통 ID를 연결하는 `domain-links.json` 및 대상별 이전 해시를 만든다. 의미 변화에는 근거와 영향받는 참조를 기록한다. 업무 결정이 남으면 기존 사용자 질문 계약을 사용한다.
- `sync apply`는 계획 해시와 현재 입력을 대조하고, 변경 후 후보 트리 전체를 먼저 검증한다. 영향 경로와 이전 내용을 실행 세션에 기록해 도중 실패하거나 재시도할 때 복구할 수 있게 한다.
- 요구사항 coverage 통과 후 기존 `harness-native-stage.mjs finish`의 Gate → 커밋 → 상태 기록 순서에 연결한다. 성공 경로가 도메인 검증을 건너뛰지 못하도록 상태 기록 진입점도 확인한다. 커밋에는 해당 Stage가 수정한 항목·매핑·인덱스만 포함한다. `requirements-restart.mjs`는 실행별 변경 목록과 이전 해시로 소유 경로만 복원한다. 후속 변경과 겹치면 충돌을 반환한다.
- 전술 설계 중 허용된 요구사항 변경을 같은 절차로 반영한다. `implemented` 전환은 현재 정의에 대응하는 구현과 테스트 근거를 확인한 경우에만 허용한다. 구현 근거가 기존 정의에만 해당하면 변경된 정의는 `accepted-target`으로 남긴다.
- 완료 조건은 검증 실패·부분 쓰기·중복 재시도·Restart·Reopen 후에도 정본과 상태가 일치하고 다른 Stage의 변경이 보존되는 것이다.

## 5. PR과 병합 검증

- `merge-check.mjs`는 merge-base, PR head, 최신 base와 실제 병합 후보를 검증한다. 서로 다른 항목 변경은 허용하되 합쳐진 결과의 참조·소유권·중복·인덱스를 재검증한다. 서로 다른 항목의 인덱스 충돌은 정본 병합 후 재생성할 수 있게 한다.
- 기계적으로 입증할 수 있는 구조·소유권 충돌과 의미 검토를 구분한다. 의미 중복 후보, 기존 규칙의 적용 조건 변경과 소비 Policy 영향은 검토 대상으로 반환한다. 의미 검토 결과는 base·head 및 정본 해시에 묶고 대상이 바뀌면 다시 검토한다.
- `gh-open-pr`에는 로컬 점검을 넣고, 별도 CI에서 `pull_request` 및 `merge_group`의 통합 결과를 검사한다. 설치된 소비자의 CI는 Git이 추적하지 않는 로컬 설치 경로에 의존할 수 없으므로 고정 Harness 리비전의 실행기를 준비하는 방법을 제공한다. Required Status Check 또는 Merge Queue 설정은 소비자 저장소의 운영 단계로 문서화한다.
- 완료 조건은 병렬 변경, 동일 ID 변경, 의미 중복 후보, base 갱신, 병합 후보의 잔여 참조를 재현하는 것이다.

## 6. 마이그레이션, 배포 검증과 인수

- 기존 용어·Context·Stakeholder·완료 Spec·이벤트·구현 근거에서 후보를 추출하는 읽기 전용 bootstrap 보고를 제공한다. 확정 가능한 항목만 기존 `sync plan/apply` 흐름으로 등록한다. 미해결 항목은 근거와 함께 남기고 이전 Plan Set은 재작성하지 않는다.
- `installer/update.mjs`의 managed asset 탐색·변환과 Doctor inventory를 단계마다 확장한다. fresh install 및 이전 버전에서 update한 소비자 모두 CLI를 실행할 수 있어야 한다. `git status`와 `git check-ignore -v`로 설치 자산·런타임 캐시가 제외되고 `docs/domain/`, 생성된 `INDEX.md`, 매핑, 기존 프로젝트 문서가 Git에 보이는지 확인한다. CI 예제와 프로젝트 설정은 소비자 소유로 둔다.
- 신규 프로젝트, 미마이그레이션 프로젝트에서 기능 추가, 병렬 Worktree 통합을 별도 시나리오로 실행한다. 서버가 필요한 E2E 전제와 명령은 `.harness/agents/EXEC.md`와 실행 profile에 맞춘다. 동일 업무 요청과 도메인 자료로 변경 전후 Recall@5·도구 호출·입력 토큰·재사용·중복·실행 시간과 Stage 결과를 비교한다.
- 첫 구현 PR은 Phase 1로 제한한다. Phase 2의 측정 방식을 확정하기 전 수치 목표를 고정하지 않는다. 의미 충돌 처리는 자동 승인과 분리하고 실제 검토 증거까지 확보한 뒤 전체 인수 기준을 판정한다.
