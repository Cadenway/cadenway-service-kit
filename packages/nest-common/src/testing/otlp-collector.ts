import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Interface Collector
 *
 * @description
 * Local HTTP server standing in for an OTLP collector.
 */
export interface Collector {
  // #region Properties
  /**
   * Property url
   *
   * @description
   * Base URL to put in `OTEL_EXPORTER_OTLP_ENDPOINT`.
   *
   * @type {string}
   * @readonly
   */
  readonly url: string;

  /**
   * Property received
   *
   * @description
   * Bodies received so far, by request path.
   *
   * @type {Map<string, string[]>}
   * @readonly
   */
  readonly received: Map<string, string[]>;
  // #endregion

  // #region Methods
  /**
   * Method close
   *
   * @description
   * Stops the server.
   *
   * @returns {Promise<void>} Resolves once the server is closed.
   */
  close(): Promise<void>;
  // #endregion
}

/**
 * Function startCollector
 *
 * @description
 * Starts a local server that records every OTLP request and answers 200.
 *
 * @returns {Promise<Collector>} The running collector.
 */
export async function startCollector(): Promise<Collector> {
  const received: Map<string, string[]> = new Map<string, string[]>();
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path: string = request.url ?? '';
      received.set(path, [...(received.get(path) ?? []), Buffer.concat(chunks).toString('utf8')]);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port: number = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
