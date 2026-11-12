---
description: "Run the local quality gate, stopping at the first failure."
allowed-tools: Bash(pnpm format:check), Bash(pnpm lint), Bash(pnpm typecheck), Bash(pnpm test), Bash(pnpm test:integration), Bash(pnpm build), Bash(pnpm changeset status)
---

Run in order and stop at the first failure: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm changeset status`. A missing script is reported as **not available**. End with one line per step: PASS, FAIL, not run or not available.
