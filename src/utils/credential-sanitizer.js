/**
 * Credential sanitization utility
 *
 * This utility provides functions to sanitize credentials and sensitive data
 * to prevent exposure to renderer processes or logs.
 */

// Import integration registry safely to avoid circular dependency issues
let integrationRegistry;
try {
  const registry = require('../integrations/registry');
  integrationRegistry = registry.integrationRegistry || registry;
} catch (error) {
  console.error('Failed to load integration registry:', error);
  integrationRegistry = {};
}

/**
 * Mask for sensitive values
 */
const SENSITIVE_VALUE_MASK = '••••••••';

/**
 * Sanitizes settings for renderer process by masking all sensitive values
 * @param {Object} settings - Raw settings object
 * @returns {Object} - Sanitized settings with masked sensitive values
 */
function sanitizeSettingsForRenderer(settings) {
  if (!settings || typeof settings !== 'object') {
    return settings;
  }

  // Deep clone to avoid modifying original
  const sanitized = JSON.parse(JSON.stringify(settings));

  // Sanitize integrations object
  if (sanitized.integrations && typeof sanitized.integrations === 'object') {
    for (const [integrationId, integrationConfig] of Object.entries(sanitized.integrations)) {
      if (integrationConfig && typeof integrationConfig === 'object') {
        const definition = integrationRegistry[integrationId];

        // Skip if integration definition not found
        if (!definition) {
          continue;
        }

        // Apply defaults for any missing properties to keep UI consistent
        if (definition && Array.isArray(definition.sensitiveKeys)) {
          for (const sensitiveKey of definition.sensitiveKeys) {
            const rawValue = integrationConfig[sensitiveKey];

            if (typeof rawValue === 'object' && rawValue !== null) {
              integrationConfig[sensitiveKey] = {
                hasCredential: Boolean(rawValue.hasCredential)
              };
            } else if (typeof rawValue === 'string' && rawValue.length > 0) {
              integrationConfig[sensitiveKey] = {
                hasCredential: true
              };
            } else {
              integrationConfig[sensitiveKey] = {
                hasCredential: false
              };
            }
          }
        }
      }
    }
  }

  return sanitized;
}

/**
 * Checks if a setting key contains sensitive data
 * @param {string} key - Setting key to check
 * @returns {boolean} - True if key is sensitive
 */
function isSensitiveKey(key) {
  if (!key || typeof key !== 'string') return false;

  // Check all integration sensitive keys
  for (const definition of Object.values(integrationRegistry)) {
    if (definition.sensitiveKeys) {
      for (const sensitiveKey of definition.sensitiveKeys) {
        if (key === `integrations.${definition.id}.${sensitiveKey}`) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Sanitizes a single setting value
 * @param {string} key - Setting key
 * @param {*} value - Setting value
 * @returns {*} - Sanitized value
 */
function sanitizeSettingValue(key, value) {
  if (!isSensitiveKey(key)) {
    return value;
  }

  if (!value) {
    return '';
  }

  if (typeof value === 'object' && value !== null) {
    return {
      hasCredential: Boolean(value.hasCredential)
    };
  }

  return {
    hasCredential: Boolean(value && value.length > 0)
  };
}

/**
 * Securely clears sensitive data from an object
 * @param {Object} obj - Object to clear
 * @param {Array<string>} sensitiveKeys - Keys to clear
 */
function clearSensitiveData(obj, sensitiveKeys) {
  if (!obj || typeof obj !== 'object') return;

  for (const key of sensitiveKeys) {
    if (obj[key] !== undefined) {
      // Overwrite with null and then delete to clear memory
      obj[key] = null;
      delete obj[key];
    }
  }
}

/**
 * Creates a sanitized copy of connection test config
 * @param {Object} config - Test connection config
 * @param {string} integrationId - Integration ID
 * @returns {Object} - Sanitized config for logging
 */
function sanitizeTestConfig(config, integrationId) {
  if (!config || typeof config !== 'object') {
    return config;
  }

  const sanitized = { ...config };
  const definition = integrationRegistry[integrationId];

  if (definition && definition.sensitiveKeys) {
    for (const sensitiveKey of definition.sensitiveKeys) {
      if (Object.prototype.hasOwnProperty.call(sanitized, sensitiveKey)) {
        sanitized[sensitiveKey] = '[REDACTED]';
      }
    }
  }

  return sanitized;
}

module.exports = {
  sanitizeSettingsForRenderer,
  isSensitiveKey,
  sanitizeSettingValue,
  clearSensitiveData,
  sanitizeTestConfig,
  SENSITIVE_VALUE_MASK
};