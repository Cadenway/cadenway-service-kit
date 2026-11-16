import { Buffer } from 'node:buffer';

/** Wire data retained for one rebuild item. */
export interface RebuildItem {
  // #region Properties
  /** Detached copy of the message payload. */
  readonly data: Uint8Array;

  /** Optional NATS reply subject, empty for a plain publication. */
  readonly reply: string;
  // #endregion
}

interface PendingItem {
  // #region Properties
  /** Item awaiting its handler. */
  readonly item: RebuildItem;

  /** Bytes counted against the queue limit. */
  readonly size: number;

  /** Next waiting item in delivery order. */
  next: PendingItem | undefined;
  // #endregion
}

/** Bounds waiting rebuild items at admission and evicts the oldest in constant time per item. */
export class RebuildQueue {
  // #region Properties
  /** Oldest waiting item. */
  private head: PendingItem | undefined;

  /** Newest waiting item. */
  private tail: PendingItem | undefined;

  /** Number of waiting items. */
  private count: number = 0;

  /** Total bytes of waiting payloads and reply subjects. */
  private bytes: number = 0;
  // #endregion

  // #region Constructor
  /** Sets the count and byte limits of this inbox. */
  public constructor(
    private readonly maxPending: number,
    private readonly maxBytes: number,
  ) {}
  // #endregion

  // #region Methods
  /** Enqueues an item, reporting the reply subjects of any items it had to discard. */
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

  /** Removes the oldest waiting item and releases its budget. */
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
