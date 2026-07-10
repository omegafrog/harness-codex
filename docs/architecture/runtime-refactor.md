# Runtime 책임 경계

## 목표

Runtime은 로컬 실행 플랫폼이다. XML 계약 검증, deterministic gate, 상태·증거
기록, worktree와 로컬 서비스만 제공한다. workflow 진행, retry, remediation,
reviewer 선택, 완료 판단은 orchestration agent가 담당한다.

## 실행 경계

```text
orchestration agent
  -> subagent-invocation.xml 생성
  -> specialist/reviewer subagent 호출
  -> subagent-result.xml 수신
  -> runtime에 계약·gate 검증 요청
  -> 다음 단계, retry, remediation 또는 완료 판단

runtime
  -> XML 계약 검증
  -> deterministic gate 실행
  -> 상태와 evidence 기록
  -> agent step 직접 실행하지 않음
```

## 책임

| 책임 | 담당 |
|---|---|
| workflow 진행과 다음 단계 선택 | orchestration agent |
| specialist/reviewer 선택과 호출 | orchestration agent |
| retry, remediation, blocked, 완료 판단 | orchestration agent |
| invocation/result XSD 검증 | runtime |
| artifact 경로·hash 검증 | runtime |
| deterministic gate 실행 | runtime |
| RunState, evidence, dashboard 기록 | runtime |
| worktree와 로컬 서비스 관리 | runtime |

## Installer 계약

`bootstrap.configure_runtime()`은 runtime 디렉터리와 registry를 준비하고
`RuntimeInstallation` 결과를 반환한 뒤 종료한다. 설치 결과는 workflow handoff가
아니다. installer는 설치용 XML handoff나 다른 agent invocation/result를 생성하지
않는다.

설치 결과에는 준비된 디렉터리와 등록된 schema, gate, tool만 포함한다. 다음 단계,
resume target, remediation target, orchestration recommendation은 포함하지 않는다.

## XML 계약

agent 간 실행 경계는 기존 `subagent-invocation-v1.xsd`와
`subagent-result-v1.xsd`를 사용한다. `reviewTask`와 `review`는 이 계약의 선택적
확장이다. 설치 결과에는 새 XML type이나 새 XSD를 추가하지 않는다.

## 검증

Runtime 결과는 관측 사실만 반환한다.

- XML parse/XSD/교차 참조 오류
- gate status, rule id, exit code
- evidence 경로
- 변경 파일과 상태 기록

실패 이후 행동은 orchestration agent가 결정한다.
