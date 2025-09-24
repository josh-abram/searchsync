/**
 * Integration error codes
 */
const ErrorCodes = {
  // Authentication and authorization
  AUTH_FAILED: 'auth_failed',
  INVALID_CREDENTIALS: 'invalid_credentials',
  INSUFFICIENT_PERMISSIONS: 'insufficient_permissions',

  // Rate limiting and quotas
  RATE_LIMIT: 'rate_limit',
  QUOTA_EXCEEDED: 'quota_exceeded',

  // Network and connectivity
  NETWORK_ERROR: 'network_error',
  TIMEOUT: 'timeout',
  CONNECTION_REFUSED: 'connection_refused',

  // Client errors
  INVALID_INPUT: 'invalid_input',
  MISSING_PARAMETER: 'missing_parameter',
  INVALID_FORMAT: 'invalid_format',

  // Resource errors
  NOT_FOUND: 'not_found',
  RESOURCE_DELETED: 'resource_deleted',

  // Server errors
  SERVER_ERROR: 'server_error',
  SERVICE_UNAVAILABLE: 'service_unavailable',

  // Configuration errors
  INVALID_CONFIG: 'invalid_config',
  MISSING_CONFIG: 'missing_config',

  // Other
  UNKNOWN_ERROR: 'unknown_error',
  PARSE_ERROR: 'parse_error'
};

/**
 * Standardized integration error class
 */
class IntegrationError extends Error {
  /**
   * Creates an IntegrationError instance
   * @param {Object} options - Error options
   * @param {string} options.code - Standardized error code
   * @param {string} options.provider - Integration name (jira, confluence, etc.)
   * @param {number} [options.status] - HTTP status code
   * @param {string} options.message - User-friendly message
   * @param {boolean} [options.isRetryable=false] - Can this error be retried?
   * @param {Error} [options.cause] - Original error
   * @param {Object} [options.context] - Additional context
   */
  constructor({
    code,
    provider,
    status,
    message,
    isRetryable = false,
    cause = null,
    context = {}
  }) {
    super(message);

    this.name = 'IntegrationError';
    this.code = code;
    this.provider = provider;
    this.status = status;
    this.isRetryable = isRetryable;
    this.cause = cause;
    this.context = context;
    this.timestamp = new Date().toISOString();

    // Capture stack trace, excluding this constructor
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, IntegrationError);
    }

    // Include cause in stack trace if available
    if (cause && cause.stack) {
      this.stack += `\nCaused by: ${cause.stack}`;
    }
  }

  /**
   * Converts error to a plain object for serialization
   * @returns {Object} - Plain object representation
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      provider: this.provider,
      status: this.status,
      message: this.message,
      isRetryable: this.isRetryable,
      timestamp: this.timestamp,
      context: this.context
      // Note: cause and stack are omitted for security
    };
  }

  /**
   * Creates a user-friendly display message
   * @returns {string} - User-friendly message
   */
  toDisplayMessage() {
    switch (this.code) {
      case ErrorCodes.AUTH_FAILED:
        return `Authentication failed for ${this.provider}. Please check your credentials.`;

      case ErrorCodes.RATE_LIMIT:
        return `Rate limit exceeded for ${this.provider}. Please try again later.`;

      case ErrorCodes.NETWORK_ERROR:
        return `Network error connecting to ${this.provider}. Please check your connection.`;

      case ErrorCodes.TIMEOUT:
        return `Request to ${this.provider} timed out. Please try again.`;

      case ErrorCodes.NOT_FOUND:
        return `Resource not found in ${this.provider}.`;

      case ErrorCodes.INVALID_INPUT:
        return `Invalid search query for ${this.provider}.`;

      case ErrorCodes.SERVER_ERROR:
        return `${this.provider} is experiencing issues. Please try again later.`;

      default:
        return `An error occurred with ${this.provider}. ${this.message}`;
    }
  }

  /**
   * Checks if this error matches a specific code
   * @param {string} code - Error code to check
   * @returns {boolean} - True if matches
   */
  isCode(code) {
    return this.code === code;
  }

  /**
   * Checks if this error is from a specific provider
   * @param {string} provider - Provider name to check
   * @returns {boolean} - True if matches
   */
  isProvider(provider) {
    return this.provider === provider;
  }

  /**
   * Creates a new error with additional context
   * @param {Object} additionalContext - Additional context to add
   * @returns {IntegrationError} - New error instance
   */
  withContext(additionalContext) {
    return new IntegrationError({
      code: this.code,
      provider: this.provider,
      status: this.status,
      message: this.message,
      isRetryable: this.isRetryable,
      cause: this.cause,
      context: { ...this.context, ...additionalContext }
    });
  }
}

/**
 * Creates an authentication error
 * @param {string} provider - Provider name
 * @param {string} [message] - Optional custom message
 * @param {Error} [cause] - Original error
 * @returns {IntegrationError} - Authentication error
 */
function createAuthError(provider, message, cause) {
  return new IntegrationError({
    code: ErrorCodes.AUTH_FAILED,
    provider,
    message: message || 'Authentication failed',
    cause
  });
}

/**
 * Creates a rate limit error
 * @param {string} provider - Provider name
 * @param {number} [retryAfter] - Seconds to wait before retrying
 * @param {Error} [cause] - Original error
 * @returns {IntegrationError} - Rate limit error
 */
function createRateLimitError(provider, retryAfter, cause) {
  const error = new IntegrationError({
    code: ErrorCodes.RATE_LIMIT,
    provider,
    message: retryAfter ?
      `Rate limit exceeded. Retry after ${retryAfter} seconds.` :
      'Rate limit exceeded. Please try again later.',
    status: 429,
    isRetryable: true,
    cause,
    context: { retryAfter }
  });

  return error;
}

/**
 * Creates a network error
 * @param {string} provider - Provider name
 * @param {string} message - Error message
 * @param {Error} [cause] - Original error
 * @returns {IntegrationError} - Network error
 */
function createNetworkError(provider, message, cause) {
  return new IntegrationError({
    code: ErrorCodes.NETWORK_ERROR,
    provider,
    message: message || 'Network error',
    isRetryable: true,
    cause
  });
}

/**
 * Creates a validation error
 * @param {string} provider - Provider name
 * @param {string} field - Field that failed validation
 * @param {string} message - Error message
 * @returns {IntegrationError} - Validation error
 */
function createValidationError(provider, field, message) {
  return new IntegrationError({
    code: ErrorCodes.INVALID_INPUT,
    provider,
    message: message || `Invalid ${field}`,
    context: { field }
  });
}

/**
 * Checks if an error is an IntegrationError
 * @param {*} error - Error to check
 * @returns {boolean} - True if IntegrationError
 */
function isIntegrationError(error) {
  return error instanceof IntegrationError;
}

/**
 * Wraps an unknown error in an IntegrationError
 * @param {string} provider - Provider name
 * @param {Error} error - Original error
 * @returns {IntegrationError} - Wrapped error
 */
function wrapUnknownError(provider, error) {
  if (isIntegrationError(error)) {
    return error;
  }

  return new IntegrationError({
    code: ErrorCodes.UNKNOWN_ERROR,
    provider,
    message: error.message || 'Unknown error occurred',
    cause: error
  });
}

module.exports = {
  IntegrationError,
  ErrorCodes,
  createAuthError,
  createRateLimitError,
  createNetworkError,
  createValidationError,
  isIntegrationError,
  wrapUnknownError
};