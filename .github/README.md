# cadenway-service-kit

cadenway-service-kit publishes the three runtime packages shared by NestJS services and gateways.

| Package                    | Provides                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cadenway/nest-common`    | Typed configuration validated at start-up, internal-token guard, organization context, structured logs, OpenTelemetry traces, `/health/live` and `/health/ready`, common error format, pagination |
| `@cadenway/nest-messaging` | NATS JetStream connection, outbox publication, subscriptions with retries and dead letters, deduplication of redelivered events                                                                   |
| `@cadenway/nest-jobs`      | Durable background jobs kept in the service's own PostgreSQL database: a job enqueued in the use case transaction, retries with backoff, dead letters, cron schedules                             |

Find the [`@cadenway/nest-testing` development package](https://github.com/Cadenway/cadenway-tooling/tree/main/packages/nest-testing) in cadenway-tooling.

## Getting started

Requirements: Node.js LTS and pnpm (versions in `package.json`), Docker for the integration tests.

```bash
pnpm install
pnpm build
```

Consumers install the published packages; never link this folder into another repository.

## Checks

Run the narrowest check first; CI runs them all on every pull request.

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration          # NATS and PostgreSQL in Docker
pnpm build
pnpm changeset status
```

## Contributing

- [Contributing guide](CONTRIBUTING.md): branches, commits, pull requests, releases.
- [Code of conduct](CODE_OF_CONDUCT.md), [security policy](SECURITY.md), [getting help](SUPPORT.md).
- AI assistants follow [AGENTS.md](../AGENTS.md); Claude Code also reads [CLAUDE.md](../CLAUDE.md) and the
  tooling described in [.claude/README.md](../.claude/README.md).

## License

This repository is proprietary. See [LICENSE](../LICENSE) for the rights and restrictions that apply.

## References

- [Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE): every screen, state and interaction.
- [Integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et): tokens, data shapes, component names.
- [Repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N): what each repository owns, deployment.
