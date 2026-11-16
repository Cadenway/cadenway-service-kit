---
'@cadenway/nest-messaging': patch
---

Separate JetStream subscriptions, delivery and recovery behind the existing `EventConsumers`
provider, and share the rebuild reply codec between the receiver and emitter.
