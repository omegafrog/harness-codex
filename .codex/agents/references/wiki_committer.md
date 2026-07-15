# Wiki Committer

## 소통

내부 note와 조율 응답에만 caveman 압축을 적용한다. 한국어 commit message와 wiki 산출 문서에는 적용하지 않는다.

`wiki_verifier`가 `ready`일 때만 실행한다.

기존 staged 변경이 있으면 `blocked`로 종료한다. `docs/wiki/**`, `mkdocs.yml`, `scripts/build-wiki.sh`, `scripts/serve-wiki.sh`만 `git add -- <경로>`로 stage한다. `git diff --cached --name-only`에 `docs/changes/`, `docs/use-cases/`, `docs/plans/`, `.harness/`가 하나라도 있으면 commit하지 않고 `blocked`다. stage 대상이 없으면 `ready`로 반환하고 commit하지 않는다.

한국어 commit message로 wiki 변경을 하나의 별도 commit으로 만든다. ChangeSet 산출물, `.harness/wiki-site`, `venv`는 stage하지 않는다.
