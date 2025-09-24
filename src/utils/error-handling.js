const Logger = require('./logger');
const { generateCorrelationId, isTransientError } = require('../integrations/utils');

// Create logger instance for error handling
const logger = new Logger({
  component: 'ErrorHandler'
});

/**
 * Circuit Breaker pattern for preventing cascading failures
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.threshold = options.threshold || 5;
    this.timeout = options.timeout || 60000; // 1 minute
    this.resetTimeout = options.resetTimeout || 30000; // 30 seconds
    this.failureCount = 0;
    this.lastFailure = null;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextAttempt = null;
  }

  /**
   * Executes a function with circuit breaker protection
   * @param {Function} fn - Function to execute
   * @param {Object} context - Context for the function
   * @returns {Promise} - Result of the function
   */
  async execute(fn, context = {}) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN - service unavailable');
      } else {
        this.setState('HALF_OPEN');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Handles successful execution
   */
  onSuccess() {
    this.failureCount = 0;
    this.setState('CLOSED');
  }

  /**
   * Handles failed execution
   */
  onFailure() {
    this.failureCount++;
    this.lastFailure = Date.now();

    if (this.failureCount >= this.threshold) {
      this.setState('OPEN');
      this.nextAttempt = Date.now() + this.resetTimeout;
      logger.warn('Circuit breaker opened', {
        failureCount: this.failureCount,
        threshold: this.threshold,
        nextAttempt: new Date(this.nextAttempt).toISOString()
      });
    }
  }

  /**
   * Sets the circuit breaker state
   * @param {string} state - New state
   */
  setState(state) {
    if (this.state !== state) {
      logger.info(`Circuit breaker state changed: ${this.state} -> ${state}`);
      this.state = state;
    }
  }

  /**
   * Gets the current state
   * @returns {Object} - Current state information
   */
  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailure: this.lastFailure ? new Date(this.lastFailure).toISOString() : null,
      nextAttempt: this.nextAttempt ? new Date(this.nextAttempt).toISOString() : null
    };
  }
}

/**
 * Retry mechanism with exponential backoff
 */
class RetryMechanism {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.baseDelay = options.baseDelay || 1000;
    this.maxDelay = options.maxDelay || 30000;
    this.jitter = options.jitter || true;
  }

  /**
   * Executes a function with retry logic
   * @param {Function} fn - Function to execute
   * @param {Object} context - Context for retry
   * @returns {Promise} - Result of the function
   */
  async execute(fn, context = {}) {
    let lastError;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (attempt === this.maxRetries || !isTransientError(error)) {
          throw error;
        }

        const delay = this.calculateDelay(attempt);
        logger.warn(`Retry attempt ${attempt}/${this.maxRetries} after ${delay}ms`, {
          error: error.message,
          attempt,
          maxRetries: this.maxRetries,
          context
        });

        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Calculates delay with exponential backoff and optional jitter
   * @param {number} attempt - Current attempt number
   * @returns {number} - Delay in milliseconds
   */
  calculateDelay(attempt) {
    let delay = Math.min(
      this.baseDelay * Math.pow(2, attempt - 1),
      this.maxDelay
    );

    if (this.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }

    return Math.floor(delay);
  }

  /**
   * Sleeps for specified duration
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise} - Resolves after sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Global error handler setup
 */
function setupGlobalErrorHandlers() {
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    const correlationId = generateCorrelationId();
    logger.error('Uncaught Exception', {
      error: error.message,
      stack: error.stack,
      correlationId,
      process: {
        pid: process.pid,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage()
      }
    });

    // Exit the process after logging
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    const correlationId = generateCorrelationId();
    logger.error('Unhandled Promise Rejection', {
      reason: reason instanceof Error ? reason.message : reason,
      stack: reason instanceof Error ? reason.stack : undefined,
      promise: promise.toString(),
      correlationId
    });
  });

  // Handle warning events
  process.on('warning', (warning) => {
    logger.warn('Process Warning', {
      message: warning.message,
      stack: warning.stack,
      name: warning.name
    });
  });

  logger.info('Global error handlers initialized');
}

/**
 * Error boundary for async operations
 */
class ErrorBoundary {
  constructor(options = {}) {
    this.onError = options.onError || this.defaultErrorHandler;
    this.fallback = options.fallback || null;
    this.context = options.context || {};
  }

  /**
   * Executes a function with error boundary protection
   * @param {Function} fn - Function to execute
   * @param {Object} context - Additional context
   * @returns {Promise} - Result or fallback value
   */
  async execute(fn, context = {}) {
    const correlationId = generateCorrelationId();
    const executionContext = {
      ...this.context,
      ...context,
      correlationId,
      timestamp: new Date().toISOString()
    };

    try {
      return await fn();
    } catch (error) {
      await this.onError(error, executionContext);

      if (this.fallback) {
        try {
          return await this.fallback(error, executionContext);
        } catch (fallbackError) {
          logger.error('Fallback function failed', {
            error: fallbackError.message,
            originalError: error.message,
            correlationId
          });
          throw error; // Re-throw original error
        }
      }

      throw error;
    }
  }

  /**
   * Default error handler
   * @param {Error} error - The error
   * @param {Object} context - Execution context
   */
  async defaultErrorHandler(error, context) {
    logger.error('Error boundary caught error', {
      error: error.message,
      stack: error.stack,
      context
    });
  }
}

/**
 * Creates a correlation-aware wrapper for functions
 * @param {Function} fn - Function to wrap
 * @param {Object} options - Wrapper options
 * @returns {Function} - Wrapped function
 */
function withCorrelation(fn, options = {}) {
  return async (...args) => {
    const correlationId = generateCorrelationId();
    const context = { ...options.context, correlationId };

    try {
      const result = await fn(...args);
      return result;
    } catch (error) {
      logger.error('Function execution failed', {
        error: error.message,
        function: fn.name || 'anonymous',
        correlationId,
        args: options.logArgs ? args : undefined
      });
      throw error;
    }
  };
}

/**
 * Aggregates multiple errors into a single error
 * @param {Array<Error>} errors - Array of errors
 * @returns {Error} - Aggregated error
 */
function aggregateErrors(errors) {
  if (!errors || errors.length === 0) {
    return null;
  }

  if (errors.length === 1) {
    return errors[0];
  }

  const messages = errors.map(e => e.message).filter(Boolean);
  const uniqueMessages = [...new Set(messages)];

  const error = new Error(
    `Multiple errors occurred (${errors.length}):\n${uniqueMessages.join('\n')}`
  );

  error.name = 'AggregateError';
  error.errors = errors;

  return error;
}

// Global circuit breaker instances
const circuitBreakers = new Map();

/**
 * Gets or creates a circuit breaker for a service
 * @param {string} serviceName - Name of the service
 * @param {Object} options - Circuit breaker options
 * @returns {CircuitBreaker} - Circuit breaker instance
 */
function getCircuitBreaker(serviceName, options = {}) {
  if (!circuitBreakers.has(serviceName)) {
    circuitBreakers.set(serviceName, new CircuitBreaker(options));
  }
  return circuitBreakers.get(serviceName);
}

// Global retry mechanism instance
const defaultRetryMechanism = new RetryMechanism();

module.exports = {
  CircuitBreaker,
  RetryMechanism,
  ErrorBoundary,
  setupGlobalErrorHandlers,
  withCorrelation,
  aggregateErrors,
  getCircuitBreaker,
  defaultRetryMechanism
};