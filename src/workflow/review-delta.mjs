import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sessionOutputPath } from './session-output.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

function sections(text) {
  const parts = []; let current = '', fence = null;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker && (!fence || marker[1][0] === fence[0] && marker[1].length >= fence.length)) fence = fence ? null : marker[1];
    if (!fence && /^#{1,6}\s/.test(line)) { if (current) parts.push(current); current = ''; }
    current += line;
  }
  if (current) parts.push(current);
  const seen = new Set(), result = new Map();
  for (const part of parts) {
    if (!part) continue;
    const heading = part.match(/^#{1,6}\s+[^\n]*/)?.[0] || '(preamble)';
    if (seen.has(heading)) return null;
    seen.add(heading);
    result.set(heading, part);
  }
  return result;
}

// Full input hashes remain the admission and completion gate; this only narrows reviewer reading.
export async function reviewDelta({ root, inputs, previousInputs }) {
  const changed = [];
  for (const [path, hash] of Object.entries(inputs)) {
    const content = await readFile(resolve(root, path));
    if (digest(content) !== hash) throw new Error(`Review input changed during admission: ${path}`);
    const cache = sessionOutputPath(root, `runtime/reviews/content/${hash}`);
    try { await writeFile(cache, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!previousInputs || previousInputs[path] === hash) continue;
    let previous;
    try { previous = await readFile(sessionOutputPath(root, `runtime/reviews/content/${previousInputs[path]}`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!previous || digest(previous) !== previousInputs[path] || !path.endsWith('.md')) {
      changed.push({ path, scope: 'full_file', reason: 'Prior content unavailable or not Markdown' });
      continue;
    }
    const before = sections(previous.toString('utf8')), after = sections(content.toString('utf8'));
    if (!before || !after) {
      changed.push({ path, scope: 'full_file', reason: 'Ambiguous repeated headings' });
      continue;
    }
    const headings = [...new Set([...before.keys(), ...after.keys()])];
    changed.push({ path, scope: 'sections', sections: headings.filter((heading) => before.get(heading) !== after.get(heading)).map((heading) => ({ heading, before: before.get(heading) ?? null, after: after.get(heading) ?? null })) });
  }
  if (previousInputs) for (const [path, hash] of Object.entries(previousInputs)) if (!(path in inputs)) {
    let prior;
    try { prior = await readFile(sessionOutputPath(root, `runtime/reviews/content/${hash}`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    changed.push({ path, scope: 'removed_file', before: prior && digest(prior) === hash ? prior.toString('utf8') : null });
  }
  return { mode: previousInputs ? 'incremental' : 'full', changed };
}
