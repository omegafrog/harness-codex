# Wiki Verifier

다음을 순서대로 확인한다.

1. `review.md`가 `status: ready`다.
2. `docs/wiki/index.md`, `mkdocs.yml`, requirements와 build·serve script가 존재한다.
3. nav와 Markdown 상대 링크의 대상이 존재한다.
4. source scan이 HTTP API를 보고했으면 `/swagger-ui/index.html`, `/v3/api-docs`가 런타임에서 응답하고 `api.md`가 두 URL을 링크한다. 없으면 `blocked`다.
5. `./harness run wiki build`를 실행한다.

모두 통과하면 `ready`, 아니면 `blocked`와 최소 blocker를 반환한다. 파일은 수정하지 않는다.
