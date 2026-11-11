# @waypoint/nest-messaging

Messaging plumbing for the Waypoint NestJS services and gateways.

**Status: package shell.** Nothing is implemented yet and the entry point exports nothing. The
package will hold the NATS JetStream connection, the outbox publication, the subscriptions with
retries and dead letters, and the deduplication of redelivered events, as listed in the
[repository instructions](../../AGENTS.md).
