// Validator for the shipped diagnostic v1 contract, not a general JSON Schema engine.
export function validateDiagnosticLog(record, schema) {
  if (schema?.$id !== 'urn:harness:spring-boot-diagnostic-log:1.0' || !schema.$defs?.events?.$defs) throw new Error('Unsupported diagnostic log contract');
  const errors = [];
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const dateTime = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match || !Number.isFinite(Date.parse(value))) return false;
    const date = new Date(0);
    date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
  };
  const check = (value, rule, path) => {
    if (rule.type && !(rule.type === 'object' ? object(value) : rule.type === 'integer' ? Number.isSafeInteger(value) : typeof value === rule.type)) {
      errors.push(`${path}: expected ${rule.type}`);
      return;
    }
    if (Object.hasOwn(rule, 'const') && value !== rule.const) errors.push(`${path}: unexpected constant`);
    if (rule.enum && !rule.enum.includes(value)) errors.push(`${path}: unsupported value`);
    if (typeof value === 'number' && (value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))) errors.push(`${path}: outside allowed range`);
    if (typeof value === 'string') {
      if (value.length < (rule.minLength ?? 0)) errors.push(`${path}: empty value`);
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) errors.push(`${path}: invalid format`);
      if (rule.format === 'date-time' && !dateTime(value)) errors.push(`${path}: expected RFC3339 timestamp`);
    }
    if (object(value)) {
      for (const key of rule.required || []) if (!Object.hasOwn(value, key) || value[key] === undefined) errors.push(`${path}.${key}: required`);
      for (const [key, required] of Object.entries(rule.dependentRequired || {})) if (Object.hasOwn(value, key)) for (const dependency of required) if (!Object.hasOwn(value, dependency)) errors.push(`${path}.${dependency}: required with ${key}`);
      for (const [key, field] of Object.entries(rule.properties || {})) if (Object.hasOwn(value, key)) check(value[key], field, `${path}.${key}`);
    }
  };
  check(record, schema, '$');
  if (object(record)) {
    const event = schema.$defs.events.$defs[record.EventName];
    if (event && object(record.Attributes)) check(record.Attributes, event, '$.Attributes');
  }
  return [...new Set(errors)];
}
