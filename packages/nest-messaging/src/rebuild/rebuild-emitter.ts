import { NoRespondersError, RequestError, type Msg } from '@nats-io/transport-node';
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';

import { MessagingConnection } from '../connection/messaging-connection.js';
import { MESSAGING_OPTIONS, type ResolvedMessagingOptions } from '../messaging-options.js';
import { rebuildSubject } from '../subjects.js';

/**
 * Type RebuildRejection
 *
 * @description
 * Why a consumer refused a rebuild item: the item does not match the schema the consumer
 * validates with, or its handler failed.
 *
 * @type {'invalid-item' | 'handler-failed'}
 */
export type RebuildRejection = 'invalid-item' | 'handler-failed';

/**
 * Class RebuildRejectedError
 *
 * @description
 * Raised by `RebuildEmitter.emit` when the consumer answered that it did not apply the item.
 * The emitter may send the item again: a rebuild is restartable.
 */
export class RebuildRejectedError extends Error {
  // #region Properties
  /**
   * Property reason
   *
   * @description
   * Why the consumer refused the item.
   *
   * @type {RebuildRejection}
   * @readonly
   */
  public readonly reason: RebuildRejection;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Builds the error.
   *
   * @param {string} subject - Rebuild subject the item was sent on.
   * @param {RebuildRejection} reason - Why the consumer refused the item.
   * @constructor
   */
  public constructor(subject: string, reason: RebuildRejection) {
    super(`The consumer of ${subject} refused a rebuild item: ${reason}.`);
    this.name = 'RebuildRejectedError';
    this.reason = reason;
  }
  // #endregion
}

/**
 * Class RebuildItemError
 *
 * @description
 * Raised by `RebuildEmitter.emit` when the item does not match the schema it was given with.
 * Nothing is sent, and the message names fields only, never a value.
 */
export class RebuildItemError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Builds the error from the fields that do not match.
   *
   * @param {string} subject - Rebuild subject the item was meant for.
   * @param {readonly string[]} fields - Dotted paths of the fields that do not match.
   * @constructor
   */
  public constructor(subject: string, fields: readonly string[]) {
    super(
      `A rebuild item for ${subject} does not match its schema (${fields.join(', ') || 'item'}).`,
    );
    this.name = 'RebuildItemError';
  }
  // #endregion
}

/**
 * Class RebuildConsumerUnavailableError
 *
 * @description
 * Raised by `RebuildEmitter.emit` when no consumer listens on the rebuild subject: the consuming
 * service is down or did not register the entity.
 */
export class RebuildConsumerUnavailableError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Builds the error.
   *
   * @param {string} subject - Rebuild subject nobody listens on.
   * @param {unknown} cause - Error of the NATS client.
   * @constructor
   */
  public constructor(subject: string, cause: unknown) {
    super(`No consumer listens on ${subject}.`, { cause });
    this.name = 'RebuildConsumerUnavailableError';
  }
  // #endregion
}

/**
 * Function encodeRebuildReply
 *
 * @description
 * Encodes the answer of a consumer to one rebuild item.
 *
 * @param {RebuildRejection | null} rejection - Why the item was refused, or `null` when it was applied.
 * @returns {string} The reply payload, as JSON.
 */
export function encodeRebuildReply(rejection: RebuildRejection | null): string {
  return JSON.stringify(rejection === null ? { ok: true } : { ok: false, reason: rejection });
}

/**
 * Function decodeRebuildReply
 *
 * @description
 * Decodes the answer of a consumer to one rebuild item.
 *
 * @param {string} reply - Reply payload.
 * @returns {RebuildRejection | null} Why the item was refused, or `null` when it was applied.
 * @throws {Error} When the reply is not one the kit sends.
 */
export function decodeRebuildReply(reply: string): RebuildRejection | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(reply);
  } catch {
    decoded = undefined;
  }
  if (typeof decoded === 'object' && decoded !== null && 'ok' in decoded) {
    if (decoded.ok === true) {
      return null;
    }
    if (
      decoded.ok === false &&
      'reason' in decoded &&
      (decoded.reason === 'invalid-item' || decoded.reason === 'handler-failed')
    ) {
      return decoded.reason;
    }
  }
  throw new Error('Unexpected reply to a rebuild item.');
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
 *   An item the consumer cannot take in time, or sent while no consumer listens, is lost. This
 *   is the only mode the permissions of cadenway-ops allow.
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
   * Stores the connection and the options.
   *
   * @param {MessagingConnection} connection - NATS connection of the application.
   * @param {ResolvedMessagingOptions} options - Options of the module.
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
   * @param {string} consumer - Rebuild name of the consumer, its NATS user by default, such as `search`.
   * @param {string} entity - Name of the entity re-emitted, such as `task`.
   * @param {z.ZodType<TItem>} schema - Zod schema of an item; the consumer validates with the same.
   * @param {TItem} item - Current state of one entity.
   * @returns {Promise<void>} Resolves once the item was published (and, every `rebuildFlushEvery` items, flushed), or, in the `reply` mode, once the consumer applied it.
   * @throws {RebuildItemError} When the item does not match the schema; nothing is sent.
   * @throws {RebuildConsumerUnavailableError} In the `reply` mode, when no consumer listens on the subject.
   * @throws {RebuildRejectedError} In the `reply` mode, when the consumer refused the item or its handler failed.
   * @throws {Error} In the `reply` mode, when the consumer does not answer within `rebuildTimeoutMs`.
   */
  public async emit<TItem>(
    consumer: string,
    entity: string,
    schema: z.ZodType<TItem>,
    item: TItem,
  ): Promise<void> {
    const subject: string = rebuildSubject(this.options.rebuildSubjectPrefix, consumer, entity);
    const parsed: z.ZodSafeParseResult<TItem> = schema.safeParse(item);
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
        this.unflushed = 0;
        await this.connection.flush();
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
   */
  public async flush(): Promise<void> {
    this.unflushed = 0;
    await this.connection.flush();
  }
  // #endregion
}
