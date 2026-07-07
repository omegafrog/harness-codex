# Token Reduction Report

## Baseline

- `AGENTS.md` word count before compaction: 80 words.
- All markdown under `docs/` before compaction: 7754 words.
- Nested `AGENTS.md` files before compaction: none.

## Result

Root `AGENTS.md` is now a short, stable pointer file. Longer repo map, command, session, and measurement details moved to cold-path files under `.harness/docs/agent/`.

This structure keeps hot-path agent context small while preserving repository rules and making detailed context available on demand.

## 2026-07-07 워크플로우 토큰 효율 분석

- 주요 소모 지점: 모든 step prompt가 source-of-truth, workflow definition, ChangeSet payload, upstream artifact preview를 반복 포함한다. 안정 prefix 캐시가 있어도 agent가 broad scan을 수행하면 입력 토큰이 다시 증가한다.
- 감소 전략: memory/cache/graph를 prompt에 명령형으로 노출하고, step agent가 필요한 관계만 검색하게 한다.
- `memory search`: 검토된 완료 ChangeSet/decision/failure pattern을 stage 기준으로 좁혀 과거 시행착오 재독해를 줄인다.
- `memory cache`: 반복되는 미변경 파일 읽기를 snapshot 재사용으로 전환한다. 편집 후에는 원본 파일 재확인이 필요하다.
- `memory graph`: 외부 Graphify가 생성한 설계 Markdown/소스 코드 knowledge graph를 질의해 넓은 파일 스캔을 줄인다. 그래프는 검색 보조이며 source of truth가 아니다.
- 그래프 관리: build 시 source hash manifest를 저장한다. `memory graph status`는 `stale`, `changed_files`, `missing_files`, `new_files`를 표시하고, `memory graph rebuild`는 마지막 build 설정을 재사용한다.
- caveman 적용: agent chatter만 압축한다. 설계 md, PR body, 소스 코드, 코드 주석에는 적용하지 않는다.

## 권장 운영 순서

1. `python3 -m harness_codex memory graph status`
2. 그래프가 없으면 `python3 -m harness_codex memory graph build docs/design harness_codex tests --backend openai`
3. `stale=true`면 `python3 -m harness_codex memory graph rebuild`
4. 넓은 질문은 `python3 -m harness_codex memory graph query "<question>" --budget 1200`
5. 반복 파일 읽기는 `python3 -m harness_codex memory cache read <path>`
6. 과거 workflow 교훈은 `python3 -m harness_codex memory search "<query>" --limit 3`

## Verification Commands

```bash
find . -name AGENTS.md -print | sort | xargs -r wc -w
wc -w .harness/docs/agent/*.md
rg -n -P "\p{Hangul}" AGENTS.md .harness/docs/agent || true
git diff --stat
git status --porcelain=v1 -uno
```

## Final Counts

Record final counts after verification:

- `AGENTS.md`: 208 words
- `.harness/docs/agent/context.md`: 324 words
- `.harness/docs/agent/commands.md`: 283 words
- `.harness/docs/agent/session-state.md`: 127 words
- `.harness/docs/agent/token-reduction-report.md`: 136 words
