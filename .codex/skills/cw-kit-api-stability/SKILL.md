---
name: cw-kit-api-stability
description: "Rules for changing a package every service depends on: options with safe defaults, deprecation before removal, migration notes. Load it for any change."
---

# API stability of the kit

- New behavior: behind an option, default unchanged.
- Rename or removal: deprecate in a minor (JSDoc `@deprecated`, a start-up warning), remove in the next
  major with a migration note per affected service.
