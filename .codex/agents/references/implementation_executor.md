# Implementation Executor

## 입력

- `docs/changes/active/<CHG-ID>/plan.md`
- 첫 `- [ ]` 행의 작업·대상 경로·구현 내용·검증

위 문서가 없거나 `status: ready`가 아니면 blocker다. 한 번의 호출은 첫 미완료 행 하나만 처리한다.

## 실행

1. 대상 BC 모듈과 행의 `대상 경로`만 먼저 읽는다.
2. 해당 행에 선언된 파일만 쓴다. 다른 BC 쓰기는 그 경로가 같은 행에 명시된 경우만 허용한다.
3. Java 파일을 다룰 때만 `.codex/agents/references/effective-java.md`를 읽는다. 이는 plan, DDD 설계, 기존 코드 규칙보다 낮은 우선순위다.
4. 필요한 교차 BC 읽기는 최소 파일로 제한하고 결과에 다음 형식으로 남긴다.
   `cross-bc read: <이유> -> <경로>`
5. 행의 검증 명령을 실행한다.
6. 검증 통과 시에만 그 행의 `- [ ]`를 `- [x]`로 바꾼다. plan을 포함한 ChangeSet 산출물은 stage하지 않는다.
7. commit 전에 기존 staged 변경이 있으면 `blocker: scope`로 종료한다. 선언된 제품 코드·tests 경로만 `git add -- <경로>`로 stage하고, `.codex/skills/harness-implementation-executor/scripts/ensure_commit_scope.py`를 실행한다. `docs/changes/**`, `docs/use-cases/**`, `docs/plans/**`, `.harness/**`가 staged면 agent가 이번 호출에 stage한 해당 경로만 unstage하고 commit하지 않은 채 blocker다.
8. guard 통과 시에만 한국어 commit한다.

## 중단

- 행의 경로·구현 내용·검증이 부족하거나 모순됨
- 새 도메인 정책 또는 기술 결정이 필요함
- 검증 실패 또는 실행 불가

중단 시 계획 체크·커밋을 하지 않는다. 단, stage guard 실패 뒤 plan 체크는 유지하되 commit하지 않는다. `blocker: domain|technical|verification|scope`와 최소 근거를 반환한다. orchestrator가 upstream step으로 라우팅한다.

## 결과

간결한 한국어로 작업, 변경 파일, 검증 결과, `cross-bc read` 기록, 남은 `- [ ]` 개수, 커밋 또는 blocker를 보고한다.
