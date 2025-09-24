/**
 * Error message sanitizer utility
 * Prevents information disclosure through error messages
 */

const Logger = require('./logger');

const logger = new Logger({
  component: 'ErrorSanitizer'
});

// Patterns that might expose sensitive information
const SENSITIVE_PATTERNS = [
  /token[s]?[=:]\s*[^\s]+/gi,
  /password[s]?[=:]\s*[^\s]+/gi,
  /secret[s]?[=:]\s*[^\s]+/gi,
  /key[s]?[=:]\s*[^\s]+/gi,
  /auth[=:\s]+[^\s]+/gi,
  /bearer\s+[^\s]+/gi,
  /basic\s+[^\s]+/gi,
  /api[_-]?key[=:]\s*[^\s]+/gi,
  /personal[_-]?access[_-]?token[=:]\s*[^\s]+/gi,
  /pat[=:]\s*[^\s]+/gi,
  /credential[s]?[=:]\s*[^\s]+/gi,
  /private[_-]?key[=:]\s*[^\s]+/gi,
  /certificate[=:]\s*[^\s]+/gi
];

// Patterns that expose internal structure
const INTERNAL_PATTERNS = [
  /stack\s*trace/i,
  /at\s+[\w$]+\s+\([^)]*\)/i,
  /\/[\w\-\/]+\.js:\d+:\d+/i,
  /internal\/[^)]+/i,
  /node_modules\/[^)]+/i
];

/**
 * Sanitizes an error message for user display
 * @param {string|Error} error - The error to sanitize
 * @param {Object} options - Sanitization options
 * @returns {string} - Sanitized error message
 */
function sanitizeErrorMessage(error, options = {}) {
  const {
    hideInternal = true,
    hideSensitive = true,
    maxLength = 200,
    provider = 'unknown'
  } = options;

  let message = '';

  // Extract message from error object
  if (error instanceof Error) {
    message = error.message || 'An unknown error occurred';
  } else if (typeof error === 'string') {
    message = error;
  } else if (error && typeof error === 'object') {
    // Handle API response objects
    if (error.response?.data) {
      message = extractSafeMessage(error.response.data);
    } else {
      message = JSON.stringify(error);
    }
  } else {
    message = 'An unknown error occurred';
  }

  // Remove sensitive information
  if (hideSensitive) {
    SENSITIVE_PATTERNS.forEach(pattern => {
      message = message.replace(pattern, '[REDACTED]');
    });
  }

  // Remove internal implementation details
  if (hideInternal) {
    INTERNAL_PATTERNS.forEach(pattern => {
      message = message.replace(pattern, '');
    });
  }

  // Clean up multiple spaces and trim
  message = message.replace(/\s+/g, ' ').trim();

  // Truncate if too long
  if (message.length > maxLength) {
    message = message.substring(0, maxLength) + '...';
  }

  // Ensure we have a meaningful message
  if (!message || message.trim() === '') {
    message = `An error occurred while processing your request with ${provider}`;
  }

  return message;
}

/**
 * Extracts a safe message from API response data
 * @param {Object} data - API response data
 * @returns {string} - Safe error message
 */
function extractSafeMessage(data) {
  if (!data) return 'An unknown error occurred';

  // Handle different error response formats
  if (Array.isArray(data.errors)) {
    return data.errors[0]?.message || data.errors[0]?.title || 'Multiple errors occurred';
  }

  if (data.error) {
    return typeof data.error === 'string' ? data.error : data.error.message || 'An error occurred';
  }

  if (data.message) {
    return data.message;
  }

  if (data.errorMessages && Array.isArray(data.errorMessages)) {
    return data.errorMessages[0] || 'An error occurred';
  }

  return JSON.stringify(data);
}

/**
 * Creates a sanitized error object for logging
 * @param {Error} error - The original error
 * @param {Object} context - Additional context
 * @returns {Object} - Sanitized error object
 */
function createSanitizedError(error, context = {}) {
  const sanitized = {
    message: sanitizeErrorMessage(error, { hideInternal: false, hideSensitive: false }),
    name: error.name || 'Error',
    code: error.code,
    status: error.status,
    provider: context.provider || 'unknown',
    timestamp: new Date().toISOString()
  };

  // Include safe context
  if (context.correlationId) {
    sanitized.correlationId = context.correlationId;
  }

  if (context.endpoint) {
    sanitized.endpoint = context.endpoint;
  }

  return sanitized;
}

/**
 * Sanitizes an object for logging, removing sensitive fields
 * @param {Object} obj - Object to sanitize
 * @param {Array<string>} sensitiveFields - Fields to remove
 * @returns {Object} - Sanitized object
 */
function sanitizeObject(obj, sensitiveFields = []) {
  const sensitive = new Set([
    'password', 'token', 'secret', 'key', 'auth', 'credential',
    'personalAccessToken', 'apiToken', 'accessToken', 'refreshToken',
    ...sensitiveFields
  ]);

  const sanitized = {};

  for (const [key, value] of Object.entries(obj)) {
    if (sensitive.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeObject(value, sensitiveFields);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

module.exports = {
  sanitizeErrorMessage,
  createSanitizedError,
  sanitizeObject
};