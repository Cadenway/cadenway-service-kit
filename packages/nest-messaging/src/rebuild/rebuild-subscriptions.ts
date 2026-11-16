import { runWithOrganizationContext, type OrganizationContext } from '@cadenway/nest-common';
import type { Msg, Subscription } from '@nats-io/transport-node';
import type { Logger } from '@nestjs/common';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import type { z } from 'zod';

import type { MessagingConnection } from '../connection/messaging-connection.js';
import type { ResolvedMessagingOptions } from '../messaging-options.js';
import { rebuildSubject } from '../subjects.js';
import { encodeRebuildReply } from './rebuild-reply-codec.js';
import type { RebuildSubscription } from './rebuild-subscription.js';

/**
 * Interface RunningRebuild
 *
 * @description
 * A rebuild subscription being served.
 */
interface RunningRebuild {
  // #region Properties
  /**
   * Property subscription
   *
   * @description
   * Core NATS subscription on the rebuild subject.
   *
   * @type {Subscription}
   * @readonly
   */
  readonly subscription: Subscription;

  /**
   * Property done
   *
   * @description
   * Resolves when the last handler call returned.
   *
   * @type {Promise<void>}
   * @readonly
   */
  readonly done: Promise<void>;
  // #endregion
}

/**
 * Constant NO_ORGANIZATION
 *
 * @description
 * Organization context of the work that belongs to no organization: rebuild handlers.
 *
 * @type {OrganizationContext}
 */
const NO_ORGANIZATION: OrganizationContext = {
  organizationId: null,
  actor: { type: 'system', id: null },
  role: null,
  scopes: [],
};

/**
 * Class RebuildSubscriptions
 *
 * @description
 * Registers receivers for rebuilt entities and applies each entity's items in delivery order.
 */
export class RebuildSubscriptions {
  // #region Properties
  /**
   * Property rebuilds
   *
   * @description
   * Rebuild subscriptions being served, by subject.
   *
   * @type {Map<string, RunningRebuild>}
   * @readonly
   */
  private readonly rebuilds: Map<string, RunningRebuild> = new Map<string, RunningRebuild>();
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Sets the subject naming and queue bound for the application's rebuild handlers.
   *
   * @param {MessagingConnection} connection - NATS connection of the application.
   * @param {ResolvedMessagingOptions} options - Rebuild routing and queue options.
   * @param {Logger} logger - Shared consumer logger.
   * @param {AbortSignal} shutdown - Stops registration on application shutdown.
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
   * Registers the handler of a rebuilt entity: items the owner of the entity emits on
   * `rebuild.<rebuildName>.<entity>` (the NATS user of this application by default) are
   * validated and applied one at a time, in a context without organization; an item sent as a
   * request is answered. Replicas share the items through a queue group. When more than
   * `rebuildMaxPending` items wait, the oldest ones are dropped with an error log.
   *
   * @param {RebuildSubscription<TItem>} registration - Entity, item schema and handler.
   * @returns {Promise<void>} Resolves once the server knows the subscription: an emitter that starts afterwards finds the consumer.
   * @throws {Error} When the entity is already registered or its name cannot be a subject token.
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
    const subscription: Subscription = this.connection.nats.subscribe(subject, {
      queue: this.options.rebuildName,
    });
    // The loop starts in an explicit context: it must not inherit the organization, or the
    // trace, of whoever registered the handler.
    const done: Promise<void> = context.with(ROOT_CONTEXT, () =>
      runWithOrganizationContext(NO_ORGANIZATION, () =>
        this.serveRebuild(subject, subscription, registration),
      ),
    );
    this.rebuilds.set(subject, { subscription, done });
    await this.connection.flush();
    this.logger.log({ subject }, 'rebuild handler started');
  }

  /**
   * Method close
   *
   * @description
   * Unsubscribes each receiver and returns the completions for the shutdown deadline.
   *
   * @returns {Promise<void>[]} Completions of the current rebuild handlers.
   */
  public close(): Promise<void>[] {
    const running: Promise<void>[] = [];
    for (const rebuild of this.rebuilds.values()) {
      running.push(rebuild.done);
      rebuild.subscription.unsubscribe();
    }
    return running;
  }

  /**
   * Method serveRebuild
   *
   * @description
   * Applies the rebuild items of one entity, one at a time, answers each request, and drops the
   * oldest waiting items while more than `rebuildMaxPending` wait.
   *
   * @param {string} subject - Rebuild subject.
   * @param {Subscription} subscription - Subscription on the subject.
   * @param {RebuildSubscription<TItem>} registration - Item schema and handler.
   * @returns {Promise<void>} Resolves when the subscription closed and the last item was answered.
   */
  private async serveRebuild<TItem>(
    subject: string,
    subscription: Subscription,
    registration: RebuildSubscription<TItem>,
  ): Promise<void> {
    let dropped: number = 0;
    try {
      for await (const message of subscription as AsyncIterable<Msg>) {
        if (subscription.getPending() > this.options.rebuildMaxPending) {
          dropped += 1;
          message.respond(encodeRebuildReply('overloaded'));
          if (dropped === 1 || dropped % 1000 === 0) {
            this.logger.error(
              { subject, dropped, maxPending: this.options.rebuildMaxPending },
              'rebuild items arrive faster than they are applied: dropped',
            );
          }
          continue;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(message.string());
        } catch {
          decoded = undefined;
        }
        const parsed: z.ZodSafeParseResult<TItem> = registration.schema.safeParse(decoded);
        if (!parsed.success) {
          message.respond(encodeRebuildReply('invalid-item'));
          this.logger.error({ subject }, 'rebuild item does not match its schema: refused');
          continue;
        }
        try {
          await registration.handle(parsed.data);
          message.respond(encodeRebuildReply(null));
        } catch (error) {
          message.respond(encodeRebuildReply('handler-failed'));
          this.logger.warn({ subject, err: error }, 'rebuild handler failed');
        }
      }
    } catch (error) {
      this.logger.error({ subject, err: error }, 'rebuild subscription failed');
    }
  }
  // #endregion
}
