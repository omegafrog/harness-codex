import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { DOMAIN_KINDS, domainDocumentPath, formatDomainDocument, isDomainSlug, parseDomainDocument } from './schema.mjs';

const DOMAIN = 'docs/domain';

async function checkedPath(root, relative, directory = false) {
  let path = await realpath(root);
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error(`Unsafe domain path: ${relative}`);
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const info = await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (directory || index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
      throw new Error(`Unsafe domain path: ${relative}`);
    }
  }
  return path;
}

export async function readDomainFile(root, path) {
  const file = await open(await checkedPath(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Unsafe domain file: ${path}`);
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

async function entries(root, path) {
  const directory = await checkedPath(root, path, true);
  return (await readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })).sort();
}

export async function readDomainRepository(root) {
  const documents = [];
  const contexts = await entries(root, `${DOMAIN}/contexts`);
  for (const context of contexts) {
    if (!isDomainSlug(context)) throw new Error(`Invalid domain Context directory: ${context}`);
    await checkedPath(root, `${DOMAIN}/contexts/${context}`, true);
  }
  for (const { directory, owned } of Object.values(DOMAIN_KINDS)) {
    for (const parent of owned ? contexts.map((id) => `${DOMAIN}/contexts/${id}`) : [DOMAIN]) {
      const folder = `${parent}/${directory}`;
      for (const file of await entries(root, folder)) {
        if (!file.endsWith('.md')) continue;
        const path = `${folder}/${file}`;
        try {
          const original = await readDomainFile(root, path);
          const document = parseDomainDocument(original);
          if (domainDocumentPath(document.metadata) !== path) throw new Error('Path must match ID, kind and owner_context');
          documents.push({ path, ...document, original });
        } catch (error) {
          throw new Error(`${path}: ${error.message}`, { cause: error });
        }
      }
    }
  }
  return documents;
}

export function parseDomainContexts(source) {
  const contexts = new Map();
  let header = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) { header = []; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    if (cells.includes('Bounded Context')) { header = cells; continue; }
    const idColumn = header.indexOf('Context ID');
    if (idColumn < 0 || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const id = cells[idColumn]?.replace(/^`([^`]+)`$/, '$1');
    if (!id) continue;
    if (!isDomainSlug(id) || contexts.has(id)) throw new Error(`Invalid or duplicate Context ID: ${id}`);
    contexts.set(id, { name: cells[header.indexOf('Bounded Context')], responsibility: cells[header.indexOf('책임')] || '' });
  }
  return contexts;
}

export async function readDomainContextIds(root) {
  const source = await readDomainFile(root, 'CONTEXT-MAP.md').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return new Set(parseDomainContexts(source).keys());
}

export async function listDomainIndexPaths(root) {
  return ['docs/domain/INDEX.md', ...(await entries(root, 'docs/domain/contexts')).filter(isDomainSlug).map((id) => `docs/domain/contexts/${id}/INDEX.md`)];
}

export async function removeDomainIndex(root, relative) {
  if (!/^docs\/domain\/(?:contexts\/[a-z][a-z0-9-]*\/)?INDEX\.md$/.test(relative)) throw new Error('Invalid domain index path');
  await rm(await checkedPath(root, relative), { force: true });
}

export async function writeDomainDocument(root, document) {
  return writeDomainFile(root, domainDocumentPath(document.metadata), formatDomainDocument(document));
}

export async function writeDomainFile(root, relative, source) {
  const target = await checkedPath(root, relative);
  await mkdir(dirname(target), { recursive: true });
  await checkedPath(root, relative);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx');
  try {
    try { await file.writeFile(source, 'utf8'); } finally { await file.close(); }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return relative;
}
