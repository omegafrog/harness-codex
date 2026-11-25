// References a stage reads on every run, inlined into the Claude worker prompt as `<reference path="...">` blocks so the worker
// spends no call reading them. Only references a GUIDE always needs are listed; conditional ones (legacy templates, diagram
// rules a stage draws only sometimes) and the persona card/contract (passed to the persona by path) stay on disk.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_INLINED_REFERENCE_BYTES = 24 * 1024;
const SKILLS = '.harness/internal-skills';
const REQUIREMENTS_TEMPLATE = `${SKILLS}/requirements-fix/references/template.md`;
const COVERAGE = `${SKILLS}/requirements-fix/references/coverage.md`;
const DEEPENING = `${SKILLS}/domain-model/references/deepening.md`;
const TACTICAL_TEMPLATE = `${SKILLS}/domain-model/references/template.md`;
// `shallow` ends the section at the next heading of any level (the requirements header sits above the numbered sections).
const header = { heading: '^# 요구사항 명세', shallow: true };
const rules = '^## 작성 규칙';
const requirements = (...sections) => ({ path: REQUIREMENTS_TEMPLATE, sections: [rules, ...sections] });
const tactical = [{ path: DEEPENING }, { path: TACTICAL_TEMPLATE, omit: ['^## 구형 문서'] }];

export const STAGE_REFERENCES = {
  'stakeholder-analysis': [{ path: `${SKILLS}/stakeholder-analysis/references/output-template.md` }, requirements(header, '^### 요구사항 초안')],
  'subdomain-candidates': [requirements('^## 1\\. 서브도메인', '^### 요구사항 초안', '^### BIZ-01')],
  'ubiquitous-language': [requirements('^## 3\\. 용어')],
  'event-storming': [requirements('^### BIZ-01', '^## 4\\.', '^## 5\\.'), { path: `${SKILLS}/event-storming/references/diagrams.md` }],
  'subdomain-classification': [requirements('^## 1\\. 서브도메인')],
  'requirements-fix': [requirements('^## 2\\. 업무', '^## 6\\. 공통'), { path: COVERAGE }],
  'bounded-context': [requirements('^### 1\\.1 바운디드 컨텍스트'), { path: COVERAGE }],
  'domain-model': tactical,
  'aggregate-design': tactical,
  'domain-service': tactical,
  'application-service': tactical,
  'integration-design': tactical,
  'context-boundary': tactical,
};

const headingOf = (line) => { const match = /^(#{1,6})[ \t]+\S/.exec(line); return match ? match[1].length : 0; };

// Headings inside code fences count too: the templates draw the document shape in a fence.
// A section runs from a matching heading to the next heading of the same or a higher level (any level when `shallow`).
// Patterns that match nothing, or no pattern at all, keep the whole file so nothing is lost; `omit` then drops sections.
export function extractSections(text, sections = [], omit = []) {
  const lines = String(text).split('\n');
  const levels = lines.map(headingOf);
  const select = (patterns) => {
    const keep = new Set();
    for (const entry of patterns) {
      const { heading, shallow = false } = typeof entry === 'string' ? { heading: entry } : entry;
      const pattern = new RegExp(heading);
      for (let i = 0; i < lines.length; i += 1) {
        if (!levels[i] || !pattern.test(lines[i])) continue;
        let end = i + 1;
        while (end < lines.length && !(levels[end] && (shallow || levels[end] <= levels[i]))) end += 1;
        for (let j = i; j < end; j += 1) keep.add(j);
      }
    }
    return keep;
  };
  let kept = select(sections);
  if (!kept.size) kept = new Set(lines.keys());
  for (const index of select(omit)) kept.delete(index);
  const out = [];
  let gap = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!kept.has(i)) { gap = out.length > 0; continue; }
    if (gap) out.push('…');
    gap = false;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

// -> the `<reference>` block lines of a stage; [] when the stage has none, a file is missing, or the total would pass the cap.
export function referenceBlocks(root, stage, { limit = MAX_INLINED_REFERENCE_BYTES } = {}) {
  const blocks = [];
  let bytes = 0;
  for (const { path, sections, omit } of STAGE_REFERENCES[stage] ?? []) {
    const file = join(root, path);
    if (!existsSync(file)) continue;
    const body = extractSections(readFileSync(file, 'utf8'), sections, omit);
    bytes += Buffer.byteLength(body);
    blocks.push(`<reference path="${path}">`, body, '</reference>');
  }
  return bytes > limit ? [] : blocks;
}
