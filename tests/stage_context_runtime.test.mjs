import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStagePrompt, instructionVersion, isCancellationOutcome, isCompactionEvent, phaseInstructionPaths } from '../.harness/src/workflow/execution-context.mjs';
import { stageConfigArgs } from '../.harness/src/workflow/providers/codex.mjs';
import { allowedToolsForRole, buildCommand as buildClaudeCommand } from '../.harness/src/workflow/providers/claude-code.mjs';

test('same-session resume sends only new inputs and reloads changed instruction files', () => {
  const version = instructionVersion('guide-v1');
  const support = [['product/topics.md', 'v1']];
  const profile = { profile: 'role.toml', profileContent: 'profile-v1', profileVersion: instructionVersion('profile-v1') };
  const prior = buildStagePrompt({ guide: 'guide.md', guideContent: 'guide-v1', guideVersion: version, ...profile, instructionVersions: support, instructionContents: [{ path: 'product/topics.md', content: 'topics-v1', version: 'v1' }], resumeSession: null, inputPath: 'input.json', root: '/workspace' }).delivery;
  const resumed = buildStagePrompt({ guide: 'guide.md', guideContent: 'guide-v1', guideVersion: version, ...profile, instructionVersions: support, instructionContents: [{ path: 'product/topics.md', content: 'topics-v1', version: 'v1' }], resumeSession: 'thread-1', previousDelivery: prior, answersPath: 'answers.json', inputPath: 'input.json', root: '/workspace' });
  assert.equal(resumed.delivery.reread, false);
  assert.match(resumed.prompt, /answers\.json/);
  assert.doesNotMatch(resumed.prompt, /guide-v1|topics-v1|profile-v1/);
  const changed = buildStagePrompt({ guide: 'guide.md', guideContent: 'guide-v2', guideVersion: instructionVersion('guide-v2'), instructionVersions: support, resumeSession: 'thread-1', previousDelivery: prior, inputPath: 'input.json', root: '/workspace' });
  assert.equal(changed.delivery.reread, true);
  assert.match(changed.prompt, /instructions changed/);
  const supportChanged = buildStagePrompt({ guide: 'guide.md', guideContent: 'guide-v1', guideVersion: version, instructionVersions: [['product/topics.md', 'v2']], instructionContents: [{ path: 'product/topics.md', content: 'topics-v2', version: 'v2' }], resumeSession: 'thread-1', previousDelivery: prior, inputPath: 'input.json', root: '/workspace' });
  assert.equal(supportChanged.delivery.reread, true);
  assert.match(supportChanged.prompt, /topics-v2/);
  const changedProfileContent = 'profile-v2';
  const changedProfile = buildStagePrompt({ guide: 'guide.md', guideContent: 'guide-v1', guideVersion: version, profile: 'role.toml', profileContent: changedProfileContent, profileVersion: instructionVersion(changedProfileContent), resumeSession: 'thread-1', previousDelivery: prior, inputPath: 'input.json', root: '/workspace' });
  assert.match(changedProfile.prompt, /profile-v2/);
  const newSession = buildStagePrompt({ guide: 'guide.md', guideContent: 'guide-v1', guideVersion: version, resumeSession: null, previousDelivery: prior, inputPath: 'input.json', root: '/workspace' });
  assert.equal(newSession.delivery.reread, true);
  assert.match(newSession.prompt, /guide-v1/);
});

test('Codex stage config disables irrelevant catalogs and MCPs while retaining research for scoped roles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stage-context-'));
  try {
    const config = join(dir, '.codex', 'config.toml');
    await mkdir(join(dir, '.codex'));
    await writeFile(config, '[mcp_servers."not-needed"]\ncommand="unused"\n');
    const project = join(dir, 'project.toml');
    await writeFile(project, '[mcp_servers.project-tool]\ncommand="unused"\n\n[mcp_servers."dotted.server"]\ncommand="unused"\n');
    const args = await stageConfigArgs({ HOME: dir }, [project], 'code_researcher');
    assert.ok(args.includes('skills.include_instructions=false'));
    assert.ok(args.includes('features.plugins=false'));
    assert.ok(args.includes('features.apps=false'));
    assert.ok(args.includes('features.goals=false'));
    assert.ok(args.includes('features.image_generation=false'));
    const serverOverride = args.find((arg) => arg.startsWith('mcp_servers={'));
    assert.match(serverOverride, /"not-needed"=\{enabled=false\}/);
    assert.match(serverOverride, /"project-tool"=\{enabled=false\}/);
    assert.match(serverOverride, /"dotted\.server"=\{enabled=false\}/);
    assert.ok(args.includes('web_search="live"'));
    const product = await stageConfigArgs({ HOME: dir }, [project], 'tracker_publisher');
    assert.ok(product.includes('web_search="disabled"'));
    const spec = await stageConfigArgs({ HOME: dir }, [project], null, 'spec-me');
    assert.ok(spec.includes('web_search="live"'));
    const frontend = await stageConfigArgs({ HOME: dir }, [project], 'frontend_visual_reviewer');
    assert.ok(frontend.includes('features.view_image=true'));
    assert.ok(frontend.includes('features.image_generation=true'));
    assert.ok(!frontend.includes('mcp_servers."figwright".enabled=false'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('compaction evidence recognizes event and item boundaries and forces a guide reload', () => {
  assert.ok(isCompactionEvent({ type: 'context_compacted' }));
  assert.ok(isCompactionEvent({ type: 'item.completed', item_type: 'context_compaction' }));
  assert.ok(isCompactionEvent({ type: 'turn', subtype: 'compacted' }));
  assert.ok(!isCompactionEvent({ type: 'item.completed', item_type: 'assistant_message' }));
  const result = buildStagePrompt({ guide: 'guide.md', guideContent: 'guide', guideVersion: 'same', resumeSession: 'thread', previousDelivery: { guide: 'guide.md', guide_version: 'same', compaction_observed: true }, inputPath: 'input.json', root: '/workspace' });
  assert.equal(result.delivery.reread, true);
  assert.match(result.prompt, /context compaction boundary/);
  assert.equal(result.delivery.phase, 'entry');
});

test('only an observed runner signal paired with terminal signal evidence becomes cancellation', () => {
  assert.equal(isCancellationOutcome({ requested: true, signal: 'SIGTERM', code: null }), true);
  assert.equal(isCancellationOutcome({ requested: true, signal: null, code: 143 }), true);
  assert.equal(isCancellationOutcome({ requested: false, signal: 'SIGTERM', code: null }), false);
  assert.equal(isCancellationOutcome({ requested: true, signal: null, code: 1 }), false);
});

test('Claude stage tools retain native delegation and only add research tools for research-capable roles', () => {
  const research = allowedToolsForRole('spec_document_writer');
  assert.ok(research.includes('Agent'));
  assert.ok(research.includes('WebSearch'));
  assert.equal(allowedToolsForRole('code_researcher').includes('Agent'), false);
  const publisher = allowedToolsForRole('tracker_publisher');
  assert.ok(publisher.includes('Agent'));
  assert.ok(!publisher.includes('WebSearch'));
  assert.equal(allowedToolsForRole('frontend_visual_reviewer'), null);
  const args = buildClaudeCommand({ root: '/workspace', sandbox: 'workspace-write', binding: { model: 'model', reasoning_effort: 'medium' }, schema: {}, role: 'diagram_creator' });
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--tools'));
  const publicSkill = buildClaudeCommand({ root: '/workspace', sandbox: 'workspace-write', binding: { model: 'model', reasoning_effort: 'medium' }, schema: {}, skill: 'setup', requiredSkill: 'setup' });
  assert.ok(!publicSkill.includes('--disable-slash-commands'));
  assert.ok(publicSkill[publicSkill.indexOf('--tools') + 1].split(',').includes('Skill'));
});

test('spec-me pastes the Product phase guide only until the Product Spec exists', async () => {
  const product = ['.codex/internal-skills/product-spec/GUIDE.md', '.codex/internal-skills/product-spec/references/topics.md'];
  const returnContract = '.codex/internal-skills/skill-execution/references/stage-return.md';
  assert.deepEqual(phaseInstructionPaths({ skill: 'spec-me', productSpecExists: false }), [returnContract, ...product]);
  assert.deepEqual(phaseInstructionPaths({ skill: 'spec-me', productSpecExists: true }), [returnContract]);
  assert.deepEqual(phaseInstructionPaths({ skill: 'product-spec' }), [returnContract, product[1]]);
  assert.deepEqual(phaseInstructionPaths({ skill: 'implement' }), [returnContract]);
  const runner = await (await import('node:fs/promises')).readFile(new URL('../.codex/scripts/harness-agent-run.mjs', import.meta.url), 'utf8');
  assert.match(runner, /phaseInstructionPaths\(\{ skill: input\.skill, productSpecExists: Boolean\(artifactDirectories && existsSync\(join\(artifactDirectories\.specs, 'product-spec\.md'\)\)\) \}\)/);
});
