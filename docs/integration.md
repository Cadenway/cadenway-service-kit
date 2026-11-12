# Domain and integration

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

**Status:** This page records the target design from repository instructions and skills. Its behavior has not been verified as implemented in this snapshot.

## Package boundaries

`@cadenway/nest-common`, `@cadenway/nest-messaging`, and `@cadenway/nest-testing` provide shared backend plumbing. Services consume published releases; the kit does not own business rules. Package APIs and delivery behavior below are planned until implementation exists.

## Kit API Stability

Source: `cw-kit-api-stability` ([Claude](../.claude/skills/cw-kit-api-stability/SKILL.md), [Codex](../.codex/skills/cw-kit-api-stability/SKILL.md)).

- New behavior: behind an option, default unchanged.
- Rename or removal: deprecate in a minor (JSDoc `@deprecated`, a start-up warning), remove in the next
  major with a migration note per affected service.

## Outbox Design

Source: `cw-outbox-design` ([Claude](../.claude/skills/cw-outbox-design/SKILL.md), [Codex](../.codex/skills/cw-outbox-design/SKILL.md)).

```text
use case transaction ──► outbox row (pending)
commit ──► relay picks pending rows ──► NATS JetStream publish ──► row marked sent
consumer ──► processed-ids check ──► handler ──► ack
failure ──► retry with backoff (max n) ──► dead-letter stream + error log
```

## References

[Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N). Use [AGENTS.md](../AGENTS.md) as the local source for ownership and hard limits.
