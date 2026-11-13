# cadenway-service-kit: Claude Code instructions

> **Source of truth.** This file is the entry point for Claude Code. The normative rules live in
> [AGENTS.md](AGENTS.md), imported below: read it, do not paraphrase it from memory.

@AGENTS.md

> **Read on demand, deliberately not `@`-imported**: the [repositories document](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N), section "cadenway-service-kit". Importing them would
> cost context in every session. The path-scoped rules in `.claude/rules/` load automatically when
> you open a matching file and carry the few things that must never be got wrong there.

## TL;DR for every task

1. The four planned packages for services and gateways are `@cadenway/nest-common`, `@cadenway/nest-messaging`, `@cadenway/nest-jobs`, `@cadenway/nest-testing`.
2. Plumbing only: configuration, auth guards, organization context, logs, traces, health, errors, pagination, NATS, outbox, background jobs, test helpers. Never a business rule.
3. `nest-messaging` is typed by `@cadenway/contracts`: it publishes and consumes exactly the shapes defined there.
4. Services and gateways will receive package updates through Renovate. Keep the public API stable and deprecate before removing.
5. Package changes require a changeset. The release workflow publishes from CI.

## Boundaries (hard rules)

- No business logic, no knowledge of a specific service.
- No direct dependency on a service repository.
- Public API through explicit exports; breaking changes are majors with a deprecation first.

## Target quality gate

Use the [minimum checks by change](docs/development.md#minimum-checks-by-change) first.
Run `/cw-quality` without arguments for the full local gate when applicable. Report unavailable
checks during bootstrap.

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration          # NATS and PostgreSQL in Docker
pnpm build
pnpm changeset status
```

## Tooling: this repository ships its own `.claude/`

Open `cadenway-service-kit/` as the workspace root to activate it. The `cw-kit-*` agents, the `/cw-*`
commands, the skills and the hooks are described in [.claude/README.md](.claude/README.md). Two things
the session listing does not tell you:

- **Rules** in `.claude/rules/` load at session start unless they declare `paths`. Scoped rules
  load when Claude reads a matching file.
- **Hooks** cover the edit and shell tool events matched in `.claude/settings.json`.
  `guard.mjs` refuses edits that break a hard rule
  (generated trees, lockfiles, secrets, sibling checkouts, `export *` in public entry points, unpinned third-party actions and `pull_request_target` in workflows), `guard-git.mjs`
  refuses pushes to `main`, tag pushes, force-pushes, rewrites of pushed commits, hook bypasses and
  registry publishing, and `format.mjs` formats supported files when its formatter is available.
  Apply the repository rules across tools. Resolve a refusal without bypassing the hook.

The sibling repositories (`../cadenway-api-contracts`, `../cadenway-task-service`, `../cadenway-api-gateway`) are read-only references
from here; add them to the session (`--add-dir`) when a task needs to read them.
