/**
 * Constant JSON_BODY_LIMIT_BYTES
 *
 * @description
 * Largest JSON request body accepted: 1 MB, the limit of the contract style.
 *
 * @type {number}
 */
export const JSON_BODY_LIMIT_BYTES: number = 1_048_576;

/**
 * Interface BodyParserHost
 *
 * @description
 * Part of the NestJS Express application used to register a body parser.
 */
export interface BodyParserHost {
  // #region Methods
  /**
   * Method useBodyParser
   *
   * @description
   * Registers a body parser of Express on the application.
   *
   * @param {'json'} type - Parser to register.
   * @param {{ limit: number }} options - Options of the parser.
   * @returns {unknown} Ignored.
   */
  useBodyParser(type: 'json', options: { limit: number }): unknown;
  // #endregion
}

/**
 * Function applyJsonBodyLimit
 *
 * @description
 * Registers the JSON body parser with the Cadenway size limit. Call it before the application
 * is initialized: NestJS then skips its own JSON parser, whose limit is lower. A larger body is
 * refused by the parser and answered 400 `request.body-too-large` by the problem filter.
 *
 * @param {BodyParserHost} app - NestJS application on the Express platform.
 * @param {number} limitBytes - Largest accepted body, in bytes; defaults to `JSON_BODY_LIMIT_BYTES`.
 * @returns {void}
 */
export function applyJsonBodyLimit(
  app: BodyParserHost,
  limitBytes: number = JSON_BODY_LIMIT_BYTES,
): void {
  app.useBodyParser('json', { limit: limitBytes });
}
