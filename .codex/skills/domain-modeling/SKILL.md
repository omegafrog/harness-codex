---
name: domain-modeling
description: Refine ubiquitous language and record durable domain decisions. Use when terminology is ambiguous, domain relationships conflict, or an ADR-worthy decision emerges.
---

# domain-modeling

## What it does

`domain-modeling` sharpens the project's ubiquitous language as you design. It challenges fuzzy terms, stress-tests relationships with concrete scenarios, and writes the glossary and any hard-to-reverse decisions down the moment they crystallize.

This is the active discipline, not the passive one. Reading `CONTEXT.md` to borrow vocabulary is a one-line habit any skill can do; this skill is for when the model is changing — coining a canonical term, catching a contradiction between the code and what was just said, or recording an architectural decision that is expensive to reverse.

`CONTEXT.md` is a glossary and nothing else: no implementation details, no spec, no scratch pad. When a real decision crystallizes, let the model decide whether to record it in an ADR.

## When to reach for it

Type `/domain-modeling`, or let a higher-level flow reach for it automatically, when you are pinning down terminology, resolving an overloaded word, or recording an architectural decision.

## Pulled out on purpose

`domain-modeling` is the single source of truth for building the project's ubiquitous language, split out so other skills can reach it instead of reinventing it.
