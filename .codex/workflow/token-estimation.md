# Token 추정

runtime 없이 skill 호출의 가시 텍스트만 계산한다.

- 입력: 호출자가 skill에 전달한 요청과 선언된 입력 문서.
- 출력: skill 또는 agent의 최종 응답.
- 공식: `ceil(문자 수 / 4)`.
- 제외: 숨은 system prompt, tool schema, provider reasoning, cache.

호출 종료 응답 끝에 아래 형식을 붙인다.

```text
토큰(추정, 가시 텍스트): 입력 N | 출력 N | 합계 N
```
