# Development and verification

[Documentation index](README.md) · [Repository overview](../.github/README.md) · [Repository instructions](../AGENTS.md)

Run Git, pnpm, build, and test commands with this repository as the working directory.

## Before making a change

- The package you change and its `README.md`.
- The installed `@cadenway/contracts` when touching messaging.
- `package.json` for versions and scripts once the repository is bootstrapped. Do not restate
  versions elsewhere: a copy goes stale.

## Setup

Requirements: Node.js LTS and pnpm (versions in `package.json`), Docker for the integration tests.

```bash
pnpm install
pnpm build
```

Consumers install the published packages; never link this folder into another repository.

## Minimum checks by change

Use the [checks by change in AGENTS.md](../AGENTS.md#commands-and-quality-gates) to select and report the smallest applicable verification.

## Full local quality gate

Run these steps from the repository root. The same procedure backs `/cw-quality` in Claude Code
and `$cw-quality` in Codex.

1. Run `pnpm quality` for formatting, linting, type checks, unit tests, architecture checks,
   build, and package archive verification.
2. Run `pnpm test:integration` with Docker available for disposable NATS and PostgreSQL services.
3. Run `pnpm changeset status` when checking a change to a published package.

For a targeted check, use `pnpm test "<path>"` for unit specs or
`pnpm test:integration "<path>"` for integration specs. A successful command with zero executed
tests leaves the selected behavior unverified.

## Architecture check

Run `pnpm test:architecture` to check package boundaries with the `kit` profile of [`@cadenway/nest-testing/architecture`](https://github.com/Cadenway/cadenway-tooling/tree/main/packages/nest-testing). The check is part of `pnpm quality` and the GitHub Actions quality gate.

## Collaboration and release

- Trunk-based: work branches come from `main`, named `<type>/<lowercase-kebab-description>` with a
  type among `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
  `revert`; put the Cadenway task id first when there is one (`feat/cad-482-sso-screen`). Never an
  agent name as a prefix. Validate with `git check-ref-format --branch <name>`.
- Commits and PR titles follow Conventional Commits: `type(scope): subject`, English, imperative,
  lowercase subject, no trailing period, at most 100 characters; `!` only for a breaking change.
- Pull requests target `main` and are squash-merged after review and green CI. PRs that change a package add a changeset; the "Version Packages" pull request bumps versions; its merge publishes from CI and Renovate updates the services and gateways.
- Stage only the files of your task; preserve other people's changes in the working tree.

Keep credentials, private keys, decrypted environment files and Terraform state out of documentation and logs. Follow the hard limits in [AGENTS.md](../AGENTS.md); setup instructions do not authorize deployments or changes to real infrastructure.
