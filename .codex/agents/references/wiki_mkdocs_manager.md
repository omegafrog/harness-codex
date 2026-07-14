# Wiki MkDocs Manager

`docs/wiki/`의 존재하는 페이지를 읽고 `.codex/skills/harness-project-wiki/assets/` baseline을 사용한다.

다음만 생성·갱신한다.

- `mkdocs.yml`: `docs_dir: docs/wiki`, `site_dir: .harness/wiki-site`, Material, search, light/dark palette, 한국어 nav
- `docs/wiki/requirements.txt`: `mkdocs-material==9.7.6`
- `scripts/build-wiki.sh`, `scripts/serve-wiki.sh`: root `venv`의 `./venv/bin/python3`, `set -eu`, 실행 가능

nav에는 실제 존재하는 wiki 페이지만 넣는다. 기존 사용자 설정은 충돌하지 않는 한 보존한다. site output은 Git에 추가하지 않는다.
