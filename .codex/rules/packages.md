---
paths:
  - 'packages/**'
---

# Packages

- Plumbing only; no business rule, no service-specific code.
- Every option has a safe default documented in the package README; defaults never change silently.
- Explicit named exports; NestJS and the contracts are peer dependencies.
