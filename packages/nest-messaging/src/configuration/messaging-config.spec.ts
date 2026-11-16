import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { messagingConfigShape, type MessagingConfig } from './messaging-config.js';

describe('messagingConfigShape', () => {
  /**
   * Constant schema
   *
   * @description
   * Application schema made of the messaging shape alone.
   *
   * @type {z.ZodType<MessagingConfig>}
   */
  const schema: z.ZodType<MessagingConfig> = z.object(messagingConfigShape);

  it('accepts a NATS URL alone: the user and the password are optional', () => {
    expect(schema.parse({ NATS_URL: 'nats://nats:4222' })).toEqual({
      NATS_URL: 'nats://nats:4222',
    });
  });

  it('accepts several servers and the credentials of the service', () => {
    expect(
      schema.parse({
        NATS_URL: 'nats://nats-1:4222,tls://nats-2:4222',
        NATS_USER: 'task-service',
        NATS_PASSWORD: 'fixture',
      }),
    ).toEqual({
      NATS_URL: 'nats://nats-1:4222,tls://nats-2:4222',
      NATS_USER: 'task-service',
      NATS_PASSWORD: 'fixture',
    });
  });

  it.each([undefined, '', 'nats:4222', 'http://nats:4222', 'nats://nats:4222,'])(
    'refuses the NATS URL %s',
    (url: string | undefined) => {
      expect(schema.safeParse({ NATS_URL: url }).success).toBe(false);
    },
  );

  it('refuses an empty user or password', () => {
    expect(schema.safeParse({ NATS_URL: 'nats://nats:4222', NATS_USER: '' }).success).toBe(false);
    expect(schema.safeParse({ NATS_URL: 'nats://nats:4222', NATS_PASSWORD: '' }).success).toBe(
      false,
    );
  });
});
