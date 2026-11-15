/**
 * Entry point `@cadenway/nest-common/redis`: an ioredis client whose dropped command promises
 * cannot stop the process, the pub/sub connections of an adapter derived from it, and the
 * `REDIS_URL` configuration shape.
 *
 * Kept apart from the main entry point because `ioredis` is an optional peer: an application
 * without Redis never imports this file.
 *
 * @packageDocumentation
 */
export { redisConfigShape, type RedisConfig } from './redis-config.js';
export {
  createPubSubClients,
  pubSubClientOptions,
  ResilientRedisClient,
  type PubSubClients,
  type PubSubRole,
  type ResilientRedisOptions,
} from './resilient-redis-client.js';
