# cadenway-service-kit: Claude Code tooling

This `.claude/` folder ships the Claude Code tooling of cadenway-service-kit: **9 agents**,
10 slash commands, 7 rules, 14 skills, 3 hooks, the project
settings.

Start from [AGENTS.md](../AGENTS.md) (the rules every assistant follows) and [CLAUDE.md](../CLAUDE.md)
(the Claude entry point).

## Settings (`settings.json`)

- **Hooks** are wired through `${CLAUDE_PROJECT_DIR}` so they resolve from any working directory:
  `guard.mjs` before every `Write` / `Edit` / `MultiEdit`, `guard-git.mjs` before every `Bash` /
  `PowerShell` command, and `format.mjs` after matching edit events for supported files.
  Apply the repository rules across tools.
- **Permissions** allow specific repository commands and read-only Git commands. The project
  denies `Read` on `.env` and `.env.*`. Follow the repository secret-handling rules across tools.
  The project does not pre-approve `git push`, `gh` writes or arbitrary shell commands.
- **Fast mode is off** (`fastMode: false` and `CLAUDE_CODE_DISABLE_FAST_MODE=1`). Agent models and
  efforts are explicit in each agent's frontmatter; do not silently substitute a model.
- **MCP**: `enabledMcpjsonServers` enables `context7` from the root `.mcp.json`.
- **No plugins** are enabled (`enabledPlugins: {}`). The folder is itself a plugin
  (`.claude-plugin/plugin.json`, `hooks/hooks.json`) for installations outside this checkout.

## Working with the sibling repositories

Start from this checkout and attach the peers you need, for example:

```powershell
claude --add-dir ../cadenway-api-contracts ../cadenway-task-service ../cadenway-api-gateway
```

Their `.claude/agents/` are discovered too, so their `cw-*` roles become available. Peer checkouts
are **read-only** from a cadenway-service-kit session (the guard refuses edits there): change them in their
own session and pull request.

## Agents

Builders write only assigned files, inherit permissions and preserve concurrent work. Reviewers are
read-only: their tools exclude `Edit` and `Write`, and they ask the parent for the output of any
check that writes files. No agent delegates further.

| Agent | Responsibility | Model | Effort | Mode |
| --- | --- | --- | --- | --- |
| `cw-kit-common-builder` | Configuration, guards, logs, traces, health, errors. | opus | high | Assigned writes |
| `cw-kit-messaging-builder` | NATS, outbox, retries, deduplication. | opus | xhigh | Assigned writes |
| `cw-kit-test-writer` | Tests of the kit itself. | sonnet | high | Assigned writes |
| `cw-kit-release-manager` | Changesets and deprecations. | sonnet | medium | Assigned writes |
| `cw-kit-api-stability-reviewer` | Public API and defaults. | opus | high | Read-only |
| `cw-kit-security-reviewer` | Guards, context, logging of secrets. | opus | xhigh | Read-only |
| `cw-kit-observability-reviewer` | Logs, traces, health. | sonnet | high | Read-only |
| `cw-kit-reliability-reviewer` | Delivery guarantees. | opus | xhigh | Read-only |
| `cw-kit-github-maintainer` | Workflows, templates and community files in .github/. | sonnet | medium | Assigned writes |

## Commands

| Command | What it does | Runs |
| --- | --- | --- |
| `/cw-common` | Change @cadenway/nest-common. | `cw-kit-common-builder` |
| `/cw-messaging` | Change @cadenway/nest-messaging. | `cw-kit-messaging-builder` |
| `/cw-test` | Write tests for the kit. | `cw-kit-test-writer` |
| `/cw-release` | Prepare changesets and deprecations. | `cw-kit-release-manager` |
| `/cw-api-review` | Check public API stability. | `cw-kit-api-stability-reviewer` |
| `/cw-security-review` | Audit guards and logging. | `cw-kit-security-reviewer` |
| `/cw-observability-review` | Review logs and traces. | `cw-kit-observability-reviewer` |
| `/cw-reliability-review` | Review delivery guarantees. | `cw-kit-reliability-reviewer` |
| `/cw-github` | Change workflows, templates or community files in .github/. | `cw-kit-github-maintainer` |
| `/cw-quality` | Run the local quality gate, stopping at the first failure. | runs the commands itself |

## Rules

| File | Subject | Loads for |
| --- | --- | --- |
| `packages.md` | Packages | `packages/**` |
| `messaging.md` | Messaging | `packages/nest-messaging/**` |
| `testing.md` | Tests | `packages/**/*.spec.ts` |
| `language.md` | Language | always |
| `git-and-commits.md` | Git and commits | always |
| `comments.md` | Comments and docblocks | `packages/**/*.ts` |
| `github.md` | GitHub files | `.github/**` |

## Skills

See [skills/](skills/) for the complete inventory, including the technology guides.

| Skill | Use |
| --- | --- |
| `cw-context` | What Cadenway is, where the mockup, the integration guide and the repository map live, the product vocabulary (spaces, lists, sprints, tasks, statuses, milestones) and the multi-repository ownership rules. |
| `cw-outbox-design` | How the outbox, the relay, deduplication, retries and dead letters of @cadenway/nest-messaging work together. |
| `cw-kit-api-stability` | Rules for changing a package every service depends on: options with safe defaults, deprecation before removal, migration notes. |
| `cw-logging-and-tracing` | The log fields, redaction, trace propagation, metrics and OpenTelemetry start-up shared by every Cadenway backend. |
| `cw-jobs` | How a Cadenway service runs durable background jobs with @cadenway/nest-jobs: a job enqueued in the use case transaction, occurrence keys, retries, dead letters, schedules. |

## Hooks

| Hook | When | What it refuses or does |
| --- | --- | --- |
| `guard.mjs` | before `Write`, `Edit` or `MultiEdit` | Sibling checkouts, generated trees, lockfiles, `.git/`, secrets and tokens, `export *` in public entry points, unpinned third-party actions and `pull_request_target` in workflows. |
| `guard-git.mjs` | before `Bash` or `PowerShell` | Pushes to `main`, tag pushes, force-pushes, rewrites of pushed commits, hook bypasses, destructive resets, registry publishing, branch names outside `<type>/<kebab>`. Adapted from the dentalstock guard. |
| `format.mjs` | after a successful `Write`, `Edit` or `MultiEdit` | Formats supported files with the repository's Prettier; a no-op until the formatter is installed. |
