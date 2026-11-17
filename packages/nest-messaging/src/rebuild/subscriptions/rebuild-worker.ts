import { runWithOrganizationContext, type OrganizationContext } from '@cadenway/nest-common';
import type { Msg, NatsConnection } from '@nats-io/transport-node';
import type { Logger } from '@nestjs/common';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import type { z } from 'zod';

import { errorCategoryOf } from '../../observability/error-class.js';
import { encodeRebuildReply, type RebuildRejection } from '../codec/rebuild-reply-codec.js';
import { RebuildQueue, type RebuildItem } from './rebuild-queue.js';
import type { RebuildSubscription } from './rebuild-subscription.js';

/**
 * Constant MAX_REBUILD_PENDING_BYTES
 *
 * @description
 * Waiting payload and reply-subject byte budget per rebuild subscription.
 *
 * @type {number}
 */
const MAX_REBUILD_PENDING_BYTES: number = 16 * 1024 * 1024;

/**
 * Constant NO_ORGANIZATION
 *
 * @description
 * Rebuild handlers open their own transactions outside of any organization.
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
 * Constant decoder
 *
 * @description
 * Decodes rebuild payloads as UTF-8 before JSON validation.
 *
 * @type {TextDecoder}
 */
const decoder: TextDecoder = new TextDecoder();

/**
 * Function decodeItem
 *
 * @description
 * Decodes wire data for schema validation, treating malformed JSON as an invalid item.
 *
 * @param {RebuildItem} item - Admission item containing the wire payload.
 * @returns {unknown} Decoded JSON value, or undefined when the wire data is malformed.
 */
function decodeItem(item: RebuildItem): unknown {
  try {
    return JSON.parse(decoder.decode(item.data)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Class RebuildWorker
 *
 * @description
 * Accepts bounded rebuild work and delivers items serially in a clean execution context.
 */
export class RebuildWorker<TItem> {
  // #region Properties
  /**
   * Property pending
   *
   * @description
   * Waiting items. The active item is removed before the handler starts.
   *
   * @type {RebuildQueue}
   * @readonly
   */
  private readonly pending: RebuildQueue;

  /**
   * Property active
   *
   * @description
   * Completion of the current delivery loop, if active.
   *
   * @type {Promise<void> | undefined}
   */
  private active: Promise<void> | undefined;

  /**
   * Property dropped
   *
   * @description
   * Number of items evicted or refused due to overload.
   *
   * @type {number}
   */
  private dropped: number = 0;

  /**
   * Property closed
   *
   * @description
   * Whether intake has permanently stopped.
   *
   * @type {boolean}
   */
  private closed: boolean = false;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Binds a handler and its queue to a rebuild subject.
   *
   * @param {string} subject - Rebuild subject used for delivery diagnostics.
   * @param {RebuildSubscription<TItem>} registration - Validation schema and handler bound to this subscription.
   * @param {number} maxPending - Maximum number of waiting items.
   * @param {NatsConnection} nats - Connection used to respond to rebuild requests.
   * @param {Logger} logger - Logger for delivery failures and queue overload.
   * @constructor
   */
  public constructor(
    private readonly subject: string,
    private readonly registration: RebuildSubscription<TItem>,
    private readonly maxPending: number,
    private readonly nats: NatsConnection,
    private readonly logger: Logger,
  ) {
    this.pending = new RebuildQueue(maxPending, MAX_REBUILD_PENDING_BYTES);
  }
  // #endregion

  // #region Methods
  /**
   * Method accept
   *
   * @description
   * Accepts or refuses a message synchronously, before the NATS callback returns.
   *
   * @param {Msg} message - Incoming NATS item and its optional reply subject.
   */
  public accept(message: Msg): void {
    const reply: string = message.reply ?? '';
    if (this.closed) {
      this.reply(reply, 'handler-failed');
      return;
    }
    this.pending.enqueue(message.data, reply, (discardedReply: string) => {
      this.overloaded(discardedReply);
    });
    if (this.active !== undefined) {
      return;
    }
    const first: RebuildItem | undefined = this.pending.dequeue();
    if (first !== undefined) {
      this.active = Promise.resolve().then(() =>
        context.with(ROOT_CONTEXT, () =>
          runWithOrganizationContext(NO_ORGANIZATION, () => this.run(first)),
        ),
      );
    }
  }

  /**
   * Method close
   *
   * @description
   * Releases queued items and lets the active handler finish within the caller's deadline.
   *
   * @returns {Promise<void>} Resolves once any active handler settles. The caller may impose a separate shutdown deadline.
   */
  public async close(): Promise<void> {
    this.closed = true;
    let item: RebuildItem | undefined;
    while ((item = this.pending.dequeue()) !== undefined) {
      this.reply(item.reply, 'handler-failed');
    }
    await this.active;
  }

  /**
   * Method overloaded
   *
   * @description
   * Rejects a dropped request, sampling overload logs without recording item data.
   *
   * @param {string} reply - Reply subject of the evicted or rejected request, or an empty string for a publication.
   */
  private overloaded(reply: string): void {
    this.reply(reply, 'overloaded');
    this.dropped += 1;
    if (this.dropped === 1 || this.dropped % 1000 === 0) {
      this.logger.error(
        {
          subject: this.subject,
          dropped: this.dropped,
          maxPending: this.maxPending,
          maxPendingBytes: MAX_REBUILD_PENDING_BYTES,
        },
        'rebuild items arrive faster than they are applied: dropped',
      );
    }
  }

  /**
   * Method run
   *
   * @description
   * Processes admitted items in FIFO order.
   *
   * @param {RebuildItem} first - First admitted item, already removed from the pending queue.
   * @returns {Promise<void>} Resolves once intake closes or the queue is drained.
   */
  private async run(first: RebuildItem): Promise<void> {
    try {
      for (
        let item: RebuildItem | undefined = first;
        item !== undefined;
        item = this.pending.dequeue()
      ) {
        if (this.closed) {
          this.reply(item.reply, 'handler-failed');
          return;
        }
        await this.deliver(item);
      }
    } finally {
      this.active = undefined;
    }
  }

  /**
   * Method deliver
   *
   * @description
   * Validates and applies one item, answering its requester when there is one.
   *
   * @param {RebuildItem} item - One queued item to validate and apply.
   * @returns {Promise<void>} Resolves when handling finishes and any reply has been attempted.
   */
  private async deliver(item: RebuildItem): Promise<void> {
    try {
      const parsed: z.ZodSafeParseResult<TItem> = this.registration.schema.safeParse(
        decodeItem(item),
      );
      if (!parsed.success) {
        this.reply(item.reply, 'invalid-item');
        this.logger.error(
          { subject: this.subject },
          'rebuild item does not match its schema: refused',
        );
        return;
      }
      await this.registration.handle(parsed.data);
      this.reply(item.reply, null);
    } catch (error) {
      this.reply(item.reply, 'handler-failed');
      this.logger.warn(
        { subject: this.subject, errorClass: errorCategoryOf(error) },
        'rebuild handler failed',
      );
    }
  }

  /**
   * Method reply
   *
   * @description
   * Answers requests on their reply subject. Plain publications have no reply.
   *
   * @param {string} reply - Reply subject, or an empty string when no response is expected.
   * @param {Exclude<RebuildRejection, 'unknown'> | null} rejection - Failure category or null for a successful application.
   */
  private reply(reply: string, rejection: Exclude<RebuildRejection, 'unknown'> | null): void {
    if (reply.length === 0) {
      return;
    }
    try {
      this.nats.publish(reply, encodeRebuildReply(rejection));
    } catch {
      this.logger.debug({ subject: this.subject }, 'rebuild reply could not be sent');
    }
  }
  // #endregion
}
