const ElectronStore = require('electron-store');
const Store = ElectronStore.default || ElectronStore;
const Logger = require('./logger');
const { createValidator, Schemas, ValidationError } = require('./schema-validator');
const { generateCorrelationId } = require('../integrations/utils');

// Create logger instance for configuration management
const logger = new Logger({
  component: 'ConfigManager'
});

/**
 * Configuration manager with schema validation
 */
class ConfigManager {
  constructor(options = {}) {
    this.storeName = options.storeName || 'config';
    this.schema = options.schema;
    this.defaults = options.defaults || {};
    this.migrations = options.migrations || [];

    // Initialize electron-store (we handle validation separately)
    this.store = new Store({
      name: this.storeName,
      defaults: this.defaults,
      beforeEachMigration: (migration, context) => {
        logger.info(`Running migration: ${migration.version}`, {
          fromVersion: context.fromVersion,
          toVersion: context.toVersion
        });
      },
      migrations: this.migrations.length > 0 ? this.migrations.reduce((acc, migration) => {
        acc[migration.version] = migration.migrate;
        return acc;
      }, {}) : undefined
    });

    // Create schema validator
    this.validator = this.schema ? createValidator(this.schema) : null;

    // Validate existing configuration on startup
    this.validateConfig();
  }

  
  /**
   * Validates the entire configuration
   */
  validateConfig() {
    if (!this.validator) return;

    try {
      const config = this.store.store;
      const result = this.validator.validate(config);

      if (!result.valid) {
        logger.warn('Configuration validation failed', {
          errors: result.errors
        });

        // Attempt to fix common issues
        this.attemptConfigRepair(result.errors);
      } else {
        logger.info('Configuration validation passed');
      }
    } catch (error) {
      logger.error('Configuration validation error', {
        error: error.message
      });
    }
  }

  /**
   * Attempts to repair configuration issues
   * @param {Object} errors - Validation errors
   */
  attemptConfigRepair(errors) {
    const repairs = [];

    for (const [field, fieldErrors] of Object.entries(errors)) {
      const schema = this.schema[field];

      if (schema && schema.default !== undefined) {
        // Reset to default if validation fails
        this.store.set(field, schema.default);
        repairs.push(`${field} reset to default`);
        logger.info(`Reset ${field} to default value`, {
          default: schema.default
        });
      }
    }

    if (repairs.length > 0) {
      logger.info('Configuration repairs completed', {
        repairs
      });
    }
  }

  /**
   * Gets a configuration value
   * @param {string} key - Configuration key
   * @param {*} defaultValue - Default value if not found
   * @returns {*} - Configuration value
   */
  get(key, defaultValue) {
    try {
      return this.store.get(key, defaultValue);
    } catch (error) {
      logger.error('Failed to get configuration value', {
        key,
        error: error.message
      });
      return defaultValue;
    }
  }

  /**
   * Sets a configuration value with validation
   * @param {string} key - Configuration key
   * @param {*} value - Value to set
   * @returns {boolean} - True if successful
   */
  set(key, value) {
    const correlationId = generateCorrelationId();

    try {
      // Validate if schema exists for this key
      if (this.schema && this.schema[key]) {
        const fieldResult = require('./schema-validator').validateField(
          value,
          key,
          this.schema[key]
        );

        if (!fieldResult.valid) {
          logger.warn('Configuration validation failed', {
            key,
            errors: fieldResult.errors,
            correlationId
          });
          throw new ValidationError(
            `Invalid ${key}: ${fieldResult.errors.join(', ')}`,
            key,
            value
          );
        }

        value = fieldResult.value;
      }

      // Store the value
      this.store.set(key, value);

      logger.debug('Configuration value updated', {
        key,
        correlationId
      });

      return true;
    } catch (error) {
      logger.error('Failed to set configuration value', {
        key,
        error: error.message,
        correlationId
      });
      throw error;
    }
  }

  /**
   * Gets multiple configuration values
   * @param {Array<string>} keys - Configuration keys
   * @returns {Object} - Configuration values
   */
  getMany(keys) {
    const result = {};

    for (const key of keys) {
      result[key] = this.get(key);
    }

    return result;
  }

  /**
   * Sets multiple configuration values
   * @param {Object} values - Key-value pairs to set
   * @returns {Object} - Results for each key
   */
  setMany(values) {
    const results = {};
    const errors = {};

    for (const [key, value] of Object.entries(values)) {
      try {
        results[key] = this.set(key, value);
      } catch (error) {
        errors[key] = error.message;
      }
    }

    return { results, errors };
  }

  /**
   * Deletes a configuration key
   * @param {string} key - Key to delete
   */
  delete(key) {
    try {
      this.store.delete(key);
      logger.debug('Configuration key deleted', { key });
    } catch (error) {
      logger.error('Failed to delete configuration key', {
        key,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Gets all configuration
   * @returns {Object} - All configuration
   */
  getAll() {
    return this.store.store;
  }

  /**
   * Resets configuration to defaults
   */
  reset() {
    try {
      this.store.clear();

      // Apply defaults
      if (this.defaults) {
        for (const [key, value] of Object.entries(this.defaults)) {
          this.store.set(key, value);
        }
      }

      logger.info('Configuration reset to defaults');
    } catch (error) {
      logger.error('Failed to reset configuration', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Watches for configuration changes
   * @param {Function} callback - Callback function
   * @returns {Function} - Unwatch function
   */
  watch(callback) {
    return this.store.onDidChange((newValue, oldValue) => {
      try {
        callback(newValue, oldValue);
      } catch (error) {
        logger.error('Configuration watch callback error', {
          error: error.message
        });
      }
    });
  }

  /**
   * Gets configuration size
   * @returns {number} - Size in bytes
   */
  getSize() {
    return Buffer.byteLength(JSON.stringify(this.store.store), 'utf8');
  }

  /**
   * Exports configuration to file
   * @param {string} filePath - Export file path
   */
  export(filePath) {
    try {
      const fs = require('fs');
      const config = this.getAll();

      // Remove sensitive data
      const sanitized = this.sanitizeForExport(config);

      fs.writeFileSync(filePath, JSON.stringify(sanitized, null, 2));
      logger.info('Configuration exported', { path: filePath });
    } catch (error) {
      logger.error('Failed to export configuration', {
        error: error.message,
        path: filePath
      });
      throw error;
    }
  }

  /**
   * Imports configuration from file
   * @param {string} filePath - Import file path
   */
  import(filePath) {
    const fs = require('fs');
    const path = require('path');

    try {
      // Validate file path
      if (!filePath || typeof filePath !== 'string') {
        throw new Error('Invalid file path');
      }

      // Resolve and validate file path
      const resolvedPath = path.resolve(filePath);

      // Prevent directory traversal attacks
      if (resolvedPath.includes('..')) {
        throw new Error('Invalid file path: directory traversal not allowed');
      }

      // Check file size (limit to 1MB)
      const stats = fs.statSync(resolvedPath);
      if (stats.size > 1024 * 1024) {
        throw new Error('Configuration file too large (max 1MB)');
      }

      // Read file with encoding validation
      const data = fs.readFileSync(resolvedPath, 'utf8');

      // Basic JSON structure validation before parsing
      if (!data.trim().startsWith('{') || !data.trim().endsWith('}')) {
        throw new Error('Invalid configuration file format');
      }

      // Safe JSON parsing with error handling
      let config;
      try {
        config = JSON.parse(data);
      } catch (parseError) {
        throw new Error('Invalid JSON in configuration file');
      }

      // Validate input is an object
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        throw new Error('Configuration must be an object');
      }

      // Validate imported configuration
      if (this.validator) {
        const result = this.validator.validate(config);
        if (!result.valid) {
          throw new ValidationError(
            `Invalid configuration: ${JSON.stringify(result.errors)}`,
            'import',
            config
          );
        }
      }

      // Apply configuration safely
      for (const [key, value] of Object.entries(config)) {
        try {
          this.set(key, value);
        } catch (setError) {
          logger.warn('Failed to import configuration key', {
            key,
            error: setError.message
          });
        }
      }

      logger.info('Configuration imported', { path: resolvedPath });
    } catch (error) {
      logger.error('Failed to import configuration', {
        error: error.message,
        path: filePath
      });
      throw error;
    }
  }

  /**
   * Sanitizes configuration for export
   * @param {Object} config - Configuration to sanitize
   * @returns {Object} - Sanitized configuration
   */
  sanitizeForExport(config) {
    return this.redactSensitiveData(config);
  }

  /**
   * Recursively redacts sensitive data from an object
   * @param {*} data - Data to sanitize
   * @returns {*} - Sanitized data
   */
  redactSensitiveData(data) {
    if (typeof data !== 'object' || data === null) {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map(item => this.redactSensitiveData(item));
    }

    const result = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();

      if (lowerKey.includes('password') ||
          lowerKey.includes('token') ||
          lowerKey.includes('secret') ||
          lowerKey.includes('apikey') ||
          lowerKey.includes('credential') ||
          lowerKey.includes('authorization')) {
        result[key] = '***REDACTED***';
      } else if (typeof value === 'object') {
        result[key] = this.redactSensitiveData(value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Gets configuration statistics
   * @returns {Object} - Statistics
   */
  getStats() {
    const config = this.getAll();
    const keys = Object.keys(config);

    return {
      keyCount: keys.length,
      sizeBytes: this.getSize(),
      hasValidation: Boolean(this.validator),
      lastModified: this.store.lastModified,
      keys: keys
    };
  }
}

/**
 * Creates configuration managers for different parts of the app
 */
function createConfigManagers() {
  const correlationId = generateCorrelationId();

  logger.info('Creating configuration managers', { correlationId });

  // Main app settings
  const appConfig = new ConfigManager({
    storeName: 'app-settings',
    schema: Schemas.appSettings,
    defaults: {
      searchDelay: 300,
      maxResults: 50,
      enableAnalytics: false,
      logLevel: 'info',
      theme: 'system'
    },
    migrations: [
      {
        version: '1.0.0',
        migrate: (store) => {
          // Migration from older versions
          if (store.has('searchDebounce')) {
            store.set('searchDelay', store.get('searchDebounce'));
            store.delete('searchDebounce');
          }
        }
      }
    ]
  });

  // UI settings
  const uiConfig = new ConfigManager({
    storeName: 'ui-settings',
    schema: Schemas.uiSettings,
    defaults: {
      windowWidth: 800,
      windowHeight: 600,
      alwaysOnTop: false,
      showInTray: true,
      hotkey: 'CmdOrCtrl+Shift+S'
    }
  });

  // Integration configurations
  const integrationConfigs = {
    jira: new ConfigManager({
      storeName: 'jira-config',
      schema: Schemas.integration
    }),
    confluence: new ConfigManager({
      storeName: 'confluence-config',
      schema: Schemas.integration
    }),
    azureDevops: new ConfigManager({
      storeName: 'azure-config',
      schema: { ...Schemas.integration, ...Schemas.azureDevOps }
    }),
    asana: new ConfigManager({
      storeName: 'asana-config',
      schema: Schemas.integration
    })
  };

  return {
    app: appConfig,
    ui: uiConfig,
    integrations: integrationConfigs
  };
}

module.exports = {
  ConfigManager,
  createConfigManagers
};