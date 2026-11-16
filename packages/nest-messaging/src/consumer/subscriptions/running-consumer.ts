import type { ConsumerMessages } from '@nats-io/jetstream';
import type { EventTarget } from './event-target.js';

/**
 * Interface RunningConsumer
 *
 * @description
 * A durable consumer being pulled, with what its recovery needs.
 */
export interface RunningConsumer {
  // #region Properties
  /**
   * Property target
   *
   * @description
   * Registered handler.
   *
   * @type {EventTarget}
   * @readonly
   */
  readonly target: EventTarget;

  /**
   * Property startedAt
   *
   * @description
   * Instant the handler was registered, in milliseconds.
   *
   * @type {number}
   * @readonly
   */
  readonly startedAt: number;

  /**
   * Property lastHandledAt
   *
   * @description
   * Stream time of the last message this process answered for good, in milliseconds.
   *
   * @type {number | undefined}
   */
  lastHandledAt: number | undefined;

  /**
   * Property retrying
   *
   * @description
   * Stream time of the messages waiting for a redelivery, by stream sequence, in milliseconds.
   *
   * @type {Map<number, number>}
   * @readonly
   */
  readonly retrying: Map<number, number>;

  /**
   * Property messages
   *
   * @description
   * Current pull loop of the client; closing it stops pulling.
   *
   * @type {ConsumerMessages | undefined}
   */
  messages: ConsumerMessages | undefined;

  /**
   * Property done
   *
   * @description
   * Resolves when the handler stopped for good.
   *
   * @type {Promise<void>}
   */
  done: Promise<void>;
  // #endregion
}
