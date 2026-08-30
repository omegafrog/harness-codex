---
name: domain-modeling
description: Refine ubiquitous language and record durable domain decisions. Use when terminology is ambiguous, domain relationships conflict, or an ADR-worthy decision emerges.
---

# domain-modeling

## What it does

`domain-modeling` sharpens ubiquitous language, stress-tests relationships, and records durable decisions.

Use it when the model changes: coining a canonical term, resolving a contradiction, or recording an expensive-to-reverse decision.

`CONTEXT.md` is a glossary and nothing else: no implementation details, no spec, no scratch pad. When a real decision crystallizes, let the model decide whether to record it in an ADR.

## When to reach for it

Type `/domain-modeling`, or let a higher-level flow reach for it automatically, when you are pinning down terminology, resolving an overloaded word, or recording an architectural decision.
