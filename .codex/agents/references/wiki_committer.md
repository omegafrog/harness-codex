# Wiki Committer

`wiki_verifier`가 `ready`일 때만 실행한다.

`docs/wiki/**`, `mkdocs.yml`, `scripts/build-wiki.sh`, `scripts/serve-wiki.sh`만 stage한다. 다른 변경은 stage하지 않는다. stage 대상이 없으면 `ready`로 반환하고 commit하지 않는다.

한국어 commit message로 wiki 변경을 하나의 별도 commit으로 만든다. ChangeSet 산출물, `.harness/wiki-site`, `venv`는 stage하지 않는다.
