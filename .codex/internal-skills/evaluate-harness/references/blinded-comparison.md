# 스킬·workflow 비교 실험

명시적으로 A/B 효과를 비교하거나 새 지침의 채택을 판단할 때 사용한다. 기존 suite regression 실행은 이 절차와 별개다. 현재 `harness-eval`의 case/run 경로와 raw trajectory는 평가 맥락을 드러낼 수 있으므로 그대로 실행하고 blind 실험이라고 부르지 않는다.

## 실험 계약

- 실제 사용자 과제와 성공 기준을 먼저 고정한다. rubric, 변형 이름, 모델 이름과 대응표는 coordinator만 볼 수 있는 작업 공간 밖 위치에 둔다. 모든 조건에 같은 입력·작업 한도·관련 프로젝트 상태를 사용한다.
- 후보별로 분리한 중립 프로젝트 경로를 사용한다. 후보에게 보이는 prompt/파일명/디렉터리/환경/fixture Git history에 비교 라벨, rubric, baseline/candidate/model 식별자 또는 실험 지시를 넣지 않는다. 일반 프로젝트가 원래 가진 test 파일을 지워 현실성을 해치지는 않는다. 숨겨야 하는 것은 실험 metadata다.
- Harness workflow 자체의 과제라 `$spec-me` 같은 실제 entrypoint와 프로젝트 고유 파일은 유지한다. “어느 원칙/스킬을 따랐는지 나열”하도록 요청하지 않고 실제 변경·도구 호출·산출물로 수행을 판정한다.
- 시작 전에 후보가 읽을 수 있는 경로와 prompt를 확인한다. coordinator 결과 저장소나 다른 후보 작업 공간을 읽을 수 있으면 접근 경계를 분리한다. 분리할 수 없으면 `non-blind`로 명시하고 편향 제한을 보고한다. 권한·보안 profile은 완화하지 않는다.

## 실행·심사

프로젝트의 기존 isolated execution 방법으로 같은 과제를 각 조건에서 수행한다. 필요한 실행 agent는 기존 caller/runtime model policy를 따르고 새로운 고정 모델 이름을 도입하지 않는다. 호출 수·비용·실행 시간은 현재 사용자 승인 범위 안으로 제한한다.

coordinator는 산출물과 실제 source/tool 증거를 읽고, 심사용 bundle에 과제·rubric·필요한 diff/결과/증거만 넣는다. variant→익명 라벨 대응표, 모델/config/run 이름, 절대 실행 경로 및 신원 metadata는 제거하고 semantic 내용은 유지한다. 원본 증거는 별도로 보존한다. 내용 자체가 신원을 밝히면 은닉 한계를 기록한다.

같은 고정 judge/rubric으로 익명 조건들을 함께 비교하고 표시 순서를 바꿔 순서 편향을 확인한다. judge와 구현 모델이 같거나 다른 family를 쓸 수 없는 경우 그 한계를 공개한다. hard-gate/기능 실패는 품질 점수와 별도이며 높은 점수로 상쇄하지 않는다. 원칙 준수는 자기 보고 대신 실제 파일 읽기·코드 구조·검증 행동으로 판정한다.

## 결과

judge 판정과 coordinator의 원본 대조를 함께 제시한다. 조건 공개는 심사 뒤에 한다. 실행 수·환경·은닉 확인·표시 순서·요구사항별 결과·실패·비용·제한을 남긴다. 수치 비교는 [measurement.md](measurement.md)를 따른다. 한 번의 긍정 사례를 일반 개선으로 주장하지 않는다. baseline 승격과 workflow 배포는 기존 승인 범위를 따른다.

출처 아이디어: [pstack eval playbook](https://github.com/backnotprop/pstack/blob/6f131f137de64fdaf928278c0fd9ecec520ccbee/skills/poteto-mode/playbooks/eval.md).
