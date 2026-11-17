// Shared fixtures of the tactical design tests: the requirements that the template's example document answers to, and
// the example itself, cut the way each stage leaves it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TACTICAL_DESIGN_STAGES } from '../../.harness/src/workflow/worktree-stages.mjs';

// The requirements the template's example document answers to.
export const REQUIREMENTS = `# 요구사항 명세

- 상태: fixed

## 2. 업무

### BIZ-01 게시글 작성 (SD-01)

- 상태: fixed
- 업무 규칙:
  - INV-01 본문은 최대 5,000자다 — 출처: answers.json \`q-length\`
- 예외 시나리오:
  - EX-01 로그인하지 않은 방문자가 올리면 작성이 거절된다 — 출처: CAND-02 채택
- 완료 조건:
  - AC-01 올린 글이 목록의 맨 위에 보인다 — 출처: 요청 해석(에이전트 제안)

### BIZ-02 게시글 삭제 (SD-01)

- 업무 규칙:
  - INV-02 게시글은 작성자만 삭제할 수 있다 — 출처: 요청 원문
  - INV-03 게시글이 삭제되면 그 글의 미처리 신고를 닫는다 — 출처: answers.json \`q-report\`

### BIZ-03 신고 접수 (SD-02)

- 업무 규칙:
  - INV-04 한 회원은 같은 게시글을 한 번만 신고할 수 있다 — 출처: CAND-03 채택

### BIZ-04 로그인 (SD-03)

- 업무 규칙: 없음
`;

export async function templateDocument(sourceRoot) {
  const template = await readFile(join(sourceRoot, '.codex/internal-skills/domain-model/references/template.md'), 'utf8');
  const document = [...template.matchAll(/````markdown\n([\s\S]*?)\n````/g)].map((match) => match[1]).find((block) => block.startsWith('# 전술 설계'));
  assert.ok(document, 'the template carries the document shape');
  return document;
}

// The document as the stage at `level` leaves it: its own section and the earlier ones, and the decision rows of those stages only.
const levelOf = (stage) => TACTICAL_DESIGN_STAGES.indexOf(stage) + 1;
export const upTo = (document, level) => document.split(/^(?=## \d+\.)/m)
  .filter((part) => !/^## \d+\./.test(part) || Number(part.match(/^## (\d+)\./)[1]) <= level || part.startsWith('## 6.'))
  .join('')
  .split('\n')
  .filter((line) => !/^\| DEC-\d+ \|/.test(line) || levelOf(line.split('|')[2].trim()) <= level)
  .join('\n');

// A bounded context without a state lifecycle: the calculation request and result are Value Objects, so no Aggregate exists
// and the Value Object enforces both rules.
export const STATELESS_REQUIREMENTS = `# 요구사항 명세

- 상태: fixed

## 2. 업무

### BIZ-01 사칙연산 계산 (SD-01)

- 상태: fixed
- 업무 규칙:
  - INV-01 더하기, 빼기, 곱하기, 나누기 네 가지만 지원한다 — 출처: 요청 원문
- 예외 시나리오:
  - EX-02 0으로 나누면 계산이 거절된다 — 출처: 요청 원문
- 완료 조건:
  - AC-01 계산 결과가 화면에 보인다 — 출처: 요청 원문
`;

export const STATELESS_DOCUMENT = `# 전술 설계

- plan set: \`calculator\`
- requirements: \`requirements.md\` (같은 디렉터리, \`상태: fixed\`)

## 1. 모델 후보

### 1.1 기존 모델 조사

기존 모델 없음 — docs/architecture/domain-model.md가 없다

### 1.2 모델링 깊이

| BC | SD | 분류 | 모델링 깊이 | 근거 |
|---|---|---|---|---|
| 계산기 | SD-01 | supporting | 규칙에 필요한 것만 | 사칙연산 규칙(INV-01, EX-02)만 모델이 필요하다 |

### 1.3 모델

| 모델 | 종류 | BC | 정체성·생애주기 또는 값의 의미 | 현재 상태 | 근거 |
|---|---|---|---|---|---|
| 계산 요청 | Value Object | 계산기 | 피연산자와 연산자의 조합이다. 같은 조합이면 같은 요청이다 | accepted-target | BIZ-01, INV-01, EX-02 |
| 계산 결과 | Value Object | 계산기 | 계산해 낸 숫자다. 같은 숫자면 같은 결과다 | accepted-target | BIZ-01 |

### 1.4 요구 매핑

| 요구 | BC | 소유 모델 | 근거 |
|---|---|---|---|
| BIZ-01 | 계산기 | 계산 요청, 계산 결과 | 요청을 만들어 결과를 낸다 |
| INV-01 | 계산기 | 계산 요청 | 지원하는 연산자는 요청의 값이 정한다 |
| EX-02 | 계산기 | 계산 요청 | 0으로 나누는 요청은 값이 만들어질 때 거절된다 |

## 2. Aggregate

### 2.1 Aggregate

| Aggregate | BC | Root | 정체성 | 구성원 | 주요 행위 | 다른 Aggregate 참조 |
|---|---|---|---|---|---|---|

| BC | Aggregate 없음 사유 |
|---|---|
| 계산기 | 상태와 생애주기가 없다. 계산 요청과 결과는 값으로만 존재한다 |

### 2.2 규칙 강제

| 요구 | Aggregate | 강제 행위 | 일관성 범위 |
|---|---|---|---|
| INV-01 | - | Value Object: 계산 요청.생성() | 값 안 |
| EX-02 | - | Value Object: 계산 요청.생성() | 값 안 |

### 2.3 일관성 결정

| CON | 규칙 | 걸친 Aggregate | 일관성 | 결정 | 근거·출처 |
|---|---|---|---|---|---|

## 3. Domain Service

해당 없음 — 두 규칙을 모두 계산 요청 값이 강제한다

## 4. Application Service

| AS | 이름 | BC | 업무 | 호출 순서 | 트랜잭션 경계 | Repository | 외부 효과 |
|---|---|---|---|---|---|---|---|
| AS-01 | 계산 | 계산기 | BIZ-01 | 계산 요청 만들기 → 계산 결과 만들기 | 없음 — 저장하지 않고 Aggregate를 바꾸지 않는다 | 없음 | 없음 |

## 5. 통합 설계

해당 없음 — 컨텍스트 하나다

## 6. 결정 이력

| DEC | stage | 대상 | 결정 | 비교한 대안 | 출처 |
|---|---|---|---|---|---|
| DEC-01 | domain-model | 계산 요청 | Value Object로 둔다 | Entity | BIZ-01, INV-01 |
| DEC-02 | aggregate-design | 계산기 | Aggregate를 만들지 않고 Value Object가 규칙을 강제한다 | 계산 Aggregate | INV-01, EX-02 |
| DEC-03 | domain-service | - | 해당 없음으로 둔다 | - | INV-01, EX-02 |
| DEC-04 | application-service | AS-01 | 저장 없는 사용 사례로 둔다 | 계산 기록 저장 | BIZ-01 |
| DEC-05 | integration-design | - | 컨텍스트가 하나라 통합이 없다 | - | BIZ-01 |
`;

// The shape of a real calculator-and-community plan set: a Value Object context with no Aggregate (`Value Object: <모델>`
// without a method), an authentication Aggregate that the community Aggregate only reads (`조회 전용 Aggregate`, `즉시`, never
// merged), a 2.2 row that lists only the Aggregate the rule changes, and a section 5 that records the synchronous check.
export const READ_ONLY_REQUIREMENTS = `# 요구사항 명세

- 상태: fixed

## 2. 업무

### BIZ-01 계산기 이용 (SD-01)

- 업무 규칙:
  - INV-01 계산기 이용은 덧셈·뺄셈·곱셈·나눗셈을 지원한다 — 출처: answers.json \`q-ops\`
- 예외 시나리오:
  - EX-02 0으로 나누면 계산을 완료하지 않는다 — 출처: answers.json \`q-zero\`

### BIZ-02 사용자 인증 (SD-02)

- 업무 규칙:
  - INV-03 사용자는 이메일과 비밀번호로 가입하고 로그인한다 — 출처: answers.json \`q-auth\`
- 예외 시나리오:
  - EX-01 인증 실패 시 비인증 상태를 유지한다 — 출처: answers.json \`q-fail\`

### BIZ-03 커뮤니티 글 읽기 (SD-03)

- 예외 시나리오:
  - EX-03 비인증 사용자의 읽기는 허용되지 않는다 — 출처: CAND-01 채택

### BIZ-04 커뮤니티 글 작성·수정·삭제 (SD-03)

- 업무 규칙:
  - INV-02 커뮤니티 글은 본문만 가진다 — 출처: answers.json \`q-body\`
- 예외 시나리오:
  - EX-04 비인증 사용자의 작성·수정·삭제는 허용되지 않는다 — 출처: CAND-01 채택
  - EX-05 작성자가 아니면 수정·삭제할 수 없다 — 출처: CAND-01 채택
`;

export const READ_ONLY_DOCUMENT = `# 도메인 모델

- plan set: \`calculator-community\`
- requirements: \`requirements.md\` (같은 디렉터리, \`상태: fixed\`)

## 1. 모델 후보

### 1.3 모델

| 모델 | 종류 | BC | 정체성·생애주기 또는 값의 의미 | 현재 상태 | 근거 |
|---|---|---|---|---|---|
| 계산기 이용 | Value Object | 계산 | 한 번의 사칙연산 요청과 결과다 | accepted-target | BIZ-01, INV-01, EX-02 |
| 사용자 | Entity | 사용자 인증 | 인증 상태 전이를 가진다 | accepted-target | BIZ-02, INV-03, EX-01 |
| 커뮤니티 글 | Entity | 커뮤니티 | 글 ID로 구분한다 | accepted-target | BIZ-03, BIZ-04 |

### 1.4 요구 매핑

| 요구 | BC | 소유 모델 | 근거 |
|---|---|---|---|
| BIZ-01 | 계산 | 계산기 이용 | 사칙연산 이용을 값으로 표현한다 |
| INV-01 | 계산 | 계산기 이용 | 지원 연산 범위는 값의 의미다 |
| EX-02 | 계산 | 계산기 이용 | 0으로 나누면 결과 대신 계산 불가 상태다 |
| 이벤트: 사칙연산이 수행되었다 | 계산 | 계산기 이용 | BIZ-01 이벤트 흐름 |
| BIZ-02 | 사용자 인증 | 사용자 | 가입과 로그인은 인증 상태를 전이시킨다 |
| INV-03 | 사용자 인증 | 사용자 | 가입과 로그인은 사용자 업무다 |
| EX-01 | 사용자 인증 | 사용자 | 실패 뒤 비인증 상태를 유지한다 |
| BIZ-03 | 커뮤니티 | 커뮤니티 글 | 읽기 대상이다 |
| BIZ-04 | 커뮤니티 | 커뮤니티 글 | 작성·수정·삭제는 글의 상태를 바꾼다 |
| INV-02 | 커뮤니티 | 커뮤니티 글 | 글은 본문만 가진다 |
| EX-03 | 커뮤니티 | 커뮤니티 글 | 비인증 읽기는 거부된다 |
| EX-04 | 커뮤니티 | 커뮤니티 글 | 비인증 작성·수정·삭제는 거부된다 |
| EX-05 | 커뮤니티 | 커뮤니티 글 | 작성자가 아니면 거부된다 |

## 2. Aggregate

### 2.1 Aggregate

| Aggregate | BC | Root | 정체성 | 구성원 | 주요 행위 | 다른 Aggregate 참조 |
|---|---|---|---|---|---|---|
| 사용자 | 사용자 인증 | 사용자 | 사용자 ID | 사용자 | \`사용자.가입()\`, \`사용자.로그인()\` | 없음 |
| 커뮤니티 글 | 커뮤니티 | 커뮤니티 글 | 글 ID | 커뮤니티 글 | \`커뮤니티 글.인증된 사용자 확인()\`, \`커뮤니티 글.작성()\`, \`커뮤니티 글.수정()\`, \`커뮤니티 글.삭제()\` | 작성자는 사용자 ID로만 참조한다 |

| BC | Aggregate 없음 사유 |
|---|---|
| 계산 | 계산기 이용은 별도 생애주기가 없는 Value Object이므로 Aggregate가 없다 |

### 2.2 규칙 강제

| 요구 | Aggregate | 강제 행위 | 일관성 범위 |
|---|---|---|---|
| INV-01 | - | Value Object: 계산기 이용 | Aggregate 없음 |
| EX-02 | - | Value Object: 계산기 이용 | Aggregate 없음 |
| INV-03 | 사용자 | \`사용자.가입()\`, \`사용자.로그인()\` | Aggregate 안 |
| EX-01 | 사용자 | \`사용자.로그인()\` | Aggregate 안 |
| INV-02 | 커뮤니티 글 | \`커뮤니티 글.작성()\`, \`커뮤니티 글.수정()\` | Aggregate 안 |
| EX-03 | 커뮤니티 글 | \`커뮤니티 글.인증된 사용자 확인()\` | CON-01 |
| EX-04 | 커뮤니티 글 | \`커뮤니티 글.인증된 사용자 확인()\` | CON-01 |
| EX-05 | 커뮤니티 글 | \`커뮤니티 글.수정()\`, \`커뮤니티 글.삭제()\` | Aggregate 안 |
| 이벤트: 인증 성공 수신 | 커뮤니티 글 | \`커뮤니티 글.인증된 사용자 확인()\` | CON-01 |

### 2.3 일관성 결정

| CON | 규칙 | 걸친 Aggregate | 조회 전용 Aggregate | 일관성 | 결정 | 근거·출처 |
|---|---|---|---|---|---|---|
| CON-01 | EX-03, EX-04, 이벤트: 인증 성공 수신 | 사용자, 커뮤니티 글 | 사용자 | 즉시 | 분리: 요청마다 인증 상태를 동기 확인한다. 사용자 Aggregate는 읽기만 한다 | requirements.md BIZ-03, EX-03, EX-04; CONTEXT-MAP.md \`## 3\` |

## 3. Domain Service

해당 없음 — §2.2에서 Domain Service로 넘긴 규칙이 없다

## 4. Application Service

| AS | 이름 | BC | 업무 | 호출 순서 | 트랜잭션 경계 | Repository | 외부 효과 |
|---|---|---|---|---|---|---|---|
| AS-01 | 계산기 이용 | 계산 | BIZ-01 | 계산기 이용 → 결과 반환 | 없음 — 계산은 상태 없는 Value Object 연산이다 | 없음 | 없음 |
| AS-02 | 사용자 가입 | 사용자 인증 | BIZ-02 | 사용자.가입() → 저장 | T1: 사용자 | 사용자 | 없음 |
| AS-03 | 커뮤니티 글 읽기 | 커뮤니티 | BIZ-03 | 사용자 인증 동기 확인 → 커뮤니티 글.인증된 사용자 확인() | 없음 — 조회로 Aggregate 상태를 바꾸지 않는다 | 사용자, 커뮤니티 글 | 없음 |
| AS-04 | 커뮤니티 글 수정 | 커뮤니티 | BIZ-04 | 불러오기 → 사용자 인증 동기 확인 → 커뮤니티 글.수정() → 저장 | T1: 커뮤니티 글 (변경 시) | 사용자, 커뮤니티 글 | 수정 이벤트 |

## 5. 통합 설계

| INT | 상류 BC | 하류 BC | 명령 | 응답 | 이벤트 | 통신 방식 | 일관성 결정 | Saga·Outbox | 근거·출처 |
|---|---|---|---|---|---|---|---|---|---|
| INT-01 | 사용자 인증 | 커뮤니티 | 없음 | 인증 상태와 사용자 ID | 없음 | 동기 확인 | CON-01 | 없음 — 요청마다 현재 상태를 읽는다 | CONTEXT-MAP.md \`## 3\` |
`;
