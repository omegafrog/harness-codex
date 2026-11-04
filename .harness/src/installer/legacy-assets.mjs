// Identified from released source snapshots; unknown or modified content is never adopted.
export const LEGACY_ASSETS = [
  { release: '3d8e3e60', path: '.codex/scripts/harness-spec-writer.mjs', sha256: '800ea15bfbef0c69adc4effbf2298e5d3a448c3a80eb9ca19441075e672fb58d', action: 'retire' },
  { release: '3d8e3e60', path: '.harness/src/workflow/spec-writer.mjs', sha256: '145b0dcf3a9e33f90ac7a807539c5704f14f4f9a6b2aa38e5c19f8a5f8b470e6', action: 'retire' },
  { release: '3d8e3e60', path: '.harness/src/workflow/spec-writer-loop.mjs', sha256: '630fccd40d5ffe9a42fb8fc7a23986cae49866d868e24ac600a44d5442151a73', action: 'retire' },
  { release: '39d517dd', path: '.codex/scripts/harness-doctor.mjs', sha256: '557aebd2f6b84f52c3a4035ab15959925218f7dae2b570a3b3c3e19f2035927e', action: 'replace' },
  { release: '7b57a7fc', path: '.harness/src/workflow/project-readiness.mjs', sha256: '7fdea459525f968f0385ad9376ccc2659c2ed6bc9b899768b645665e6154d350', action: 'replace' },
  { release: '88e15b76', path: '.codex/scripts/harness-codex-run.mjs', sha256: '1c0dd264b759b3544c3706a921a3a35c9d992fed97f9d61a95ab7f3987463ca7', action: 'replace' },
  ...['finalize', 'revision', 'split'].map((name) => ({ release: '3c62babb', path: `.codex/internal-skills/skill-execution/schemas/flows/to-ticket-plan_${name}.schema.json`, sha256: '006357a60b799458061420cd226386518fd16b3ebd2c41f0f8249ca3a1857b26', action: 'retire' })),
];
