# Implementation-only guidance

This provider-neutral Markdown document stores reusable implementation preferences. All linked worktrees read and update this canonical copy in the original project root (`shared_guidance_root`). Product behavior belongs in product contracts; target architecture belongs in architecture contracts. Keep tool-specific setup in the relevant integration configuration, not in these guidance entries.

## Active guidance

### signoz-local-spring-observability
- Status: active
- Applies to: Spring Boot projects where this user requests development-time error tracking
- Guidance: Prefer SigNoz for local development error tracking. Instrument Spring Boot through OpenTelemetry-compatible interfaces and keep development exporter/endpoint configuration separable by build/profile so production builds can omit development-only telemetry. For agent access to SigNoz data, prefer its MCP protocol endpoint and portable skills; do not couple application code to an agent provider. Do not install or start a SigNoz backend as part of Harness installation.
- Rationale: Error tracking is the priority; the solution must work with Spring Boot, be easy to run locally, remain lightweight for application builds, and be separable at build time.
- Source: 2026-10-20, user conversation choosing SigNoz after specifying Spring Boot/local development/build separation constraints
- Updated: 2026-10-20

## Superseded guidance
