# Harness Project Wiki Detailed Instructions

- Skill entrypoint: `.codex/skills/harness-project-wiki/SKILL.md`
- Configured agent: `wiki_curator`

## Purpose

Create or refresh a deployable MkDocs Material project wiki after implementation
verification and before the active ChangeSet is completed.

## Inputs

Required:

- `docs/changes/active/<CHG-ID>.md`
- `docs/plans/completed/<WORK-ITEM-ID>/plan.md` for every affected work item
- verification evidence named by those completed plans

Read when present:

- affected `docs/use-cases/<UC-ID>/`
- affected `docs/maintenance/<MAINT-ID>/`
- `ARCHITECTURE.md`
- `.codex/repository-settings.md`
- `README.md`
- application launch and infrastructure scripts
- existing `docs/wiki/`
- existing `mkdocs.yml`

## Workflow

1. Read the active ChangeSet and list affected work items.
2. Verify every affected plan is completed and its required verification passed.
3. Inspect implementation and tests referenced by the completed plans.
4. Compare verified behavior with existing wiki statements.
5. Create or update `docs/wiki/index.md` and focused topic pages.
6. Copy missing MkDocs baseline files from
   `.codex/skills/harness-project-wiki/assets/`, then customize site name and navigation.
7. Install `docs/wiki/requirements.txt` into the repository-root `venv`.
8. Run `./harness run wiki build`.
9. Validate links, commands, navigation, and documented file paths.
10. Report changed wiki files and any intentionally undocumented details.

## Content Contract

`docs/wiki/index.md` must contain:

- Project Overview
- User Workflows
- Architecture
- Running and Operating
- Verification
- Change History

Topic pages may include:

- `architecture.md`
- `user-workflows.md`
- `operations.md`
- bounded-context or subsystem pages when the repository warrants them

Do not create empty placeholder pages.

## MkDocs Contract

Create or maintain:

- `mkdocs.yml`
- `docs/wiki/requirements.txt`
- `scripts/build-wiki.sh`
- `scripts/serve-wiki.sh`

Baseline sources:

- `.codex/skills/harness-project-wiki/assets/mkdocs.yml`
- `.codex/skills/harness-project-wiki/assets/requirements.txt`
- `.codex/skills/harness-project-wiki/assets/build-wiki.sh`
- `.codex/skills/harness-project-wiki/assets/serve-wiki.sh`

Copy baseline files only when target files are missing. Merge required settings
into existing files instead of replacing unrelated user configuration.

`mkdocs.yml` requirements:

- `docs_dir: docs/wiki`
- `site_dir: .harness/wiki-site`
- Material theme
- built-in search
- light and dark palettes
- repository-aware site name
- explicit `nav` containing every maintained wiki page
- strict links and navigation compatible with `mkdocs build --strict`

`docs/wiki/requirements.txt`:

```text
mkdocs-material==9.7.6
```

Scripts:

- Use `./venv/bin/python3`.
- Fail with an actionable message when the root `venv` is missing.
- `build-wiki.sh` runs `python3 -m mkdocs build --strict`.
- `serve-wiki.sh` runs `python3 -m mkdocs serve`.
- Resolve repository root from the script location.
- Use `set -eu`.
- Be executable.

Harness command:

- `./harness run wiki` serves the wiki at `127.0.0.1:8000`.
- `./harness run wiki serve --dev-addr HOST:PORT` serves on an explicit address.
- `./harness run wiki build` performs the strict build.
- `./harness run wiki install` installs pinned dependencies into the root `venv`.
- Do not create a separate root-level `wiki` launcher.

Do not put generated site output in Git. `.harness/wiki-site` is runtime output.

## Update Policy

- Prefer surgical updates over full rewrites.
- Document verified current behavior, not planned or rejected behavior.
- Preserve useful manual content, custom diagrams, and external links.
- Replace stale behavior only when verified implementation contradicts it.
- Document commands exactly as verified.
- Use relative repository links.
- Keep all wiki content in English.
- Exclude secrets, credentials, raw logs, personal data, and exploit-enabling detail.

## Gate

Success requires:

- `docs/wiki/index.md` exists and is non-empty.
- `mkdocs.yml` uses `docs/wiki` and the Material theme.
- `docs/wiki/requirements.txt` pins the supported MkDocs Material version.
- build and serve scripts exist and are executable.
- Required landing-page sections exist.
- Changed commands and paths resolve in the repository.
- One Change History entry identifies `<CHG-ID>`.
- No affected work item remains active, failed, or blocked.
- `./harness run wiki build` succeeds.

On failure, do not complete the ChangeSet.
