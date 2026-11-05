// Identified from released source snapshots; unknown or modified content is never adopted.
export const LEGACY_ASSETS = [
  { release: '3d8e3e60', path: '.codex/scripts/harness-spec-writer.mjs', sha256: '800ea15bfbef0c69adc4effbf2298e5d3a448c3a80eb9ca19441075e672fb58d', action: 'retire' },
  { release: '3d8e3e60', path: '.harness/src/workflow/spec-writer.mjs', sha256: '145b0dcf3a9e33f90ac7a807539c5704f14f4f9a6b2aa38e5c19f8a5f8b470e6', action: 'retire' },
  { release: '3d8e3e60', path: '.harness/src/workflow/spec-writer-loop.mjs', sha256: '630fccd40d5ffe9a42fb8fc7a23986cae49866d868e24ac600a44d5442151a73', action: 'retire' },
  { release: '39d517dd', path: '.codex/scripts/harness-doctor.mjs', sha256: '557aebd2f6b84f52c3a4035ab15959925218f7dae2b570a3b3c3e19f2035927e', action: 'replace' },
  { release: '7b57a7fc', path: '.harness/src/workflow/project-readiness.mjs', sha256: '7fdea459525f968f0385ad9376ccc2659c2ed6bc9b899768b645665e6154d350', action: 'replace' },
  { release: '88e15b76', path: '.codex/scripts/harness-codex-run.mjs', sha256: '1c0dd264b759b3544c3706a921a3a35c9d992fed97f9d61a95ab7f3987463ca7', action: 'replace' },
  ...['finalize', 'revision', 'split'].map((name) => ({ release: '3c62babb', path: `.codex/internal-skills/skill-execution/schemas/flows/to-ticket-plan_${name}.schema.json`, sha256: '006357a60b799458061420cd226386518fd16b3ebd2c41f0f8249ca3a1857b26', action: 'retire' })),
  ...['finalize', 'revision', 'split'].map((name) => ({ release: 'cbc0b0fe', path: `.codex/internal-skills/skill-execution/schemas/flows/to-ticket-plan_${name}.schema.json`, sha256: 'eafcdf9b43a1eb9fe5da14b9926422f4797deae5197accbb4da99f886e4efc22', action: 'retire' })),
  ...[
    ['.agents/skills/orchestrator/references/to-ticket.md', '72bc95a764b15086755de340a67fa7b17de74e373a4927686e0f396298f86e91'],
    ['.agents/skills/to-ticket/references/traceability-ledger.md', '1a844df4e9c7e88e7da6300c8c5eab157c27b8febde579ad9a6e9253437638ff'],
    ['.codex/harness-runtime/src/workflow/plan-traceability.mjs', '317dc17903d6a11c9f81a3c18e6de69a66ef10c2466722858d4a44469b6218b0'],
    ['.codex/internal-skills/skill-execution/schemas/result.schema.json', '5709b168e46c62e5e872d4771fb1c285d92e814302d065269e41bbb93c0e6ef5'],
    ['.codex/internal-skills/workflow-compose/schemas/workflow.schema.json', 'caa9ba69f17a96b24b7c5fc8ab7b28b2fda097f79848ffa810558becfc6fe815'],
    ['.codex/scripts/harness-plan-traceability.mjs', '55ad39494ed0035603f96aee4f40af5e35819e7e575202f18464b9d62662edc6'],
    ['.codex/scripts/harness-skill-exec.mjs', '77eac6b068dca50b48be9a7bc8e1e9b98822d5032762da2051f95c19f8da894b'],
  ].map(([path, sha256]) => ({ release: 'historical', path, sha256, action: 'retire' })),
];
