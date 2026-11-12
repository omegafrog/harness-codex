// The Architecture Spec items a Spec reviewer must account for one by one. Reviews used to report whatever the reviewer
// noticed first, so a plan was fixed and re-reviewed once per mismatch (routes, package boundaries, schema, ...). The
// contract-defining sections of the Spec are listed here and a Spec review is accepted only when it answers every item.
export const SPEC_CONTRACT_SECTIONS = ['6.5', '6.7', '6.9', '6.11', '6.13', '9.1', '9.2', '12.7'];
const VERDICTS = new Set(['match', 'mismatch', 'not_applicable']);

// Table data rows and top-level list items under the contract sections, numbered per section.
export function extractSpecContractItems(markdown) {
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
