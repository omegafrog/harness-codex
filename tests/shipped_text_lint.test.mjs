import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('../.harness/internal-skills/', import.meta.url).pathname;
// Only the skills that carry the question criteria; other skills legitimately use "방문자" or "지도" (verification map).
const SKILLS = new Set(['grilling', 'stakeholder-analysis', 'stakeholder-persona', 'event-storming', 'ubiquitous-language', 'subdomain-classification', 'requirements-fix', 'requirements-gap-review', 'bounded-context']);
const BANNED = /(?<![가-힣])지도(?![가-힣]*(?:는지|인지|한지))(?:\s|를|가|에|$)|핀을|장소 목록|방문자|예약 달력/;

async function* markdown(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* markdown(path);
    else if (entry.name.endsWith('.md')) yield path;
  }
}

test('shipped GUIDE and reference text carries no example-domain words', async () => {
  const hits = [];
  for await (const path of markdown(ROOT)) {
    if (!SKILLS.has(path.slice(ROOT.length).split('/')[0])) continue;
    (await readFile(path, 'utf8')).split('\n').forEach((line, i) => {
      if (BANNED.test(line)) hits.push(`${path.slice(ROOT.length)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
