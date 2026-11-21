#!/usr/bin/env node
// Register the project's stakeholder cards (docs/domain/stakeholders/SH-xx.md).
// The cards are project-owned: this tool only writes the files, it never stages or commits them.
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { LIST_FIELDS, STAKEHOLDER_KINDS, StakeholderCardError, UNKNOWN, nextCardId, readCard, readRegistry, removeCard, writeCard } from '../../.harness/src/stakeholders/cards.mjs';

const FLAG_FIELDS = {
  '--kind': 'kind', '--role': 'role', '--authority': 'authority',
  '--goal': 'goals', '--pain-point': 'pain_points', '--constraint': 'constraints',
  '--vocabulary': 'vocabulary', '--knowledge-boundary': 'knowledge_boundary', '--evidence': 'evidence',
};
const LABELS = {
  kind: `종류 (${STAKEHOLDER_KINDS.join(' | ')}; constraint-source는 규제기관·외부 시스템처럼 persona로 실행하지 않는 제약 출처)`,
  role: '역할 (예: 모더레이터)',
  goals: '목표: 이 시스템으로 이루려는 것',
  pain_points: '현재의 불편·위험',
  constraints: '법규·정책·운영 제약',
  authority: '권한 (결정권, 거부권, 단순 사용자 등)',
  vocabulary: '이 사람이 실제로 쓰는 용어',
  knowledge_boundary: '이 사람이 모르는 것',
  evidence: '근거 (요청 원문, 문서, 인터뷰 등)',
};
const ORDER = ['kind', 'role', 'goals', 'pain_points', 'constraints', 'authority', 'vocabulary', 'knowledge_boundary', 'evidence'];

function usage() {
  return `Usage:
  node .harness/scripts/harness-stakeholder.mjs add [field flags]
  node .harness/scripts/harness-stakeholder.mjs edit <SH-id> [field flags]
  node .harness/scripts/harness-stakeholder.mjs list [--json]
  node .harness/scripts/harness-stakeholder.mjs remove <SH-id>
  node .harness/scripts/harness-stakeholder.mjs validate [--json]

Without field flags in a terminal, add and edit ask for each field.
Field flags: --kind --role --authority (one value); --goal --pain-point --constraint --vocabulary
--knowledge-boundary --evidence (repeat for several items). Global: --root <project>.
Required: role and at least one goal. Empty fields are stored as UNKNOWN or [].`;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = { command, id: null, root: null, json: false, fields: {} };
  if (['edit', 'remove'].includes(command) && args[0] && !args[0].startsWith('--')) options.id = args.shift();
  while (args.length) {
    const flag = args.shift();
    if (flag === '--json') { options.json = true; continue; }
    if (flag === '--help' || flag === '-h') { options.command = 'help'; continue; }
    const value = args.shift();
    if (value === undefined) throw new StakeholderCardError(`${flag} needs a value`);
    if (flag === '--root') { options.root = value; continue; }
    const field = FLAG_FIELDS[flag];
    if (!field) throw new StakeholderCardError(`Unknown option: ${flag}`);
    if (LIST_FIELDS.includes(field)) (options.fields[field] ||= []).push(value);
    else options.fields[field] = value;
  }
  return options;
}

function projectRoot(supplied) {
  if (supplied) return resolve(supplied);
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return process.cwd(); }
}

async function ask(current = null) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const card = { ...(current || {}) };
  try {
    for (const field of ORDER) {
      const existing = current?.[field];
      if (LIST_FIELDS.includes(field)) {
        const shown = existing?.length ? ` [현재: ${existing.join(' / ')}]` : '';
        console.log(`${LABELS[field]}${shown}\n  한 줄에 하나씩 입력하고 빈 줄로 끝냅니다.${current ? ' 바로 빈 줄이면 현재 값을 유지합니다.' : ''}`);
        const items = [];
        for (;;) {
          const line = (await rl.question('  - ')).trim();
          if (!line) break;
          items.push(line);
        }
        if (items.length || !current) card[field] = items;
      } else {
        const fallback = existing ?? (field === 'kind' ? 'person' : field === 'authority' ? UNKNOWN : '');
        const answer = (await rl.question(`${LABELS[field]}${fallback ? ` [${fallback}]` : ''}: `)).trim();
        card[field] = answer || fallback;
      }
    }
  } finally { rl.close(); }
  return card;
}

const interactive = (options) => !Object.keys(options.fields).length && process.stdin.isTTY;

function report(path, root) {
  console.log(`저장했습니다: ${path}`);
  console.log('카드는 프로젝트 소유 문서입니다. workflow worktree에서 쓰려면 이 파일을 커밋하세요.');
  console.log(`확인: git -C ${root} status --short -- docs/domain/stakeholders`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.command || options.command === 'help') { console.log(usage()); return; }
  const root = projectRoot(options.root);
  if (options.command === 'add') {
    const id = await nextCardId(root);
    let card;
    if (interactive(options)) card = { id, ...await ask() };
    else if (Object.keys(options.fields).length) card = { id, ...options.fields };
    else throw new StakeholderCardError('add needs a terminal or field flags such as --role and --goal');
    report(await writeCard(root, card, '', { create: true }), root);
    return;
  }
  if (options.command === 'edit') {
    const { card: current, notes } = await readCard(root, options.id);
    if (!interactive(options) && !Object.keys(options.fields).length) throw new StakeholderCardError('edit needs a terminal or field flags');
    const card = interactive(options) ? await ask(current) : { ...current, ...options.fields };
    report(await writeCard(root, { ...card, id: current.id }, notes), root);
    return;
  }
  if (options.command === 'remove') {
    console.log(`삭제했습니다: ${await removeCard(root, options.id)}`);
    return;
  }
  if (options.command === 'list' || options.command === 'validate') {
    const { cards, problems } = await readRegistry(root);
    if (options.json) console.log(JSON.stringify({ cards: cards.map(({ path, card }) => ({ path, ...card })), problems }, null, 2));
    else {
      if (options.command === 'list') {
        if (!cards.length) console.log('등록된 stakeholder가 없습니다. add로 등록하세요.');
        for (const { card } of cards) console.log(`${card.id}\t${card.kind}\t${card.role}\t${card.goals.join(' / ')}`);
      }
      for (const problem of problems) console.error(`형식 오류: ${problem.path}: ${problem.message}`);
      if (options.command === 'validate' && !problems.length) console.log(`카드 ${cards.length}개가 올바릅니다.`);
    }
    if (problems.length) process.exitCode = 1;
    return;
  }
  throw new StakeholderCardError(`Unknown command: ${options.command}`);
}

main().catch((error) => {
  console.error(error instanceof StakeholderCardError ? error.message : error.stack || error.message);
  if (error instanceof StakeholderCardError) console.error(usage());
  process.exitCode = error instanceof StakeholderCardError ? 2 : 1;
});
