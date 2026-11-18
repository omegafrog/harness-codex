const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const isDomainSlug = (value) => typeof value === 'string' && SLUG.test(value);

export const DOMAIN_KINDS = Object.freeze({
  subdomain: { directory: 'subdomains', text: ['purpose', 'scope'], lists: ['contexts'] },
  actor: { directory: 'actors', text: ['role', 'authority', 'scope'], lists: [] },
  biz: { directory: 'activities', owned: true, text: ['purpose', 'start_condition', 'normal_result'], lists: ['actors'] },
  rule: { directory: 'rules', owned: true, text: ['statement', 'condition', 'violation_result'], lists: [] },
  exception: { directory: 'exceptions', owned: true, text: ['condition', 'business_result'], lists: ['rules'] },
  event: { directory: 'events', owned: true, text: ['fact', 'condition', 'publisher'], lists: [] },
  policy: { directory: 'policies', owned: true, text: ['condition', 'reaction'], lists: ['trigger_events'] },
  transition: { directory: 'transitions', owned: true, text: ['subject', 'from', 'to', 'condition'], lists: ['events'] },
});
const COMMON = ['schema_version', 'id', 'kind', 'name', 'status', 'aliases', 'source_refs', 'references'];
const STATUS = ['accepted-target', 'implemented', 'retired'];
const text = (value) => typeof value === 'string' && value.trim() !== '';

export function domainDocumentPath(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Domain frontmatter must be a mapping');
  const { kind, id, owner_context: owner } = metadata;
  if (!Object.hasOwn(DOMAIN_KINDS, kind)) throw new Error('Unknown domain kind');
  const { directory, owned } = DOMAIN_KINDS[kind];
  const parts = typeof id === 'string' ? id.split('.') : [];
  if (owned ? !(isDomainSlug(owner) && parts.length === 3 && parts[0] === owner && parts[1] === kind && isDomainSlug(parts[2]))
    : !(parts.length === 2 && parts[0] === kind && isDomainSlug(parts[1]) && !Object.hasOwn(metadata, 'owner_context'))) {
    throw new Error('Invalid domain ID or owner_context');
  }
  return `docs/domain/${owned ? `contexts/${owner}/` : ''}${directory}/${id}.md`;
}

export function validateDomainMetadata(metadata) {
  domainDocumentPath(metadata);
  const { kind, status } = metadata;
  const { owned, text: fields, lists } = DOMAIN_KINDS[kind];
  const allowed = new Set([...COMMON, ...fields, ...lists, 'replaced_by', 'retirement_reason', 'implementation_refs']);
  if (owned) allowed.add('owner_context');
  if (kind === 'subdomain') allowed.add('classification');
  for (const key of Object.keys(metadata)) if (!allowed.has(key)) throw new Error(`Unknown domain field: ${key}`);
  if (metadata.schema_version !== 1 || !STATUS.includes(status)) throw new Error('Invalid domain schema_version or status');
  for (const field of ['name', ...fields]) if (!text(metadata[field])) throw new Error(`${field} requires text`);
  for (const field of ['aliases', 'source_refs', 'references', ...lists, ...['replaced_by', 'implementation_refs'].filter((key) => Object.hasOwn(metadata, key))]) {
    const value = metadata[field];
    if (!Array.isArray(value) || !value.every(text) || new Set(value).size !== value.length) throw new Error(`${field} requires unique non-empty strings`);
  }
  if (!metadata.source_refs.length || lists.some((key) => !metadata[key].length)) throw new Error('Domain definition requires source and kind-specific references');
  if (kind === 'subdomain' && !['core', 'supporting', 'generic'].includes(metadata.classification)) throw new Error('Invalid subdomain classification');
  if (status === 'implemented' && !metadata.implementation_refs?.length) throw new Error('implemented requires implementation_refs');
  if (status === 'retired' && !text(metadata.retirement_reason)) throw new Error('retired requires retirement_reason');
  if (status !== 'retired' && (Object.hasOwn(metadata, 'retirement_reason') || Object.hasOwn(metadata, 'replaced_by'))) throw new Error('Only retired definitions can declare replacement');
  return metadata;
}

export function parseDomainDocument(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error('Domain document requires frontmatter delimiters');
  const metadata = Object.create(null);
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([a-z_]+): (.+)$/.exec(line);
    if (!field || Object.hasOwn(metadata, field[1])) throw new Error('Invalid or duplicate domain frontmatter field');
    metadata[field[1]] = JSON.parse(field[2]);
  }
  return { metadata: validateDomainMetadata(metadata), body: match[2] };
}

export function formatDomainDocument({ metadata, body }) {
  validateDomainMetadata(metadata);
  if (typeof body !== 'string') throw new Error('Domain Markdown body must be text');
  const fields = Object.keys(metadata).sort().map((key) => `${key}: ${JSON.stringify(metadata[key])}`);
  return `---\n${fields.join('\n')}\n---\n${body}`;
}
