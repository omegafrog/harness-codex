# OWASP Planning Baseline

Version source of truth: `.codex/security/owasp-standards.json`. This file explains application rules; it must not independently choose newer versions.

## Update Process

- `.github/workflows/check-owasp-standards.yml` runs monthly and on manual dispatch.
- `scripts/check_owasp_standards.py` checks only official OWASP or OWASP GitHub sources.
- A discovered version change or review age over 90 days creates or refreshes one GitHub review issue.
- Network or source parsing failures fail the workflow but do not claim that a new standard exists.
- Never update this baseline automatically. Review release notes, control changes, identifier migrations, tests, and one real-plan smoke before updating the registry and `last_reviewed_on`.

## Versioned Sources

- OWASP Application Security Verification Standard 5.0.0:
  `https://owasp.org/www-project-application-security-verification-standard/`
- OWASP Top 10:2025:
  `https://owasp.org/www-project-top-ten/`
- OWASP API Security Top 10:2023:
  `https://owasp.org/API-Security/editions/2023/en/0x11-t10/`
- OWASP MASVS 2.1.0:
  `https://mas.owasp.org/MASVS/`
- OWASP Cheat Sheet Series:
  `https://cheatsheetseries.owasp.org/`

ASVS is the normative verification baseline for web applications and services. Top 10 documents help identify risk coverage but do not replace testable requirements.

## Applicability Matrix

|Feature evidence|Required planning focus|
|---|---|
|Identity, sessions, tokens, credentials|Authentication lifecycle, session invalidation, credential storage, brute-force resistance, recovery paths|
|Roles, ownership, tenant or object access|Deny-by-default authorization at function, object, and property levels; privilege-transition tests|
|Untrusted input or rendered output|Canonicalization, allow-list validation, context-aware encoding, parameterized queries, injection tests|
|Sensitive or regulated data|Classification, minimization, encryption in transit and at rest when required, masking, retention, deletion, log exclusion|
|Browser UI|CSRF where cookie auth exists, XSS prevention, security headers, clickjacking policy, CORS and origin policy|
|HTTP or public API|Schema validation, method and content-type restrictions, object and property authorization, resource limits, inventory and version policy|
|External URL, webhook, callback, import|SSRF controls, destination allow-listing, redirect and DNS handling, timeout and response-size limits|
|File upload or download|Type and size validation, generated names, storage isolation, malware handling where justified, authorization, content disposition|
|Serialization, templates, expressions, XML|Safe parsers, disabled dangerous features, type restrictions, payload limits|
|Cryptography, signatures, secrets|Approved algorithms and libraries, key ownership and rotation, secret storage, failure behavior; no custom cryptography|
|State-changing workflow or money-like value|Replay resistance, idempotency, concurrency controls, invariant and abuse tests, audit events|
|Dependencies, build, deployment|Governed dependencies, vulnerability review, artifact integrity, least-privilege configuration, secret scanning|
|Security-significant events|Structured audit logging without secrets, correlation, tamper resistance where required, alert criteria|

## Plan Mapping Rules

For every applicable row:

1. State evidence from the ChangeSet, work-item slice, architecture, or technical decisions.
2. Add one or more concrete implementation tasks.
3. Add focused tests for allowed and denied behavior.
4. Add a verification command or manual procedure with measurable success criteria.
5. Map to an OWASP source and version. Use chapter or risk names when exact ASVS IDs were not verified.

## Minimum Abuse Cases

Add only those relevant to the feature:

- unauthenticated request
- authenticated wrong role, owner, or tenant
- object ID or property tampering
- malformed, oversized, encoded, or duplicate input
- replayed or concurrent state-changing request
- secret or sensitive value reaching logs, errors, browser storage, or responses
- dependency or configuration failure
- external service timeout, redirect, or attacker-controlled destination

## Prohibited Output

- Generic "follow OWASP" checkbox.
- Security tool run without defined pass criteria.
- Exact ASVS requirement ID inferred from memory.
- New product requirement disguised as a security control.
- Claim that Top 10 coverage alone proves security.
