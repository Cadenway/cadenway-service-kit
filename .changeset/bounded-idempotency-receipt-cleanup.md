---
'@cadenway/nest-common': minor
---

Add `purgeExpiredIdempotencyKeyBatch` for scheduled idempotency cleanup in bounded system
transactions. It skips locked receipts and works with the existing table and expiry index.
The unbounded purge remains available through its original API.
