import { NoRespondersError, RequestError, type Msg } from '@nats-io/transport-node';
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';

import { MessagingConnection } from '../../connection/messaging-connection.js';
import {
  MESSAGING_OPTIONS,
  type ResolvedMessagingOptions,
} from '../../configuration/messaging-options.js';
import { rebuildSubject } from '../../transport/subjects.js';

import { decodeRebuildReply, type RebuildRejection } from '../codec/rebuild-reply-codec.js';
import { RebuildConsumerUnavailableError } from './rebuild-consumer-unavailable-error.js';
import { RebuildFlushTimeoutError } from './rebuild-flush-timeout-error.js';
import { RebuildItemError } from './rebuild-item-error.js';
import { RebuildRejectedError } from './rebuild-rejected-error.js';

/**
 * Interface RebuildTarget
 *
 * @description
 * Where and how `RebuildEmitter.emit` sends an item.
 */
export interface RebuildTarget<TItem> {
  // #region Properties
  /**
   * Property consumer
   *
   * @description
   * Rebuild name of the consumer, its NATS user by default, such as `search`.
   *
   * @type {string}
   * @readonly
   */
  readonly consumer: string;

  /**
   * Property entity
   *
   * @description
   * Name of the entity re-emitted, such as `task`.
   *
   * @type {string}
   * @readonly
   */
  readonly entity: string;

  /**
   * Property schema
   *
   * @description
   * Zod schema of an item; the consumer validates with the same.
   *
   * @type {z.ZodType<TItem>}
   * @readonly
   */
  readonly schema: z.ZodType<TItem>;
  // #endregion
}

/**
 * Class RebuildEmitter
 *
 * @description
 * Lets the owner of an entity re-emit its current state for one consumer, on
 * `rebuild.<consumer>.<entity>`, so the consumer rebuilds an index without replaying the stream.
 * `<consumer>` is the rebuild name of the consumer: its NATS user by default, such as `search`.
 *
 * It is plain NATS, with no stream, in one of two modes (`rebuildAcknowledgement`):
 *
 * - `none` (default): each item is published and the connection is flushed every
 *   `rebuildFlushEvery` items, which paces the emitter on the server but not on the consumer.
 *   An item sent while no consumer listens, refused, or dropped from the bounded consumer
 *   queue is lost. This is the only mode the permissions of
 *   cadenway-ops allow.
 * - `reply`: each item is sent as a request and `emit` resolves when the consumer answered that
 *   it applied it; awaiting each `emit` gives exact back-pressure. The consuming user needs
 *   `allow_responses`.
 *
 * Nothing is stored: a rebuild interrupted by a crash, a NATS loss or a lost item is simply
 * started again, and applying an item twice must be harmless.
 */
@Injectable()
export class RebuildEmitter {
  // #region Properties
  /**
   * Property unflushed
   *
   * @description
   * Number of items published since the last flush, in the `none` mode.
   *
   * @type {number}
   */
  private unflushed: number = 0;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Uses the module's rebuild route, acknowledgement mode and timeout.
   *
   * @param {MessagingConnection} connection - Connection used for publication, requests and flushes.
   * @param {ResolvedMessagingOptions} options - Routing, acknowledgement and batching options.
   * @constructor
   */
  public constructor(
    private readonly connection: MessagingConnection,
    @Inject(MESSAGING_OPTIONS) private readonly options: ResolvedMessagingOptions,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method emit
   *
   * @description
   * Validates one item and sends it to the consumer: published, or sent as a request whose
   * answer it waits for, depending on `rebuildAcknowledgement`.
   *
   * @param {RebuildTarget<TItem>} target - Consumer, entity and item schema.
   * @param {TItem} item - Current state of one entity.
   * @returns {Promise<void>} Resolves once the item was published (and, every `rebuildFlushEvery` items, confirmed by the server), or, in the `reply` mode, once the consumer applied it.
   * @throws {RebuildItemError} When the item does not match the schema; nothing is sent.
   * @throws {RebuildFlushTimeoutError} In the `none` mode, when a flush is not confirmed within `rebuildTimeoutMs`.
   * @throws {RebuildConsumerUnavailableError} In the `reply` mode, when no consumer listens on the subject.
   * @throws {RebuildRejectedError} In the `reply` mode, when the consumer refused the item or its handler failed.
   * @throws {Error} In the `reply` mode, when the consumer does not answer within `rebuildTimeoutMs`.
   */
  public async emit<TItem>(target: RebuildTarget<TItem>, item: TItem): Promise<void> {
    const subject: string = rebuildSubject(
      this.options.rebuildSubjectPrefix,
      target.consumer,
      target.entity,
    );
    const parsed: z.ZodSafeParseResult<TItem> = target.schema.safeParse(item);
    if (!parsed.success) {
      throw new RebuildItemError(
        subject,
        parsed.error.issues.map((issue: z.core.$ZodIssue) => issue.path.map(String).join('.')),
      );
    }
    if (this.options.rebuildAcknowledgement === 'none') {
      this.connection.nats.publish(subject, JSON.stringify(parsed.data));
      this.unflushed += 1;
      if (this.unflushed >= this.options.rebuildFlushEvery) {
        await this.flush();
      }
      return;
    }
    let reply: Msg;
    try {
      reply = await this.connection.nats.request(subject, JSON.stringify(parsed.data), {
        timeout: this.options.rebuildTimeoutMs,
      });
    } catch (error) {
      if (
        error instanceof NoRespondersError ||
        (error instanceof RequestError && error.isNoResponders())
      ) {
        throw new RebuildConsumerUnavailableError(subject, error);
      }
      throw error;
    }
    const rejection: RebuildRejection | null = decodeRebuildReply(reply.string());
    if (rejection !== null) {
      throw new RebuildRejectedError(subject, rejection);
    }
  }

  /**
   * Method flush
   *
   * @description
   * Makes sure the items published so far reached the server. Call it at the end of a rebuild in
   * the `none` mode.
   *
   * @returns {Promise<void>} Resolves when the server answered.
   * @throws {RebuildFlushTimeoutError} When the server does not answer within `rebuildTimeoutMs`, as during an outage.
   */
  public async flush(): Promise<void> {
    this.unflushed = 0;
    let timer: NodeJS.Timeout | undefined;
    const timedOut: Promise<never> = new Promise<never>(
      (_resolve: (value: never) => void, reject: (reason: Error) => void) => {
        timer = setTimeout(() => {
          reject(new RebuildFlushTimeoutError(this.options.rebuildTimeoutMs));
        }, this.options.rebuildTimeoutMs);
      },
    );
    try {
      await Promise.race([this.connection.flush(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
  // #endregion
}
