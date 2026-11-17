# cadenway-service-kit: agent instructions

These shared instructions apply to every assistant. Explicit user instructions take precedence over
procedures within the hard limits below. Claude Code imports this file through [CLAUDE.md](CLAUDE.md).

## First read

- Read the package's README before changing it. For messaging, use the installed
  `@cadenway/contracts` for the exact published and consumed shapes.
- Use `cw-kit-api-stability` for package changes. Read `package.json` for versions and scripts
  and avoid restating versions.
- See "cadenway-service-kit" in the
  [repositories document](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N) as needed.

## What this repository is

This repository publishes the three NestJS runtime packages: `@cadenway/nest-common`,
`@cadenway/nest-messaging` and `@cadenway/nest-jobs`. The [architecture guide](docs/architecture.md)
maps capabilities to packages. Development-only
[`@cadenway/nest-testing`](https://github.com/Cadenway/cadenway-tooling/tree/main/packages/nest-testing)
belongs to cadenway-tooling. Check the checkout before relying on the bootstrap target.

## Language

- Everything written in the repository is **English**: code, comments, docs, agent prompts, rules,
  skills, commit messages, branch names, PR titles and descriptions.
- Follow the user's language in the conversation only. No emojis.
- Never invent facts about the product, the contracts, the mockup or the tooling: cite the file or
  the document. When something does not exist yet, say so and say which step of the start-up plan
  brings it.

## Architectural ownership

Use the [integration guide](docs/integration.md) for package contracts and the skills that match
the change: `cw-outbox-design`, `cw-logging-and-tracing` or `cw-jobs`. Keep each shared runtime
facility in the package that owns it.

## Boundaries (hard rules)

- No business logic, no knowledge of a specific service.
- No direct dependency on a service repository.
- Public API through explicit exports; breaking changes are majors with a deprecation first.

## GitHub files (`.github/`)

Keep this repository's [README](.github/README.md), community files, templates, code owners and
complete workflows in `.github/`. Cadenway has no organization-level files, cross-repository
reusable workflows or shared Renovate preset. Use the paired `github.md` rules when editing
GitHub files. Apply changes to shared material through separate pull requests in each owner.

## Code quality

- Read the affected entry point, its callers, and its relevant tests before editing.
  Preserve the behavior callers rely on unless the task changes it.
- Keep the diff focused. Use names that express intent and reuse existing code when
  it preserves the required behavior. Extract code when it clarifies a responsibility.
- Keep business decisions with their owning module. Validate external inputs at the
  boundary and use documented public interfaces across modules and repositories.
- For writes that can fail, overlap, or be retried, verify the resulting state.
  Check transaction boundaries, tenant scope, and repeated delivery where relevant.
- For collections and repeated work, check what grows with input size. Measure or
  inspect the bottleneck before adding an index, cache, worker, or replica.
- Run the repository checks that cover the affected behavior. Report the commands
  and their results, including checks that did not run and tests that selected zero cases.

## Commands and quality gates

Start with the smallest check that covers the change. See the
[full local gate](docs/development.md#full-local-quality-gate) for the repository-wide sequence.

| Changed                         | Minimum check                                   |
| ------------------------------- | ----------------------------------------------- |
| nest-common                     | `pnpm test packages/nest-common`                |
| nest-messaging                  | `pnpm test:integration packages/nest-messaging` |
| nest-jobs                       | `pnpm test:integration packages/nest-jobs`      |
| Any change to a package         | a changeset                                     |
| Docs or agent instructions only | Scoped formatting and link review               |

## Git and branch flow

Use the paired `git-and-commits.md` rule for trunk-based branches, Conventional Commits and
staging only task files. Validate branch names with `git check-ref-format --branch <name>`.

Pull requests target `main` and are squash-merged after review and green CI. Add a changeset
for package changes. The Version Packages PR bumps versions and its merge publishes in CI.
Renovate updates services and gateways. See [collaboration and release](docs/development.md#collaboration-and-release).

## Hard limits (never without the user's explicit request in this conversation)

- Never push to `main`, merge into it locally, create or push Git tags, or bump a version by hand.
- Never run a registry publish (`npm publish`, `pnpm publish`): the release workflow publishes.
- Never force-push, and never amend or rebase commits that are already pushed.
- Never bypass the Git hooks (`--no-verify`, `core.hooksPath` overrides, `ALLOW_MAIN_PUSH=1`,
  `CW_SKIP_PUSH_CHECKS=1`).
- Never write a token, password or private key anywhere; `.npmrc` keeps `${NODE_AUTH_TOKEN}`. Do
  not read or write secret environment files; new variables are documented in `.env.example`.
- Never edit generated trees (`dist/`, `node_modules/`, `coverage/`) or lockfiles by hand.
- Never modify a sibling checkout (`../cadenway-*`) from a task in this repository.
- Never change the outbox table schema without a migration path documented for every service.

The agent hooks enforce most of these mechanically; a refused command is a signal to stop and ask,
not to find another way around it.

## Agent tooling

Use the [Claude](.claude/README.md#agents) or [Codex](.codex/README.md) guide for specialists,
commands, skills, scoped rules and hooks. Read the active assistant's matching rules for every
touched path and load skills relevant to the task. Specialists are available when needed.
Give each delegate a bounded assignment, owning checkout, explicit files and checks. Keep
parallel write scopes disjoint and integrate the results.

## Repository hygiene

- Reuse existing commands, tools and test infrastructure before adding files.
- Prefer inline commands or a task-specific temporary directory for one-off diagnostics; clean up
  disposable files before delivery.
- Keep a permanent script only when it provides a reusable capability that existing tooling cannot.
  Place it with the technology or workflow that owns it. Do not create a generic `scripts/` directory.
- Add permanent tests for meaningful behavior or regressions, in the existing test structure.
- Before delivery, inspect untracked files and remove only the disposable artifacts of the current
  task. Report every new permanent tooling file and why it needs to stay.
- Report material failures, skipped checks and limitations, including non-blocking ones. Ask for
  user input only when a missing decision or authorization blocks the dependent work.

## References

Use the [documentation index](docs/README.md#sources-and-policy) for the mockup, integration
guide and repositories document.
