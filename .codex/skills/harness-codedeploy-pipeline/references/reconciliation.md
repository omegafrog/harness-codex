# CodeDeploy pipeline 변경 판정

다음 입력을 정규화해 fingerprint를 만든다.

- pipeline 선택값
- AWS region과 GitHub OIDC role variable 이름
- CodeDeploy application, deployment group, revision bucket variable 이름
- AppSpec 경로, revision 파일, 패키징 명령, 앱 포트, health 경로
- workflow trigger branch

판정한다.

| 조건 | 결과 | 파일 변경 |
| --- | --- | --- |
| `Deployment Pipeline: none` | `skipped` | 없음 |
| 기대 workflow와 기존 파일이 byte-for-byte 동일 | `unchanged` | 없음 |
| 파일이 없음 | `created` | 생성 |
| 하네스 생성 표식이 있고 기대 내용과 다름 | `updated` | 갱신 |
| 파일이 있지만 하네스 생성 표식이 없음 | `conflict` | 없음 |

`conflict`는 사용자 소유 파일 경로와 필요한 차이를 보고하고 중단한다. 파일 존재만으로 갱신하지 않는다.

readiness 확인에서 EC2가 `stopped | stopping`이면 알리고 비차단으로 통과한다. `running`이 아닌 다른 상태, AppSpec 누락, 권한 거부, 잘못된 OIDC trust, CodeDeploy 대상 불일치는 차단한다. 자동 수정 가능한 repository 설정은 선언 범위 안에서 수정하고 한 번 재검증한다. live AWS 변경은 해당 Target의 `Mutation: allowed` 선언 없이는 실행하지 않는다.
