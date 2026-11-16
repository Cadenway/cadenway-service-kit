import { Buffer } from 'node:buffer';

/**
 * Interface RebuildItem
 *
 * @description
 * Wire data retained for one rebuild item.
 */
export interface RebuildItem {
  // #region Properties
  /**
   * Property data
   *
   * @description
   * Detached copy of the message payload.
   *
   * @type {Uint8Array}
   * @readonly
   */
  readonly data: Uint8Array;

  /**
   * Property reply
   *
   * @description
   * Optional NATS reply subject, empty for a plain publication.
   *
   * @type {string}
   * @readonly
   */
  readonly reply: string;
  // #endregion
}

/**
 * Interface PendingItem
 *
 * @description
 * Links a rebuild item to its admission cost and the next item in arrival order.
 */
interface PendingItem {
  // #region Properties
  /**
   * Property item
   *
   * @description
   * Item awaiting its handler.
   *
   * @type {RebuildItem}
   * @readonly
   */
  readonly item: RebuildItem;

  /**
   * Property size
   *
   * @description
   * Bytes counted against the queue limit.
   *
   * @type {number}
   * @readonly
   */
  readonly size: number;

  /**
   * Property next
   *
   * @description
   * Next waiting item in delivery order.
   *
   * @type {PendingItem | undefined}
   */
  next: PendingItem | undefined;
  // #endregion
}

/**
 * Class RebuildQueue
 *
 * @description
 * Bounds waiting rebuild items at admission and evicts the oldest in constant time per item.
 */
export class RebuildQueue {
  // #region Properties
  /**
   * Property head
   *
   * @description
   * Oldest waiting item.
   *
   * @type {PendingItem | undefined}
   */
  private head: PendingItem | undefined;

  /**
   * Property tail
   *
   * @description
   * Newest waiting item.
   *
   * @type {PendingItem | undefined}
   */
  private tail: PendingItem | undefined;

  /**
   * Property count
   *
   * @description
   * Number of waiting items.
   *
   * @type {number}
   */
  private count: number = 0;

  /**
   * Property bytes
   *
   * @description
   * Total bytes of waiting payloads and reply subjects.
   *
   * @type {number}
   */
  private bytes: number = 0;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Sets the count and byte limits of this inbox.
   *
   * @param {number} maxPending - Maximum number of items allowed to wait.
   * @param {number} maxBytes - Maximum combined size of waiting data and reply subjects, in bytes.
   * @constructor
   */
  public constructor(
    private readonly maxPending: number,
    private readonly maxBytes: number,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method enqueue
   *
   * @description
   * Enqueues an item, reporting the reply subjects of any items it had to discard.
   *
   * @param {Uint8Array} data - Payload whose retained copy counts against the byte budget.
   * @param {string} reply - Optional reply subject, included in the byte budget.
   * @param {(reply: string) => void} discard - Receives the reply subject of every item refused or evicted.
   */
  public enqueue(data: Uint8Array, reply: string, discard: (reply: string) => void): void {
    const size: number = data.byteLength + Buffer.byteLength(reply);
    if (size > this.maxBytes) {
      discard(reply);
      return;
    }
    while (
      this.head !== undefined &&
      (this.count >= this.maxPending || this.bytes + size > this.maxBytes)
    ) {
      const evicted: string = this.head.item.reply;
      this.dequeue();
      discard(evicted);
    }

    // NATS may return a view into a larger receive buffer. Retain only the bytes we counted.
    const pending: PendingItem = {
      item: { data: new Uint8Array(data), reply },
      size,
      next: undefined,
    };
    if (this.tail === undefined) {
      this.head = pending;
    } else {
      this.tail.next = pending;
    }
    this.tail = pending;
    this.count += 1;
    this.bytes += size;
  }

  /**
   * Method dequeue
   *
   * @description
   * Removes the oldest waiting item and releases its budget.
   *
   * @returns {RebuildItem | undefined} Oldest waiting item, or undefined when the queue is empty.
   */
  public dequeue(): RebuildItem | undefined {
    const first: PendingItem | undefined = this.head;
    if (first === undefined) {
      return undefined;
    }
    this.head = first.next;
    if (this.head === undefined) {
      this.tail = undefined;
    }
    this.count -= 1;
    this.bytes -= first.size;
    return first.item;
  }
  // #endregion
}
