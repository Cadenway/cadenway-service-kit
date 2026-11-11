# waypoint-service-kit: Claude Code tooling

This `.claude/` folder ships the Claude Code tooling of waypoint-service-kit: **10 agents**,
11 slash commands, 7 rules, 12 skills, 3 hooks, the project
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
claude --add-dir ../waypoint-api-contracts ../waypoint-task-service ../waypoint-api-gateway
```

Their `.claude/agents/` are discovered too, so their `wp-*` roles become available. Peer checkouts
are **read-only** from a waypoint-service-kit session (the guard refuses edits there): change them in their
own session and pull request.

## Agents

Builders write only assigned files, inherit permissions and preserve concurrent work. Reviewers are
read-only: their tools exclude `Edit` and `Write`, and they ask the parent for the output of any
check that writes files. No agent delegates further.

| Agent | Responsibility | Model | Effort | Mode |
| --- | --- | --- | --- | --- |
| `wp-kit-common-builder` | Configuration, guards, logs, traces, health, errors. | opus | high | Assigned writes |
| `wp-kit-messaging-builder` | NATS, outbox, retries, deduplication. | opus | xhigh | Assigned writes |
| `wp-kit-testing-builder` | Test helpers and fixtures. | sonnet | high | Assigned writes |
| `wp-kit-test-writer` | Tests of the kit itself. | sonnet | high | Assigned writes |
| `wp-kit-release-manager` | Changesets and deprecations. | sonnet | medium | Assigned writes |
| `wp-kit-api-stability-reviewer` | Public API and defaults. | opus | high | Read-only |
| `wp-kit-security-reviewer` | Guards, context, logging of secrets. | opus | xhigh | Read-only |
| `wp-kit-observability-reviewer` | Logs, traces, health. | sonnet | high | Read-only |
| `wp-kit-reliability-reviewer` | Delivery guarantees. | opus | xhigh | Read-only |
| `wp-kit-github-maintainer` | Workflows, templates and community files in .github/. | sonnet | medium | Assigned writes |

## Commands

| Command | What it does | Runs |
| --- | --- | --- |
| `/wp-common` | Change @waypoint/nest-common. | `wp-kit-common-builder` |
| `/wp-messaging` | Change @waypoint/nest-messaging. | `wp-kit-messaging-builder` |
| `/wp-testing` | Change @waypoint/nest-testing. | `wp-kit-testing-builder` |
| `/wp-test` | Write tests for the kit. | `wp-kit-test-writer` |
| `/wp-release` | Prepare changesets and deprecations. | `wp-kit-release-manager` |
| `/wp-api-review` | Check public API stability. | `wp-kit-api-stability-reviewer` |
| `/wp-security-review` | Audit guards and logging. | `wp-kit-security-reviewer` |
| `/wp-observability-review` | Review logs and traces. | `wp-kit-observability-reviewer` |
| `/wp-reliability-review` | Review delivery guarantees. | `wp-kit-reliability-reviewer` |
| `/wp-github` | Change workflows, templates or community files in .github/. | `wp-kit-github-maintainer` |
| `/wp-quality` | Run the local quality gate, stopping at the first failure. | runs the commands itself |

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
| `wp-context` | What Waypoint is, where the mockup, the integration guide and the repository map live, the product vocabulary (spaces, lists, sprints, tasks, statuses, milestones) and the multi-repository ownership rules. |
| `wp-outbox-design` | How the outbox, the relay, deduplication, retries and dead letters of @waypoint/nest-messaging work together. |
| `wp-kit-api-stability` | Rules for changing a package every service depends on: options with safe defaults, deprecation before removal, migration notes. |

## Hooks

| Hook | When | What it refuses or does |
| --- | --- | --- |
| `guard.mjs` | before `Write`, `Edit` or `MultiEdit` | Sibling checkouts, generated trees, lockfiles, `.git/`, secrets and tokens, `export *` in public entry points, unpinned third-party actions and `pull_request_target` in workflows. |
| `guard-git.mjs` | before `Bash` or `PowerShell` | Pushes to `main`, tag pushes, force-pushes, rewrites of pushed commits, hook bypasses, destructive resets, registry publishing, branch names outside `<type>/<kebab>`. Adapted from the dentalstock guard. |
| `format.mjs` | after a successful `Write`, `Edit` or `MultiEdit` | Formats supported files with the repository's Prettier; a no-op until the formatter is installed. |
