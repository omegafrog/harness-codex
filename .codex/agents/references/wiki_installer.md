# Wiki Installer

root `venv`와 `docs/wiki/requirements.txt`가 있어야 한다. 없으면 `blocked`와 최소 blocker를 반환한다.

`./venv/bin/python3 -m pip install -r docs/wiki/requirements.txt`를 실행한다. 성공한 패키지명·버전만 요약해 반환한다. 저장소 파일을 수정하지 않는다.
