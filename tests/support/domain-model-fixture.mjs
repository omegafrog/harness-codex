// Shared fixtures of the tactical design tests: the requirements that the template's example document answers to, and
// the example itself, cut the way each stage leaves it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TACTICAL_STAGE_LEVEL } from '../../.codex/scripts/harness-domain-model-check.mjs';

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
  const document = [...template.matchAll(/````markdown\n([\s\S]*?)\n````/g)].map((match) => match[1]).find((block) => block.startsWith('# 도메인 모델'));
  assert.ok(document, 'the template carries the document shape');
  return document;
}

// The document as the stage at `level` leaves it: its own section and the earlier ones, and the decision rows of those stages only.
export const upTo = (document, level) => document.split(/^(?=## \d+\.)/m)
  .filter((part) => !/^## \d+\./.test(part) || Number(part.match(/^## (\d+)\./)[1]) <= level || part.startsWith('## 6.'))
  .join('')
  .split('\n')
  .filter((line) => !/^\| DEC-\d+ \|/.test(line) || TACTICAL_STAGE_LEVEL[line.split('|')[2].trim()] <= level)
  .join('\n');
