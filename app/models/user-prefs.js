import Ajv from 'ajv';
import { cloneDeep } from 'lodash';

import { addModel as commentModelMaker } from './comment';

const commentModel = commentModelMaker(null);

const schema = {
  '$schema': 'http://json-schema.org/schema#',

  type:       'object',
  properties: {
    hideCommentsOfTypes: {
      title:   `Do not show comments with these hideType's`,
      default: [],

      type:        'array',
      uniqueItems: true,
      items:       {
        type: 'integer',
        enum: [
          commentModel.DELETED,
          commentModel.HIDDEN_BANNED,
          commentModel.HIDDEN_ARCHIVED,
        ],
      },
    },
    sendNotificationsDigest: {
      title:   'Send notifications digest email for current user',
      default: true,
      type:    'boolean',
    },
    sendDailyBestOfDigest: {
      title:   'Send daily Best Of digest email for current user',
      default: false,
      type:    'boolean',
    },
  },
  additionalProperties: false,
};

const ajv = new Ajv({ allErrors: true, useDefaults: true });
const check = ajv.compile(schema);

/**
 * Validates and completes absent fields by default values.
 * Throws exception if validation failed (or returns default
 * value if 'safe' argument is true).
 *
 * @param {object}  data
 * @param {boolean} safe - return default value instead of exception throwing
 * @return {object}
 */
export function valiate(data = {}, safe = false) {
  data = cloneDeep(data);
  const valid = check(data);
  if (valid) {
    return data;
  }
  if (safe) {
    // Return all defaults
    return valiate();
  }
  throw new Error(ajv.errorsText(check.errors));
}
