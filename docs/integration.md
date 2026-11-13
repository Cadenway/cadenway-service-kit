# Domain and integration

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

**Status:** This page records the target design from repository instructions and skills. Its behavior has not been verified as implemented in this snapshot.

## Package boundaries

`@cadenway/nest-common`, `@cadenway/nest-messaging`, `@cadenway/nest-jobs`, and `@cadenway/nest-testing` provide shared backend plumbing. Services consume published releases; the kit does not own business rules. Package APIs and delivery behavior below are planned until implementation exists.

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

### Transport conventions

| Concern      | Rule                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject      | `evt.<event-name>`, derived from the contract name: `evt.task.status-changed.v1`                                                                                  |
| Stream       | One stream `EVENTS` on `evt.>`: file storage, seven days, a byte cap                                                                                              |
| Publish      | `Nats-Msg-Id` = event id; the server deduplicates for two minutes only                                                                                            |
| Consumer     | Durable pull consumer `<service>__<handler>`, `AckWait` 30 s, five deliveries                                                                                     |
| Retry        | `nak(delay)` after 1 s, 5 s, 30 s, 2 min; no server-side `BackOff`, whose first entry replaces `AckWait`                                                          |
| Dead letters | A worker listens to `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.EVENTS.>` and copies the message into `EVENTS_DLQ`: JetStream has no dead-letter queue of its own |
| Ordering     | Not guaranteed. Every event carries the `version` of its aggregate; a consumer skips a version it has already applied                                             |
| Headers      | `traceparent` (W3C), organization id, event name                                                                                                                  |
| Payload      | JSON, validated with the zod schema of `@cadenway/contracts` on publish and on receipt                                                                            |
| Publisher    | One NATS user per service, allowed to publish its own subjects only                                                                                               |

### Rebuild

Sent outbox rows are kept seven days, so a service can publish again after a NATS loss. The stream
is not an archive: an index is rebuilt by the owning service re-emitting the current state of its
entities on `rebuild.<consumer>.<entity>`.

### Without a database

`drizzle-orm` and `pg` are optional peers. The outbox and the processed-ids table sit behind the
`/outbox` entry point; the realtime gateway, which has no database, consumes events through the main
entry point only.

## References

[Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N). Use [AGENTS.md](../AGENTS.md) as the local source for ownership and hard limits.
