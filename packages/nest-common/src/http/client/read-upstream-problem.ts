/**
 * Constant MAX_PROBLEM_BYTES
 *
 * @description
 * Largest upstream error document accepted, measured before UTF-8 decoding.
 *
 * @type {number}
 */
const MAX_PROBLEM_BYTES: number = 65_536;

/**
 * Function readUpstreamProblem
 *
 * @description
 * Reads a bounded JSON error document and cancels a rejected or timed-out body.
 *
 * @param {Response} response - Upstream response whose body may be read or canceled.
 * @param {AbortSignal} signal - Signal that cancels reading the upstream response body.
 * @returns {Promise<Record<string, unknown>>} A bounded decoded document, or an empty record if it cannot be read.
 */
export async function readUpstreamProblem(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body === null) {
    return {};
  }

  try {
    if (signal.aborted || Number(response.headers.get('content-length')) > MAX_PROBLEM_BYTES) {
      void body.cancel().catch(() => undefined);
      return {};
    }

    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    const cancel: () => void = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const decoder: TextDecoder = new TextDecoder();
      let bytes: number = 0;
      let text: string = '';
      for (;;) {
        const { done, value }: ReadableStreamReadResult<Uint8Array> = await reader.read();
        signal.throwIfAborted();
        if (done) {
          const parsed: unknown = JSON.parse(text + decoder.decode());
          return typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {};
        }
        bytes += value.byteLength;
        if (bytes > MAX_PROBLEM_BYTES) {
          cancel();
          return {};
        }
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  } catch {
    return {};
  }
}
