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

The scripts below are this repository's contract. While the repository is being bootstrapped,
create them with these exact names; afterwards, use them and never an ad-hoc equivalent. Run the
narrowest check that covers the change first, then widen:

| Changed                         | Minimum check                                   |
| ------------------------------- | ----------------------------------------------- |
| nest-common                     | `pnpm test packages/nest-common`                |
| nest-messaging                  | `pnpm test:integration packages/nest-messaging` |
| nest-jobs                       | `pnpm test:integration packages/nest-jobs`      |
| Any change to a package         | a changeset                                     |
| Docs or agent instructions only | Scoped formatting and link review               |

Report the commands you actually ran and their results; a check you did not run is reported as not
run.

## Full check list

Run `/cw-quality` in Claude Code or `$cw-quality` in Codex without arguments for the local gate.

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:architecture
pnpm test:integration          # NATS and PostgreSQL in Docker
pnpm build
pnpm changeset status
```

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
