import type { Msg, Subscription } from '@nats-io/transport-node';
import type { Logger } from '@nestjs/common';

import type { MessagingConnection } from '../../connection/messaging-connection.js';
import type { ResolvedMessagingOptions } from '../../configuration/messaging-options.js';
import { rebuildSubject } from '../../transport/subjects.js';
import type { RebuildSubscription } from './rebuild-subscription.js';
import { RebuildWorker } from './rebuild-worker.js';

/**
 * Class RebuildSubscriptions
 *
 * @description
 * Owns the registration and shutdown of Core NATS rebuild subscriptions.
 */
export class RebuildSubscriptions {
  // #region Properties
  /**
   * Property rebuilds
   *
   * @description
   * Close operations for registered subscriptions, by subject.
   *
   * @type {Map<string, () => Promise<void>>}
   * @readonly
   */
  private readonly rebuilds = new Map<string, () => Promise<void>>();
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Shares the application's NATS connection and rebuild routing settings.
   *
   * @param {MessagingConnection} connection - Connection used to subscribe and confirm the registration.
   * @param {ResolvedMessagingOptions} options - Rebuild routing and admission settings.
   * @param {Logger} logger - Logger for subscription and handler diagnostics.
   * @param {AbortSignal} shutdown - Signal that stops new registrations on application shutdown.
   * @constructor
   */
  public constructor(
    private readonly connection: MessagingConnection,
    private readonly options: ResolvedMessagingOptions,
    private readonly logger: Logger,
    private readonly shutdown: AbortSignal,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method onRebuild
   *
   * @description
   * Registers a rebuild handler and waits for the server to receive its subscription.
   *
   * @param {RebuildSubscription<TItem>} registration - Entity name, item schema and handler.
   * @returns {Promise<void>} Resolves when the subscription is known to the broker.
   */
  public async onRebuild<TItem>(registration: RebuildSubscription<TItem>): Promise<void> {
    if (this.shutdown.aborted) {
      throw new Error('The application is shutting down: no handler can be registered.');
    }
    const subject: string = rebuildSubject(
      this.options.rebuildSubjectPrefix,
      this.options.rebuildName,
      registration.entity,
    );
    if (this.rebuilds.has(subject)) {
      throw new Error(`The rebuild of ${registration.entity} is already registered.`);
    }
    const worker = new RebuildWorker<TItem>(
      subject,
      registration,
      this.options.rebuildMaxPending,
      this.connection.nats,
      this.logger,
    );
    // A callback bypasses the client's unbounded pending iterator.
    const subscription: Subscription = this.connection.nats.subscribe(subject, {
      queue: this.options.rebuildName,
      callback: (error: Error | null, message: Msg): void => {
        if (error !== null) {
          this.logger.error({ subject, err: error }, 'rebuild subscription failed');
          return;
        }
        worker.accept(message);
      },
    });
    const close = (): Promise<void> => {
      subscription.unsubscribe();
      return worker.close();
    };
    this.rebuilds.set(subject, close);
    void subscription.closed.then((error) => {
      if (error instanceof Error) {
        this.logger.error({ subject, err: error }, 'rebuild subscription failed');
      }
      return worker.close();
    });
    try {
      await this.connection.flush();
    } catch (error) {
      this.rebuilds.delete(subject);
      void close();
      throw error;
    }
    this.logger.log({ subject }, 'rebuild handler started');
  }

  /**
   * Method close
   *
   * @description
   * Unsubscribes all receivers and returns completions for the shutdown deadline.
   *
   * @returns {Promise<void>[]} Settlements for active handlers after the receivers stop taking new work.
   */
  public close(): Promise<void>[] {
    const running: Promise<void>[] = [];
    for (const close of this.rebuilds.values()) {
      running.push(close());
    }
    this.rebuilds.clear();
    return running;
  }
  // #endregion
}
