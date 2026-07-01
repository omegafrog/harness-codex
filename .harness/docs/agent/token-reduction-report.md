# Token Reduction Report

## Baseline

- `AGENTS.md` word count before compaction: 80 words.
- All markdown under `docs/` before compaction: 7754 words.
- Nested `AGENTS.md` files before compaction: none.

## Result

Root `AGENTS.md` is now a short, stable pointer file. Longer repo map, command, session, and measurement details moved to cold-path files under `.harness/docs/agent/`.

This structure keeps hot-path agent context small while preserving repository rules and making detailed context available on demand.

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
