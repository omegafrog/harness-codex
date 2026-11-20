// Legacy Architecture Spec items are retained for reviewing old plan sets. Current tactical design items are extracted
// from the BC-oriented template below. A Spec review is accepted only when it answers every extracted item.
export const SPEC_CONTRACT_SECTIONS = ['6.5', '6.7', '6.9', '6.11', '6.13', '9.1', '9.2', '12.7'];
const VERDICTS = new Set(['match', 'mismatch', 'not_applicable']);

// Table data rows and top-level list items under the contract sections, numbered per section.
export function extractSpecContractItems(markdown) {
  if (/<!--\s*tactical-design:\s*context-components-v1\s*-->/.test(markdown)) return extractTacticalDesignItems(markdown);
  const items = [];
  let active = null, level = 0, count = 0, tableRow = 0;
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = /^(#{1,6})\s+(\d+(?:\.\d+)?)\.?(?:\s|$)/.exec(line) || /^(#{1,6})\s+/.exec(line);
    if (heading) {
      const number = /^(#{1,6})\s+(\d+(?:\.\d+)?)\.?(?:\s|$)/.exec(line)?.[2] || null;
      const depth = heading[1].length;
      if (number && SPEC_CONTRACT_SECTIONS.includes(number)) { active = number; level = depth; count = 0; }
      else if (active && depth <= level) active = null;
      tableRow = 0;
      continue;
    }
    if (!active) continue;
    if (/^\s*\|/.test(line)) {
      tableRow += 1;
      const cells = line.trim();
      if (/^\|?\s*:?-{2,}/.test(cells.replace(/\|/g, '|').replace(/^\|\s*/, ''))) { tableRow = Math.max(tableRow, 2); continue; }
      if (tableRow <= 2 && !/^\|[\s:|-]+\|?$/.test(cells) && lines[index + 1] && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[index + 1])) continue; // header row
      if (/^\s*\|[\s:|-]+\|?\s*$/.test(line)) continue;
      count += 1;
      items.push({ id: `S${active}-${count}`, section: active, line: index + 1, text: cells.replace(/\s+/g, ' ').slice(0, 220) });
    } else {
      tableRow = 0;
      if (/^[-*]\s+\S/.test(line)) {
        count += 1;
        items.push({ id: `S${active}-${count}`, section: active, line: index + 1, text: line.trim().replace(/\s+/g, ' ').slice(0, 220) });
      }
    }
  }
  return items;
}

// Current plan sets use requirements.md plus a BC-oriented tactical-design.md, not numbered Architecture Spec sections.
// Give every substantive line in a bounded-context section a stable-in-document checklist ID so the Spec reviewer checks
// the actual settled design rows and prose. Legacy numbered Specs continue through the extractor above.
export function extractTacticalDesignItems(markdown) {
  const items = [];
  let inContext = false;
  for (const [index, raw] of markdown.split('\n').entries()) {
    const line = raw.trim();
    if (/^#{1,2}\s+BC\s+\S/.test(line) || /^##\s+[1-7]\.\s+/.test(line)) inContext = true;
    else if (/^#{1,2}\s+/.test(line) && !/^#{3,}\s+/.test(line)) inContext = false;
    if (!inContext || !line || line.startsWith('<!--') || /^#{1,6}\s/.test(line) || /^```/.test(line)) continue;
    if (/^\|[\s:|\-]+\|?$/.test(line)) continue;
    if (/^\|/.test(line) && /^\|?\s*:?-{2,}/.test(line.replace(/^\|\s*/, ''))) continue;
    if (/^\|/.test(line) && /^\s*\|[\s:|\-]+\|?\s*$/.test(markdown.split('\n')[index + 1] || '')) continue;
    items.push({ id: `TD-${String(items.length + 1).padStart(4, '0')}`, section: 'tactical-design', line: index + 1, text: line.replace(/\s+/g, ' ').slice(0, 220) });
  }
  return items;
}

// A Spec review must answer every listed item, give evidence for each answer, and attach a finding to each mismatch.
export function assertSpecCoverage(items, report) {
  if (!items.length) return;
  const checked = Array.isArray(report?.checked) ? report.checked : null;
  if (!checked) throw new Error(`The Spec reviewer must return report.checked for the ${items.length} Spec items (run harness-code-review.mjs spec-items)`);
  const known = new Set(items.map((item) => item.id));
  const seen = new Map();
  for (const entry of checked) {
    if (!known.has(entry?.id)) throw new Error(`Spec review checked ${entry?.id ?? '(no id)'}, which is not a listed Spec item`);
    if (!VERDICTS.has(entry.verdict)) throw new Error(`Spec item ${entry.id} needs a verdict of match, mismatch or not_applicable`);
    if (typeof entry.evidence !== 'string' || !entry.evidence.trim()) throw new Error(`Spec item ${entry.id} needs evidence (file:line, or why it does not apply)`);
    seen.set(entry.id, entry);
  }
  const missing = items.filter((item) => !seen.has(item.id)).map((item) => item.id);
  if (missing.length) throw new Error(`The Spec reviewer did not answer ${missing.length} of ${items.length} Spec items (${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''}); run the Spec review again and answer every item`);
  const cited = new Set((report.findings || []).flatMap((finding) => Array.isArray(finding.spec_items) ? finding.spec_items : []));
  const orphan = [...seen.values()].filter((entry) => entry.verdict === 'mismatch' && !cited.has(entry.id)).map((entry) => entry.id);
  if (orphan.length) throw new Error(`Spec items marked mismatch have no finding that lists them in spec_items: ${orphan.join(', ')}`);
}
