// Identified from released source snapshots; unknown or modified content is never adopted.
export const LEGACY_ASSETS = [
  { release: '39d517dd', path: '.codex/scripts/harness-doctor.mjs', sha256: '557aebd2f6b84f52c3a4035ab15959925218f7dae2b570a3b3c3e19f2035927e', action: 'replace' },
  ...['finalize', 'revision', 'split'].map((name) => ({ release: '3c62babb', path: `.codex/internal-skills/skill-execution/schemas/flows/to-ticket-plan_${name}.schema.json`, sha256: '006357a60b799458061420cd226386518fd16b3ebd2c41f0f8249ca3a1857b26', action: 'retire' })),
];
