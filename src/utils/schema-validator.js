const Logger = require('./logger');
const { validateRequiredFields } = require('../integrations/utils');

// Create logger instance for schema validation
const logger = new Logger({
  component: 'SchemaValidator'
});

/**
 * Schema validation types
 */
const Types = {
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
  EMAIL: 'email',
  URL: 'url',
  ENUM: 'enum',
  ANY: 'any'
};

/**
 * Validation error class
 */
class ValidationError extends Error {
  constructor(message, field, value) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.value = value;
  }
}

/**
 * Schema field definition
 * @typedef {Object} SchemaField
 * @property {string} type - Field type
 * @property {boolean} [required=false] - Whether field is required
 * @property {*} [default] - Default value
 * @property {Array<*>} [enum] - Allowed values for enum type
 * @property {Function} [validator] - Custom validator function
 * @property {string} [message] - Custom error message
 * @property {number} [min] - Minimum value/length
 * @property {number} [max] - Maximum value/length
 * @property {RegExp} [pattern] - Regular expression pattern
 */

/**
 * Validates a value against a schema field definition
 * @param {*} value - Value to validate
 * @param {string} field - Field name
 * @param {SchemaField} schema - Schema field definition
 * @returns {Object} - { valid: boolean, value: *, errors: Array<string> }
 */
function validateField(value, field, schema) {
  const errors = [];
  let result = value;

  // Handle undefined/null values
  if (value === undefined || value === null) {
    if (schema.required && schema.default === undefined) {
      errors.push(schema.message || `${field} is required`);
    }
    return {
      valid: errors.length === 0,
      value: schema.default !== undefined ? schema.default : value,
      errors
    };
  }

  // Type validation
  const typeValidation = validateType(value, field, schema);
  if (!typeValidation.valid) {
    errors.push(typeValidation.error);
    return { valid: false, value, errors };
  }

  // Convert value to correct type if needed
  result = typeValidation.value;

  // Custom validator
  if (schema.validator && typeof schema.validator === 'function') {
    try {
      const customResult = schema.validator(result);
      if (customResult === false) {
        errors.push(schema.message || `${field} failed custom validation`);
      } else if (typeof customResult === 'string') {
        errors.push(customResult);
      } else if (customResult && typeof customResult === 'object') {
        result = customResult.value !== undefined ? customResult.value : result;
        if (customResult.error) {
          errors.push(customResult.error);
        }
      }
    } catch (error) {
      errors.push(`${field} validation error: ${error.message}`);
    }
  }

  // Min/Max validation
  if (schema.min !== undefined) {
    const minValidation = validateMin(result, field, schema);
    if (!minValidation.valid) {
      errors.push(minValidation.error);
    }
  }

  if (schema.max !== undefined) {
    const maxValidation = validateMax(result, field, schema);
    if (!maxValidation.valid) {
      errors.push(maxValidation.error);
    }
  }

  // Pattern validation
  if (schema.pattern) {
    const patternValidation = validatePattern(result, field, schema);
    if (!patternValidation.valid) {
      errors.push(patternValidation.error);
    }
  }

  return {
    valid: errors.length === 0,
    value: result,
    errors
  };
}

/**
 * Validates value type
 * @param {*} value - Value to validate
 * @param {string} field - Field name
 * @param {SchemaField} schema - Schema field definition
 * @returns {Object} - { valid: boolean, value: *, error?: string }
 */
function validateType(value, field, schema) {
  const { type } = schema;
  let result = value;

  // Handle string conversion
  if (type === Types.STRING && typeof value !== 'string') {
    result = String(value);
  }

  // Handle number conversion
  if (type === Types.NUMBER && typeof value !== 'number') {
    const num = Number(value);
    if (isNaN(num)) {
      return {
        valid: false,
        value,
        error: schema.message || `${field} must be a number`
      };
    }
    result = num;
  }

  // Handle boolean conversion
  if (type === Types.BOOLEAN && typeof value !== 'boolean') {
    if (typeof value === 'string') {
      result = value.toLowerCase() === 'true' || value === '1';
    } else if (typeof value === 'number') {
      result = value === 1;
    } else {
      result = Boolean(value);
    }
  }

  // Type checks
  switch (type) {
    case Types.STRING:
      if (typeof result !== 'string') {
        return {
          valid: false,
          value,
          error: schema.message || `${field} must be a string`
        };
      }
      break;

    case Types.NUMBER:
      if (typeof result !== 'number' || isNaN(result)) {
        return {
          valid: false,
          value,
          error: schema.message || `${field} must be a number`
        };
      }
      break;

    case Types.BOOLEAN:
      if (typeof result !== 'boolean') {
        return {
          valid: false,
          value,
          error: schema.message || `${field} must be a boolean`
        };
      }
      break;

    case Types.ARRAY:
      if (!Array.isArray(result)) {
        return {
          valid: false,
          value,
          error: schema.message || `${field} must be an array`
        };
      }
      break;

    case Types.OBJECT:
      if (typeof result !== 'object' || Array.isArray(result) || result === null) {
        return {
          valid: false,
          value,
          error: schema.message || `${field} must be an object`
        };
      }
      break;

    case Types.EMAIL:
      if (typeof result !== 'string' || !isValidEmail(result)) {
        return {
          valid: false,
          value,
          error: schema.message || `${field} must be a valid email address`
        };
      }
      break;

    case Types.URL:
      if (typeof result !== 'string' || !isValidUrl(result)) {
        return {
          valid: false,
          value,
          error: schema.message || `${field} must be a valid URL`
        };
      }
      break;

    case Types.ENUM:
      if (!schema.enum || !Array.isArray(schema.enum)) {
        return {
          valid: false,
          value,
          error: `${field} enum schema is invalid`
        };
      }
      if (!schema.enum.includes(result)) {
        return {
          valid: false,
          value,
          error: schema.message || `${field} must be one of: ${schema.enum.join(', ')}`
        };
      }
      break;
  }

  return { valid: true, value: result };
}

/**
 * Validates minimum value/length
 * @param {*} value - Value to validate
 * @param {string} field - Field name
 * @param {SchemaField} schema - Schema field definition
 * @returns {Object} - { valid: boolean, error?: string }
 */
function validateMin(value, field, schema) {
  const { min } = schema;

  if (typeof value === 'string' || Array.isArray(value)) {
    if (value.length < min) {
      return {
        valid: false,
        error: schema.message || `${field} must be at least ${min} character${min !== 1 ? 's' : ''} long`
      };
    }
  } else if (typeof value === 'number') {
    if (value < min) {
      return {
        valid: false,
        error: schema.message || `${field} must be at least ${min}`
      };
    }
  }

  return { valid: true };
}

/**
 * Validates maximum value/length
 * @param {*} value - Value to validate
 * @param {string} field - Field name
 * @param {SchemaField} schema - Schema field definition
 * @returns {Object} - { valid: boolean, error?: string }
 */
function validateMax(value, field, schema) {
  const { max } = schema;

  if (typeof value === 'string' || Array.isArray(value)) {
    if (value.length > max) {
      return {
        valid: false,
        error: schema.message || `${field} must be at most ${max} character${max !== 1 ? 's' : ''} long`
      };
    }
  } else if (typeof value === 'number') {
    if (value > max) {
      return {
        valid: false,
        error: schema.message || `${field} must be at most ${max}`
      };
    }
  }

  return { valid: true };
}

/**
 * Validates pattern
 * @param {*} value - Value to validate
 * @param {string} field - Field name
 * @param {SchemaField} schema - Schema field definition
 * @returns {Object} - { valid: boolean, error?: string }
 */
function validatePattern(value, field, schema) {
  const { pattern } = schema;

  if (typeof value !== 'string') {
    return {
      valid: false,
      error: `${field} must be a string to validate pattern`
    };
  }

  if (!pattern.test(value)) {
    return {
      valid: false,
      error: schema.message || `${field} format is invalid`
    };
  }

  return { valid: true };
}

/**
 * Checks if email is valid
 * @param {string} email - Email to validate
 * @returns {boolean} - True if valid
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Checks if URL is valid
 * @param {string} url - URL to validate
 * @returns {boolean} - True if valid
 */
function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Schema validator class
 */
class SchemaValidator {
  constructor(schema) {
    this.schema = schema;
  }

  /**
   * Validates data against schema
   @param {Object} data - Data to validate
   * @returns {Object} - { valid: boolean, data: Object, errors: Object }
   */
  validate(data) {
    const result = { ...data };
    const errors = {};

    for (const [field, schema] of Object.entries(this.schema)) {
      const fieldResult = validateField(data[field], field, schema);

      if (!fieldResult.valid) {
        errors[field] = fieldResult.errors;
      } else {
        result[field] = fieldResult.value;
      }
    }

    return {
      valid: Object.keys(errors).length === 0,
      data: result,
      errors
    };
  }

  /**
   * Validates data and throws on error
   * @param {Object} data - Data to validate
   * @returns {Object} - Validated data
   * @throws {ValidationError} - If validation fails
   */
  validateOrThrow(data) {
    const result = this.validate(data);

    if (!result.valid) {
      const errorMessages = Object.entries(result.errors)
        .map(([field, fieldErrors]) => `${field}: ${fieldErrors.join(', ')}`)
        .join('; ');

      throw new ValidationError(
        `Validation failed: ${errorMessages}`,
        Object.keys(result.errors),
        data
      );
    }

    return result.data;
  }
}

/**
 * Creates a schema validator
 * @param {Object} schema - Schema definition
 * @returns {SchemaValidator} - Validator instance
 */
function createValidator(schema) {
  return new SchemaValidator(schema);
}

/**
 * Configuration schemas for SearchSync
 */
const Schemas = {
  // Integration configuration schema
  integration: {
    enabled: {
      type: Types.BOOLEAN,
      default: false
    },
    baseUrl: {
      type: Types.URL,
      required: true,
      message: 'Base URL is required and must be a valid URL'
    },
    email: {
      type: Types.EMAIL,
      required: true,
      message: 'Email is required for authentication'
    },
    apiToken: {
      type: Types.STRING,
      required: true,
      min: 10,
      message: 'API token is required (minimum 10 characters)'
    },
    projectKeys: {
      type: Types.ARRAY,
      default: [],
      validator: (value) => {
        if (!Array.isArray(value)) return false;
        return value.every(key => typeof key === 'string' && key.length > 0);
      },
      message: 'Project keys must be an array of non-empty strings'
    },
    filters: {
      type: Types.OBJECT,
      default: {}
    },
    searchFields: {
      type: Types.ARRAY,
      default: ['summary', 'description', 'comments']
    }
  },

  // Azure DevOps specific schema
  azureDevOps: {
    organization: {
      type: Types.STRING,
      required: true,
      min: 2,
      message: 'Organization name is required'
    },
    project: {
      type: Types.STRING,
      required: true,
      message: 'Project name is required'
    },
    personalAccessToken: {
      type: Types.STRING,
      required: true,
      min: 10,
      message: 'Personal Access Token is required (minimum 10 characters)'
    }
  },

  // Global app settings schema
  appSettings: {
    searchDelay: {
      type: Types.NUMBER,
      default: 300,
      min: 100,
      max: 2000,
      message: 'Search delay must be between 100 and 2000ms'
    },
    maxResults: {
      type: Types.NUMBER,
      default: 50,
      min: 10,
      max: 200,
      message: 'Maximum results must be between 10 and 200'
    },
    enableSearchHistory: {
      type: Types.BOOLEAN,
      default: true
    },
    enableAnalytics: {
      type: Types.BOOLEAN,
      default: false
    },
    logLevel: {
      type: Types.ENUM,
      enum: ['error', 'warn', 'info', 'debug'],
      default: 'info'
    },
    theme: {
      type: Types.ENUM,
      enum: ['light', 'dark', 'system'],
      default: 'system'
    },
    // User context for search personalization
    userContext: {
      type: Types.OBJECT,
      default: {
        searchPreferences: {
          preferredIntegrations: [],
          resultTypes: {}
        }
      }
    }
  },

  // UI settings schema
  uiSettings: {
    windowWidth: {
      type: Types.NUMBER,
      default: 800,
      min: 400,
      max: 1200
    },
    windowHeight: {
      type: Types.NUMBER,
      default: 600,
      min: 300,
      max: 900
    },
    alwaysOnTop: {
      type: Types.BOOLEAN,
      default: false
    },
    showInTray: {
      type: Types.BOOLEAN,
      default: true
    },
    hotkey: {
      type: Types.STRING,
      default: 'CmdOrCtrl+Shift+S',
      validator: (value) => {
        // Basic validation - ensure it contains at least one modifier and key
        const modifiers = ['CmdOrCtrl', 'CommandOrControl', 'Alt', 'Shift', 'Cmd', 'Ctrl', 'Meta', 'Super'];
        const hasModifier = modifiers.some(mod => value.includes(mod));
        const hasKey = value.split('+').length > 1;
        return hasModifier && hasKey && value.length > 3;
      },
      message: 'Hotkey must include at least one modifier (e.g., CmdOrCtrl, Alt, Shift)'
    }
  }
};

module.exports = {
  Types,
  ValidationError,
  SchemaValidator,
  createValidator,
  Schemas,
  validateField,
  validateType,
  validateMin,
  validateMax,
  validatePattern,
  isValidEmail,
  isValidUrl
};