const axios = require('axios');
const { randomUUID } = require('crypto');

/**
 * Creates authentication token based on integration type
 * @param {string} integrationType - Type of integration (jira, confluence, azure, asana)
 * @param {Object} credentials - Credential object
 * @returns {string} - Authentication token/header value
 */
function createAuthToken(integrationType, credentials) {
  switch (integrationType) {
    case 'jira':
    case 'confluence':
      if (!credentials.email || !credentials.apiToken) {
        throw new Error('Email and API token are required for Atlassian integrations');
      }
      return Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64');

    case 'azure':
      if (!credentials.personalAccessToken) {
        throw new Error('Personal Access Token is required for Azure DevOps');
      }
      return Buffer.from(`:${credentials.personalAccessToken}`).toString('base64');

    case 'asana':
      if (!credentials.personalAccessToken) {
        throw new Error('Personal Access Token is required for Asana');
      }
      return credentials.personalAccessToken;

    default:
      throw new Error(`Unsupported integration type: ${integrationType}`);
  }
}

/**
 * Normalizes URL by removing trailing slashes and preventing double segments
 * @param {string} url - URL to normalize
 * @returns {string} - Normalized URL
 */
function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return url;

  try {
    // Parse URL for robust handling
    const parsed = new URL(url);

    // Remove trailing slash from pathname
    let pathname = parsed.pathname.replace(/\/$/, '');

    // Handle Confluence /wiki path specifically
    if (pathname.endsWith('/wiki')) {
      pathname = pathname.slice(0, -5);
    }

    // Reconstruct URL with normalized path
    const normalized = `${parsed.origin}${pathname}`;

    return normalized;
  } catch (error) {
    // Fallback to simple trailing slash removal if URL parsing fails
    return url.endsWith('/') ? url.slice(0, -1) : url;
  }
}

/**
 * Enhanced baseUrl normalization for integrations
 * @param {string} baseUrl - Base URL to normalize
 * @param {Object} options - Normalization options
 * @param {boolean} options.allowTrailingSlash - Whether to allow trailing slash
 * @param {string} options.pathPrefix - Optional path prefix to handle (e.g., 'wiki')
 * @returns {string} - Normalized base URL
 */
function normalizeBaseUrl(baseUrl, options = {}) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error('Base URL is required and must be a string');
  }

  const { allowTrailingSlash = false, pathPrefix } = options;

  try {
    const parsed = new URL(baseUrl);
    let pathname = parsed.pathname;

    // Remove trailing slash unless explicitly allowed
    if (!allowTrailingSlash) {
      pathname = pathname.replace(/\/$/, '');
    }

    // Handle specific path prefixes
    if (pathPrefix) {
      // Remove prefix if it exists at the end
      const prefixPattern = new RegExp(`/${pathPrefix}$`);
      if (prefixPattern.test(pathname)) {
        pathname = pathname.replace(prefixPattern, '');
      }
    }

    // Reconstruct
    const normalized = `${parsed.origin}${pathname}`;

    return normalized;
  } catch (error) {
    throw new Error(`Invalid base URL format: ${baseUrl}`);
  }
}

/**
 * Normalizes Atlassian-style dates (e.g. 2024-09-23T10:28:49.123+0000) to ISO-8601.
 * @param {string|Date|null|undefined} value - Raw date value from Atlassian APIs
 * @returns {string|null} - ISO-8601 formatted date string or null if invalid
 */
function normalizeAtlassianDate(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return isNaN(value) ? null : value.toISOString();
  }

  // Handle JSM date objects: { iso8601: '...', epochMillis: 123 }
  if (typeof value === 'object') {
    const iso = value.iso8601 || value.ISO8601 || value.iso || null;
    if (typeof iso === 'string' && iso.trim()) {
      return normalizeAtlassianDate(iso);
    }
    const epoch = value.epochMillis || value.epoch || null;
    if (typeof epoch === 'number' && Number.isFinite(epoch)) {
      const asDate = new Date(epoch);
      return isNaN(asDate) ? null : asDate.toISOString();
    }
    // Unknown object shape; give up gracefully
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const asDate = new Date(value);
    return isNaN(asDate) ? null : asDate.toISOString();
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  // Normalize Atlassian offsets like +0000 to +00:00 so that Date.parse succeeds.
  const normalized = trimmed.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

/**
 * Builds a full URL from base URL and path segments
 * @param {string} baseUrl - Base URL
 * @param {...string} segments - Path segments to join
 * @returns {string} - Complete URL
 */
function buildUrl(baseUrl, ...segments) {
  const normalized = normalizeBaseUrl(baseUrl, { allowTrailingSlash: false });
  const cleanSegments = segments
    .filter(segment => segment && typeof segment === 'string')
    .map(segment => segment.replace(/^\/+|\/+$/g, '')); // Remove leading/trailing slashes

  const path = cleanSegments.join('/');
  return path ? `${normalized}/${path}` : normalized;
}

/**
 * Creates axios request configuration with common settings
 * @param {string} integrationType - Type of integration
 * @param {Object} credentials - Credential object
 * @param {Object} options - Additional request options
 * @returns {Object} - Axios request configuration
 */
function createRequestConfig(integrationType, credentials, options = {}) {
  const baseConfig = {
    timeout: options.timeout || 15000,
    validateStatus: options.validateStatus || false,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'SearchSync/0.0.8'
    }
  };

  // Add authentication based on integration type
  switch (integrationType) {
    case 'jira':
    case 'confluence':
      const authToken = createAuthToken(integrationType, credentials);
      baseConfig.headers.Authorization = `Basic ${authToken}`;
      break;

    case 'azure':
      const azureToken = createAuthToken(integrationType, credentials);
      baseConfig.headers.Authorization = `Basic ${azureToken}`;
      break;

    case 'asana':
      const asanaToken = createAuthToken(integrationType, credentials);
      baseConfig.headers.Authorization = `Bearer ${asanaToken}`;
      baseConfig.headers.Accept = 'application/json';
      break;
  }

  // Add correlation ID for request tracking
  if (options.correlationId) {
    baseConfig.headers['X-Correlation-ID'] = options.correlationId;
  }

  // Merge additional options
  return { ...baseConfig, ...options };
}

/**
 * Calculates activity metrics from dates
 * @param {Object} dates - Object containing created, updated, and due dates
 * @returns {Object} - Activity metrics
 */
function calculateActivityMetrics(dates = {}) {
  const now = new Date();
  const metrics = {};

  // Calculate days since various events
  if (dates.created) {
    metrics.daysSinceCreated = Math.floor(
      (now - new Date(dates.created)) / (1000 * 60 * 60 * 24)
    );
  }

  if (dates.updated) {
    metrics.daysSinceUpdated = Math.floor(
      (now - new Date(dates.updated)) / (1000 * 60 * 60 * 24)
    );
  }

  if (dates.due) {
    const dueDate = new Date(dates.due);
    metrics.daysUntilDue = Math.floor(
      (dueDate - now) / (1000 * 60 * 60 * 24)
    );
    metrics.isOverdue = metrics.daysUntilDue < 0;
    metrics.isDueSoon = metrics.daysUntilDue >= 0 && metrics.daysUntilDue <= 3;
  }

  return metrics;
}

/**
 * Creates activity indicators based on metrics and metadata
 * @param {Object} metrics - Activity metrics from calculateActivityMetrics
 * @param {Object} metadata - Additional metadata
 * @returns {Object} - Activity indicators
 */
function createActivityIndicators(metrics, metadata = {}) {
  const indicators = {
    hasRecentActivity: false,
    isNew: false,
    isOverdue: false,
    isDueSoon: false,
    hasComments: false,
    hasAttachments: false,
    hasEstimates: false,
    isHighPriority: false,
    hasRichContent: false,
    isLongForm: false
  };

  // Recent activity (within 7 days)
  if (metrics.daysSinceUpdated !== undefined) {
    indicators.hasRecentActivity = metrics.daysSinceUpdated <= 7;
  }

  // New items (within 3 days)
  if (metrics.daysSinceCreated !== undefined) {
    indicators.isNew = metrics.daysSinceCreated <= 3;
  }

  // Due date indicators
  indicators.isOverdue = metrics.isOverdue || false;
  indicators.isDueSoon = metrics.isDueSoon || false;

  // Content engagement
  indicators.hasComments = (metadata.commentCount || 0) > 0;
  indicators.hasAttachments = (metadata.attachmentCount || 0) > 0;

  // Estimates
  indicators.hasEstimates = Boolean(
    metadata.storyPoints ||
    metadata.originalEstimate ||
    metadata.remainingEstimate
  );

  // Priority
  indicators.isHighPriority = Boolean(
    metadata.priority &&
    (metadata.priority.toLowerCase().includes('high') ||
     metadata.priority === '1' ||
     metadata.priority.toLowerCase().includes('critical'))
  );

  // Content type indicators (mainly for Confluence)
  indicators.hasRichContent = Boolean(metadata.hasRichContent);
  indicators.isLongForm = Boolean(metadata.isLongForm);

  return indicators;
}

/**
 * Handles API errors consistently across integrations
 * @param {Error} error - The error object
 * @param {string} integrationName - Name of the integration for context
 * @param {string} correlationId - Request correlation ID
 * @returns {string} - Sanitized error message
 */
function handleApiError(error, integrationName, correlationId = null) {
  // Import the error sanitizer
  let sanitizeErrorMessage, createSanitizedError;
  try {
    ({ sanitizeErrorMessage, createSanitizedError } = require('../utils/error-sanitizer'));
  } catch (e) {
    // Fallback if error sanitizer is not available
    sanitizeErrorMessage = (msg) => msg || 'Unknown error';
    createSanitizedError = (err) => ({ message: err.message });
  }

  const Logger = require('../utils/logger');
  const logger = new Logger({ component: integrationName });

  // Log the full error for debugging (with sanitized data)
  const logContext = {
    integration: integrationName,
    correlationId,
    timestamp: new Date().toISOString()
  };

  logger.error('API Error', {
    ...logContext,
    ...createSanitizedError(error, { provider: integrationName, correlationId })
  });

  // Extract user-friendly message
  let message = error?.message || 'Unknown error';

  // Handle common HTTP status codes
  if (error.response) {
    const status = error.response.status;

    switch (status) {
      case 401:
      case 403:
        message = 'Authentication failed. Please check your credentials and permissions.';
        break;
      case 404:
        message = 'The requested resource was not found. Please verify your configuration.';
        break;
      case 429:
        const retryAfter = error.response.headers?.['retry-after'];
        message = retryAfter
          ? `Too many requests. Please wait ${retryAfter} seconds and try again.`
          : 'Too many requests. Please wait a moment and try again.';
        break;
      case 500:
      case 502:
      case 503:
      case 504:
        message = 'The service is temporarily unavailable. Please try again later.';
        break;
      default:
        message = 'Request failed. Please try again.';
    }
  } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
    message = 'Unable to connect to the service. Please check your network connection.';
  } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
    message = 'The request timed out. Please try again.';
  } else if (error.code === 'ENETUNREACH') {
    message = 'Network is unreachable. Please check your internet connection.';
  }

  // Sanitize the final message to ensure no sensitive information leaks
  const sanitizedMessage = sanitizeErrorMessage(message, {
    provider: integrationName,
    maxLength: 150
  });

  return `${integrationName} error: ${sanitizedMessage}`;
}

/**
 * Checks if an error is transient and should be retried
 * @param {Error} error - The error object
 * @returns {boolean} - True if error is transient
 */
function isTransientError(error) {
  if (!error) return false;

  // Network errors that might resolve themselves
  const transientCodes = [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNABORTED',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ECONNREFUSED'
  ];

  // HTTP status codes that indicate temporary issues
  const transientStatusCodes = [408, 429, 500, 502, 503, 504];

  if (error.code && transientCodes.includes(error.code)) {
    return true;
  }

  if (error.response && transientStatusCodes.includes(error.response.status)) {
    return true;
  }

  return false;
}

/**
 * Generates a unique correlation ID for request tracking
 * @returns {string} - UUID v4 correlation ID
 */
function generateCorrelationId() {
  return randomUUID();
}

/**
 * Validates required fields are present and non-empty
 * @param {Object} config - Configuration object
 * @param {Array<string>} requiredFields - List of required field names
 * @returns {string|null} - Error message if validation fails, null otherwise
 */
function validateRequiredFields(config, requiredFields) {
  if (!config || typeof config !== 'object') {
    return 'Configuration object is required';
  }

  const missing = requiredFields.filter(field => {
    const value = config[field];
    return !value || (typeof value === 'string' && value.trim() === '');
  });

  if (missing.length > 0) {
    return `Missing required fields: ${missing.join(', ')}`;
  }

  return null;
}

/**
 * Sanitizes error messages to prevent information disclosure
 * @param {string} message - Raw error message
 * @returns {string} - Sanitized error message
 */
function sanitizeErrorMessage(message) {
  if (!message || typeof message !== 'string') {
    return 'An unknown error occurred';
  }

  // Remove potential sensitive information
  const sanitized = message
    .replace(/\/\/[^@]+@/g, '//***@') // Remove credentials from URLs
    .replace(/api[_-]?key[=:\s]+[^\s&]+/gi, 'api-key=***') // Remove API keys
    .replace(/token[=:\s]+[^\s&]+/gi, 'token=***') // Remove tokens
    .replace(/password[=:\s]+[^\s&]+/gi, 'password=***') // Remove passwords
    .replace(/\/[^\/\s]+\/[^\/\s]+\.atlassian\.net/g, '/***.atlassian.net') // Remove instance names
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '***'); // Remove UUIDs

  return sanitized;
}

module.exports = {
  createAuthToken,
  normalizeUrl,
  normalizeBaseUrl,
  buildUrl,
  createRequestConfig,
  calculateActivityMetrics,
  createActivityIndicators,
  handleApiError,
  isTransientError,
  generateCorrelationId,
  validateRequiredFields,
  sanitizeErrorMessage,
  normalizeAtlassianDate
};