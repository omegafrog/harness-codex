import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateDiagnosticLog } from '../src/observability/diagnostic-logs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, '.codex/skills/victorialogs-local-setup/assets');
const schema = JSON.parse(await readFile(join(assets, 'diagnostic-log.schema.json'), 'utf8'));
const example = JSON.parse(await readFile(join(assets, 'diagnostic-log.example.json'), 'utf8'));
const validate = (record) => validateDiagnosticLog(record, schema);

test('all seven event contracts accept typed required fields and enforce their event conditions', () => {
  const seed = {
    ...example.Attributes,
    'diag.retry.next_attempt': 4,
    'diag.retry.delay_ms': 50,
    'diag.state.from': 'STARTING',
    'diag.state.to': 'READY',
  };
  for (const [event, rule] of Object.entries(schema.$defs.events.$defs)) {
    const Attributes = Object.fromEntries(rule.required.map((key) => [key, seed[key]]));
    if (rule.properties?.['diag.outcome']) Attributes['diag.outcome'] = rule.properties['diag.outcome'].const;
    const record = { ...example, EventName: event, Attributes };
    assert.deepEqual(validate(record), [], event);
    for (const key of rule.required) {
      const invalid = structuredClone(record);
      delete invalid.Attributes[key];
      assert.ok(validate(invalid).length, `${event} requires ${key}`);
    }
    if (rule.properties?.['diag.outcome']) assert.ok(validate({ ...record, Attributes: { ...Attributes, 'diag.outcome': rule.properties['diag.outcome'].const === 'success' ? 'failure' : 'success' } }).length);
  }
});

test('invalid core, resource, trace, numeric, boolean and category fields are rejected', () => {
  for (const key of ['Timestamp', 'EventName', 'Resource', 'Attributes']) {
    const record = structuredClone(example);
    delete record[key];
    assert.ok(validate(record).length, key);
  }
  for (const key of schema.properties.Resource.required) {
    const record = structuredClone(example);
    delete record.Resource[key];
    assert.ok(validate(record).length, key);
  }
  for (const [key, value] of [['diag.duration_ms', -1], ['diag.duration_ms', '12'], ['diag.duration_ms', 1.5], ['diag.attempt', 0], ['diag.retry.next_attempt', 1], ['diag.retry.delay_ms', -1], ['diag.error.retryable', 'true'], ['diag.error.category', 'other']]) {
    assert.ok(validate({ ...example, Attributes: { ...example.Attributes, [key]: value } }).length, key);
  }
  for (const patch of [{ Timestamp: '2026-02-30T08:00:00Z' }, { Timestamp: 'not-a-time' }, { TraceId: '0'.repeat(32) }, { SpanId: 'abcd' }, { TraceFlags: 256 }, { SeverityNumber: 25 }, { EventName: 'diag.operation.unknown' }, { Resource: { ...example.Resource, 'diag.contract.version': '2.0' } }]) assert.ok(validate({ ...example, ...patch }).length);
  const noExceptionType = structuredClone(example);
  delete noExceptionType.Attributes['exception.type'];
  assert.ok(validate(noExceptionType).some((error) => error.includes('exception.type')));
  const noTrace = structuredClone(example);
  delete noTrace.TraceId;
  assert.ok(validate(noTrace).some((error) => error.includes('required with SpanId')));
});

test('business-failure severity overrides, structured Body, project extensions and absent tracing are supported', () => {
  const record = { ...example, SeverityText: 'INFO', Body: { reason: 'expected business rejection' }, Attributes: { ...example.Attributes, 'example.workflow': 'demo' } };
  delete record.TraceId;
  delete record.SpanId;
  assert.deepEqual(validate(record), []);
  assert.deepEqual(validate(example), []);
  assert.throws(() => validateDiagnosticLog(example, { $id: 'unsupported' }), /Unsupported/);
});

test('offline CLI validates source JSONL without requiring VictoriaLogs or leaking record values', async () => {
  assert.ok(process.env.HARNESS_SESSION_DIR, 'Use harness-exec diagnostic-log-check');
  const directory = await mkdtemp(join(process.env.HARNESS_SESSION_DIR, 'tmp/diagnostic-logs-'));
  try {
    const input = join(directory, 'diagnostic.jsonl');
    const run = () => spawnSync(process.execPath, [join(root, '.codex/scripts/harness-victorialogs.mjs'), 'validate-logs', '--root', root, '--input', input], { cwd: root, encoding: 'utf8' });
    await writeFile(input, JSON.stringify(example) + '\n');
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(JSON.parse(valid.stdout).records, 1);
    await writeFile(input, JSON.stringify({ ...example, Body: 'do-not-echo-payload', Attributes: {} }) + '\n{not JSON}\n');
    const invalid = run();
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.equal(JSON.parse(invalid.stdout).invalid_records, 2);
    assert.ok(!invalid.stdout.includes('do-not-echo-payload'));
    await writeFile(input, '');
    assert.equal(run().status, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
