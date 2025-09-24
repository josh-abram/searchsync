const axios = require('axios');
const http = require('http');
const https = require('https');
const Logger = require('./logger');
const { IntegrationError } = require('./integration-errors');
const { generateCorrelationId } = require('../integrations/utils');

// Create logger instance for HTTP client
const logger = new Logger({
  component: 'HttpClient'
});

/**
 * Default configuration for HTTP client
 */
const defaultConfig = {
  timeout: 10000,
  maxRetries: 3,
  retryDelay: 1000,
  retryBackoffFactor: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  retryableMethods: ['GET', 'HEAD', 'OPTIONS'],
  userAgent: 'SearchSync/0.0.8',
  logLevel: process.env.NODE_ENV === 'development' ? 'debug' : 'warn'
};

/**
 * Creates HTTP agents for connection pooling
 */
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10
});

/**
 * Calculates delay with exponential backoff and jitter
 * @param {number} retryCount - Current retry attempt
 * @param {number} baseDelay - Base delay in milliseconds
 * @param {number} backoffFactor - Exponential backoff factor
 * @param {number} maxDelay - Maximum delay in milliseconds
 * @returns {number} - Delay in milliseconds
 */
function calculateBackoff(retryCount, baseDelay, backoffFactor, maxDelay) {
  const delay = Math.min(
    baseDelay * Math.pow(backoffFactor, retryCount - 1),
    maxDelay
  );

  // Add jitter to prevent thundering herd
  return Math.floor(delay * (0.5 + Math.random() * 0.5));
}

/**
 * Determines if a request should be retried
 * @param {Error} error - The error that occurred
 * @param {Object} response - The HTTP response (if any)
 * @param {Object} config - Request configuration
 * @returns {boolean} - True if should retry
 */
function shouldRetry(error, response, config) {
  // Check if we've exhausted retries
  if (config.retryCount >= config.maxRetries) {
    return false;
  }

  // Check if method is retryable
  if (!config.retryableMethods.includes(config.method?.toUpperCase())) {
    return false;
  }

  // Network errors or timeouts
  if (error) {
    // Don't retry for explicit cancellations
    if (axios.isCancel(error)) {
      return false;
    }

    // Retry for network errors
    return true;
  }

  // Check status code
  if (response && config.retryableStatusCodes.includes(response.status)) {
    // Check for Retry-After header
    const retryAfter = response.headers['retry-after'];
    if (retryAfter) {
      // Parse Retry-After (can be seconds or HTTP date)
      const delay = /^\d+$/.test(retryAfter) ?
        parseInt(retryAfter) * 1000 :
        new Date(retryAfter) - Date.now();

      if (delay > 0 && delay < 60000) { // Cap at 60 seconds
        config.retryAfterDelay = delay;
        return true;
      }
    }

    return true;
  }

  return false;
}

/**
 * Creates and configures the HTTP client
 * @param {Object} options - Client configuration options
 * @returns {Object} - Configured axios instance
 */
function createHttpClient(options = {}) {
  const config = { ...defaultConfig, ...options };

  // Create axios instance
  const client = axios.create({
    timeout: config.timeout,
    httpAgent,
    httpsAgent,
    headers: {
      'User-Agent': config.userAgent
    }
  });

  // Request interceptor for correlation IDs and logging
  client.interceptors.request.use(
    (requestConfig) => {
      // Add correlation ID
      const correlationId = generateCorrelationId();
      requestConfig.headers = requestConfig.headers || {};
      requestConfig.headers['X-Request-ID'] = correlationId;
      requestConfig.metadata = { correlationId, startTime: Date.now() };

      // Log request
      logger[config.logLevel]('HTTP Request', {
        method: requestConfig.method?.toUpperCase(),
        url: requestConfig.url,
        correlationId
      });

      return requestConfig;
    },
    (error) => {
      logger.error('HTTP Request Error', {
        error: error.message,
        correlationId: error.config?.metadata?.correlationId
      });
      return Promise.reject(error);
    }
  );

  // Response interceptor for retry logic and error normalization
  client.interceptors.response.use(
    (response) => {
      const { correlationId, startTime } = response.config.metadata || {};
      const duration = startTime ? Date.now() - startTime : 0;

      // Log successful response
      logger[config.logLevel]('HTTP Response', {
        method: response.config.method?.toUpperCase(),
        url: response.config.url,
        status: response.status,
        duration,
        correlationId
      });

      return response;
    },
    async (error) => {
      const { config, response, request } = error;

      // Initialize retry count
      config.retryCount = config.retryCount || 0;

      // Check if we should retry
      if (shouldRetry(error, response, config)) {
        config.retryCount++;

        // Calculate delay
        let delay = calculateBackoff(
          config.retryCount,
          config.retryDelay,
          config.retryBackoffFactor,
          60000 // Max 60 seconds
        );

        // Use Retry-After delay if available
        if (config.retryAfterDelay) {
          delay = config.retryAfterDelay;
        }

        const { correlationId } = config.metadata || {};

        logger.warn('Retrying HTTP request', {
          method: config.method?.toUpperCase(),
          url: config.url,
          attempt: config.retryCount,
          maxRetries: config.maxRetries,
          delay,
          status: response?.status,
          correlationId
        });

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));

        // Retry the request
        return client(config);
      }

      // Normalize error
      const normalizedError = normalizeError(error);

      // Log final error
      logger.error('HTTP Request Failed', {
        method: config?.method?.toUpperCase(),
        url: config?.url,
        status: response?.status,
        error: normalizedError.message,
        correlationId: config?.metadata?.correlationId,
        retries: config?.retryCount || 0
      });

      return Promise.reject(normalizedError);
    }
  );

  return client;
}

/**
 * Normalizes HTTP errors to IntegrationError
 * @param {Error} error - The original error
 * @returns {IntegrationError} - Normalized error
 */
function normalizeError(error) {
  if (error instanceof IntegrationError) {
    return error;
  }

  let code, message, isRetryable = false;
  const status = error.response?.status;

  switch (status) {
    case 400:
      code = 'invalid_input';
      message = 'Invalid request parameters';
      break;

    case 401:
      code = 'auth_failed';
      message = 'Authentication failed';
      break;

    case 403:
      code = 'auth_failed';
      message = 'Insufficient permissions';
      break;

    case 404:
      code = 'not_found';
      message = 'Resource not found';
      break;

    case 429:
      code = 'rate_limit';
      message = 'Too many requests';
      isRetryable = true;
      break;

    case 408:
    case 504:
      code = 'timeout';
      message = 'Request timeout';
      isRetryable = true;
      break;

    case 500:
    case 502:
    case 503:
      code = 'server_error';
      message = 'Server error';
      isRetryable = true;
      break;

    default:
      if (error.code === 'ECONNABORTED') {
        code = 'timeout';
        message = 'Request timeout';
        isRetryable = true;
      } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        code = 'network_error';
        message = 'Network error';
        isRetryable = true;
      } else {
        code = 'unknown_error';
        message = error.message || 'Unknown error';
      }
  }

  return new IntegrationError({
    code,
    provider: error.config?.provider || 'unknown',
    status,
    message,
    isRetryable,
    cause: error
  });
}

// Create default client instance
const defaultClient = createHttpClient();

module.exports = {
  createHttpClient,
  defaultClient,
  defaultConfig,
  normalizeError
};