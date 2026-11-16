import type { ConfigShape } from '@cadenway/nest-common';
import { z } from 'zod';

/**
 * Interface MessagingConfig
 *
 * @description
 * Variables of an application that connects to NATS, as validated by `messagingConfigShape`.
 */
export interface MessagingConfig {
  // #region Properties
  /**
   * Property NATS_URL
   *
   * @description
   * NATS server URL, such as `nats://nats:4222`; several are separated by commas.
   *
   * @type {string}
   * @readonly
   */
  readonly NATS_URL: string;

  /**
   * Property NATS_USER
   *
   * @description
   * NATS user of the service, such as `task`. Optional: unset for an anonymous local connection.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly NATS_USER: string | undefined;

  /**
   * Property NATS_PASSWORD
   *
   * @description
   * Password of the NATS user. A secret. Optional.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly NATS_PASSWORD: string | undefined;
  // #endregion
}

/**
 * Constant NATS_URL_PATTERN
 *
 * @description
 * Shape of one NATS server URL: the `nats` or `tls` scheme, then a host and an optional port.
 *
 * @type {RegExp}
 */
const NATS_URL_PATTERN: RegExp = /^(?:nats|tls):\/\/[^\s/,]+$/u;

/**
 * Constant messagingConfigShape
 *
 * @description
 * Zod shape of `NATS_URL`, `NATS_USER` and `NATS_PASSWORD`. Spread it into the application
 * schema, then pass the values to `MessagingModule.forRootAsync`.
 *
 * @type {ConfigShape<MessagingConfig>}
 */
export const messagingConfigShape: ConfigShape<MessagingConfig> = {
  NATS_URL: z.string().refine(
    (value: string) => {
      const entries: string[] = value.split(',').map((entry: string) => entry.trim());
      return entries.every((entry: string) => NATS_URL_PATTERN.test(entry));
    },
    { error: 'Expected one or several comma-separated nats:// or tls:// URLs.' },
  ),
  NATS_USER: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u, { error: 'Expected a NATS user name.' })
    .optional(),
  NATS_PASSWORD: z.string().min(1).optional(),
};
