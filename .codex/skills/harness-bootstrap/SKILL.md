---
name: harness-bootstrap
description: Install harness-codex into another repository or reverse-engineer an existing codebase into requirements, ubiquitous language, use cases, E2E goals, event storming, DDD design, architecture, and conformance reports without implementing product code.
---

# Harness Bootstrap

Use this skill to install harness-codex or reconstruct workflow documentation
from an existing repository.

## External Installation

```bash
curl -fsSL https://raw.githubusercontent.com/omegafrog/harness-codex/main/install.sh | bash -s -- /path/to/repo
```

The target directory must already exist. Set `HARNESS_CODEX_DESCRIPTION` when a
specific project description should guide reverse engineering.

## Existing Installation

From an installed target repository, run:

```bash
./harness init --description "<project description>"
```

## Outputs

Bootstrap may generate or refresh only these documentation classes:

- `docs/design/요구사항.md`
- `context.md`
- `docs/design/유스케이스.md`
- `docs/design/이벤트 스토밍.md`
- `docs/use-cases/<UC-ID>/use-case.md`
- `docs/use-cases/<UC-ID>/e2e-goal.md`
- `docs/use-cases/<UC-ID>/event-storming.md`
- `docs/use-cases/<UC-ID>/ddd-design.md`
- `ARCHITECTURE.md`
- `docs/agent/*.md` bootstrap analysis and conformance reports

Preserve unmarked user-authored design documents. Use `--force` only to refresh
documents carrying the harness reverse-engineering marker.

## Documentation-Only Boundary

- Treat every additional prompt as evidence or context for documentation only.
- Never implement or modify product source, tests, migrations, build files,
  deployment files, runtime configuration, scripts, or generated source.
- Record implementation requests only as requirements, design notes,
  mismatches, or recommended follow-up.
- Installing managed harness runtime and `.codex` assets is allowed; changing
  target product implementation is not.
- Require a separate explicit implementation workflow for code changes.

## Verification

```bash
test -x ./harness
find .codex/skills -maxdepth 2 -name SKILL.md | sort
find docs/design docs/use-cases docs/agent -type f -name '*.md' 2>/dev/null | sort
git status --short
```
