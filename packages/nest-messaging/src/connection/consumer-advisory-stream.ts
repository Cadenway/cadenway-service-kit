import { DiscardPolicy, RetentionPolicy, StorageType, type StreamInfo } from '@nats-io/jetstream';

/**
 * Constant TOKEN
 *
 * @description
 * Limits management subjects and native advisory components to one bounded NATS token each.
 *
 * @type {RegExp}
 */
const TOKEN: RegExp = /^[A-Za-z0-9_-]{1,128}$/u;

/**
 * Constant MAX_DURABLES
 *
 * @description
 * Bounds the exact advisory subject set for a single guard.
 *
 * @type {number}
 */
const MAX_DURABLES: number = 32;

/**
 * Function consumerAdvisorySubjects
 *
 * @description
 * Derives the only admissible subjects from a trusted stream and its configured durables.
 *
 * @param {string} advisoryStream - The operator-provisioned stream to read.
 * @param {string} eventStream - The stream of the monitored consumers.
 * @param {readonly string[]} durables - Exact JetStream durable names, including the service prefix.
 * @returns {ReadonlySet<string> | undefined} The exact terminal advisories, or undefined for invalid input.
 */
export function consumerAdvisorySubjects(
  advisoryStream: string,
  eventStream: string,
  durables: readonly string[],
): ReadonlySet<string> | undefined {
  if (
    !TOKEN.test(advisoryStream) ||
    !TOKEN.test(eventStream) ||
    advisoryStream === eventStream ||
    durables.length === 0 ||
    durables.length > MAX_DURABLES ||
    !durables.every((durable: string): boolean => TOKEN.test(durable)) ||
    new Set(durables).size !== durables.length
  ) {
    return undefined;
  }

  return new Set(
    durables.flatMap((durable: string): string[] => [
      `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${eventStream}.${durable}`,
      `$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.${eventStream}.${durable}`,
    ]),
  );
}

/**
 * Function isEmptyConsumerAdvisoryStream
 *
 * @description
 * Requires the exact persistent latch configuration. A retained advisory can be replaced by
 * another advisory or cleared by an operator. Normal retention cannot clear the latch.
 *
 * @param {StreamInfo} info - Current stream metadata from JetStream.
 * @param {string} name - Configured stream name.
 * @param {ReadonlySet<string>} subjects - Exact expected native advisory subjects.
 * @returns {boolean} Whether the configured stream currently has no message.
 */
export function isEmptyConsumerAdvisoryStream(
  { config, state }: StreamInfo,
  name: string,
  subjects: ReadonlySet<string>,
): boolean {
  return (
    config.name === name &&
    config.storage === StorageType.File &&
    config.retention === RetentionPolicy.Limits &&
    config.discard === DiscardPolicy.Old &&
    config.max_msgs === 1 &&
    config.max_age === 0 &&
    config.max_bytes === -1 &&
    config.max_msg_size === -1 &&
    config.max_msgs_per_subject === -1 &&
    !config.sealed &&
    !config.deny_delete &&
    !config.discard_new_per_subject &&
    config.allow_msg_ttl !== true &&
    config.allow_msg_schedules !== true &&
    !config.allow_rollup_hdrs &&
    config.mirror === undefined &&
    (config.sources?.length ?? 0) === 0 &&
    config.subject_transform === undefined &&
    config.republish === undefined &&
    config.subjects.length === subjects.size &&
    new Set(config.subjects).size === subjects.size &&
    config.subjects.every((subject: string): boolean => subjects.has(subject)) &&
    state.messages === 0
  );
}
