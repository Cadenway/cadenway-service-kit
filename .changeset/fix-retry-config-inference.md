---
'@cadenway/nest-common': patch
---

Preserve the numeric transaction retry limit when spreading `databaseConfigShape` into a Zod schema. Manually supplied `DatabaseConfig` values can still omit the setting.
