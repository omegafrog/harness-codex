// The only skills a user can call directly. Everything else is an internal GUIDE under .harness/skills.
export const PUBLIC_SKILLS = ['orchestrator', 'eli5', 'setup', 'harness-update'];

// Public provider entrypoints are generated from their provider-neutral or legacy source locations.
export const PUBLIC_SKILL_SOURCES = Object.freeze({
  orchestrator: '.agents/skills/orchestrator',
  eli5: '.agents/skills/eli5',
  setup: '.agents/skills/setup',
  'harness-update': '.agents/skills/harness-update',
});
