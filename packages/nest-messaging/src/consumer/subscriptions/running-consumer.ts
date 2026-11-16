import type { ConsumerMessages } from '@nats-io/jetstream';
import type { EventTarget } from './event-target.js';

/**
 * Interface RunningConsumer
 *
 * @description
 * A durable consumer being pulled by the application.
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
