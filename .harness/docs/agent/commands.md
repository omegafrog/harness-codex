# Agent Commands

`README.md` is the public workflow contract. Use its staged commands; do not
use a parallel one-shot orchestration command.

## README Workflow

```bash
python3 -m harness_codex requirements-definition --title "<title>" --idea "<idea>"
python3 -m harness_codex ubiquitous-language-definition <CHG-ID>
python3 -m harness_codex use-case-definition <CHG-ID>
python3 -m harness_codex event-storming <CHG-ID> --uc <UC-ID>
python3 -m harness_codex ddd-architecture-definition <CHG-ID> --uc <UC-ID>
python3 -m harness_codex technical-decisions <CHG-ID> --uc <UC-ID>
python3 -m harness_codex plan-writing <CHG-ID> --uc <UC-ID> --apply
python3 -m harness_codex implementation <CHG-ID> --apply
```

Planning and implementation retain explicit modes:

```bash
python3 -m harness_codex plan-writing <CHG-ID> --uc <UC-ID> --plan
python3 -m harness_codex implementation <CHG-ID> --preview
```

`implementation` owns its internal security review, verification, remediation,
plan completion, and explicitly approved delivery. Do not invoke a separate
workflow wrapper for those tasks.

## Supporting Commands

- Full Python test gate: `./venv/bin/python3 -m pytest -q -s`
- 가벼운 버그 workflow 시작: `python3 -m harness_codex bug start --title "<title>" --symptom "<symptom>"`
- 버그 triage 갱신: `python3 -m harness_codex bug triage <BUG-ID>`
- 버그 계획 생성: `python3 -m harness_codex bug plan <BUG-ID>`
- 버그 검증 지침 확인: `python3 -m harness_codex bug verify <BUG-ID>`
- List active ChangeSets: `python3 -m harness_codex changes list`
- Show ChangeSet: `python3 -m harness_codex changes show <CHG-ID>`
- Continue the next incomplete public stage: `python3 -m harness_codex changes continue <CHG-ID> --apply`
- Show a run report: `python3 -m harness_codex report <RUN-ID>`
- Initialize target repo context: `python3 -m harness_codex init --description "<repo description>"`
- 검토된 워크플로우 메모리 검색: `python3 -m harness_codex memory search "<query>" --limit 3`
- 반복되는 미변경 파일 캐시 읽기: `python3 -m harness_codex memory cache read <path>`
- Graphify 그래프 컨텍스트 상태 확인: `python3 -m harness_codex memory graph status`
- 외부 Graphify로 설계/소스 그래프 컨텍스트 생성: `python3 -m harness_codex memory graph build docs/design harness_codex tests --backend openai`
- 마지막 build manifest 기준 그래프 재생성: `python3 -m harness_codex memory graph rebuild`
- 넓은 설계/소스 스캔 전 그래프 컨텍스트 질의: `python3 -m harness_codex memory graph query "<question>" --budget 1200`

## 토큰 효율 워크플로우 검색

검토된 과거 학습에는 `memory search`, 반복되는 미변경 파일 읽기에는 `memory cache`, 설계 Markdown과 소스 코드의 넓은 관계 질문에는 `memory graph query`를 우선 사용한다. `memory graph status`가 `stale=true`를 표시하면 step 예산이 허용될 때 `memory graph rebuild`를 먼저 실행한다. 세 결과는 검색 보조 자료로만 취급한다. 현재 소스 파일과 활성 워크플로우 산출물이 source of truth다.

## 버그 수정 Workflow

단순 버그는 전체 ChangeSet/use-case/DDD workflow를 생략한다. `harness bug start`가 `docs/maintenance/BUG-*/` 산출물을 만들고, memory/cache/graph 기반 triage를 기록한다. 정책 변경, 경계 변경, incident급 문제만 technical decision 또는 full workflow로 승격한다.

## Dashboard

- Check dashboard JavaScript syntax: `node --check harness_codex/runtime/dashboard_assets/dashboard.js`
- Check runtime dashboard modules: `python3 -m py_compile harness_codex/runtime/ui_server.py harness_codex/runtime/document_dashboard.py`
- Run dashboard server: `python3 -m harness_codex ui-server`

## Diagnostic Order

1. Use concise status commands first.
2. Use diff stats before targeted diffs.
3. Run narrow tests before full test gates when scope is small.
4. Summarize logs and failures instead of pasting full output.
5. Cap routine command output near 4k tokens.
