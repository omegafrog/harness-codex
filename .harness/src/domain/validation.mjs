import { readRegistry } from '../stakeholders/cards.mjs';
import { readDomainContextIds, readDomainRepository } from './repository.mjs';

const TYPED_REFERENCES = { actors: 'actor', rules: 'rule', trigger_events: 'event', events: 'event' };

export function validateDomainGraph(documents, contextIds, stakeholderIds = new Set()) {
  const definitions = new Map();
  for (const { metadata: item } of documents) {
    if (definitions.has(item.id)) throw new Error(`Duplicate domain ID: ${item.id}`);
    definitions.set(item.id, item);
  }
  for (const item of definitions.values()) {
    for (const id of [...(item.contexts || []), ...(item.owner_context ? [item.owner_context] : [])]) {
      if (!contextIds.has(id)) throw new Error(`${item.id}: unknown Context ID ${id}`);
    }
    for (const id of item.references) {
      const target = definitions.get(id);
      if (!target && !stakeholderIds.has(id)) throw new Error(`${item.id}: unknown reference ${id}`);
      if (target?.status === 'retired' && item.status !== 'retired') throw new Error(`${item.id}: active reference to retired definition ${id}`);
    }
    for (const [field, kind] of Object.entries(TYPED_REFERENCES)) {
      for (const id of item[field] || []) {
        const target = definitions.get(id);
        if (target?.kind !== kind || (item.status !== 'retired' && target.status === 'retired')) throw new Error(`${item.id}: invalid ${field} reference ${id}`);
      }
    }
    for (const id of item.replaced_by || []) {
      if (definitions.get(id)?.kind !== item.kind) throw new Error(`${item.id}: invalid replacement ${id}`);
    }
  }
  const visiting = new Set(), checked = new Set();
  function checkReplacement(id) {
    if (visiting.has(id)) throw new Error(`Cyclic domain replacement: ${id}`);
    if (checked.has(id)) return;
    visiting.add(id);
    for (const successor of definitions.get(id).replaced_by || []) checkReplacement(successor);
    visiting.delete(id);
    checked.add(id);
  }
  for (const id of definitions.keys()) checkReplacement(id);
}

export async function validateDomainRepository(root) {
  const documents = await readDomainRepository(root);
  const contextIds = await readDomainContextIds(root);
  if (!documents.length) return { definitions: 0, contexts: contextIds.size };
  const { cards, problems } = await readRegistry(root);
  if (problems.length) throw new Error(`${problems[0].path}: ${problems[0].message}`);
  validateDomainGraph(documents, contextIds, new Set(cards.map(({ card }) => card.id)));
  return { definitions: documents.length, contexts: contextIds.size };
}
