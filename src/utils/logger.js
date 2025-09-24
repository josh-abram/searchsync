const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Logger {
  constructor(options = {}) {
    this.logs = [];
    this.maxLogs = options.maxLogs || 1000;
    this.logLevel = options.logLevel || 'info';
    this.logToFile = options.logToFile || false;
    this.logFilePath = options.logFilePath || path.join(app.getPath('userData'), 'searchsync.log');

    // Log levels in order of severity
    this.levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3
    };
  }

  /**
   * Creates a log entry with structured data
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} context - Additional context
   * @returns {Object} - Log entry
   */
  createLogEntry(level, message, context = {}) {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: {
        ...context,
        correlationId: context.correlationId || null,
        component: context.component || 'unknown',
        version: app.getVersion()
      }
    };
  }

  /**
   * Adds a log entry to the in-memory store and optionally writes to file
   * @param {Object} entry - Log entry
   */
  addLogEntry(entry) {
    this.logs.push(entry);

    // Maintain log size limit with efficient array management
    if (this.logs.length > this.maxLogs) {
      // Remove oldest entries in batches for better performance
      const removeCount = Math.floor(this.maxLogs * 0.1); // Remove 10% when over limit
      this.logs.splice(0, removeCount);
    }

    // Write to file if enabled
    if (this.logToFile) {
      this.writeToLogFile(entry);
    }

    // Also log to console with appropriate method
    const logMethod = entry.level === 'error' ? 'error' :
                      entry.level === 'warn' ? 'warn' :
                      entry.level === 'info' ? 'info' : 'log';

    // Sanitize entry for console output to prevent sensitive data leakage
    const sanitizedEntry = this.sanitizeLogEntry(entry);

    if (sanitizedEntry.context.correlationId) {
      console[logMethod](`[${sanitizedEntry.context.correlationId}] ${sanitizedEntry.message}`, sanitizedEntry.context);
    } else {
      console[logMethod](sanitizedEntry.message, sanitizedEntry.context);
    }
  }

  /**
   * Writes a log entry to the log file
   * @param {Object} entry - Log entry
   */
  writeToLogFile(entry) {
    try {
      // Validate log file path to prevent directory traversal
      if (!this.logFilePath || typeof this.logFilePath !== 'string') {
        throw new Error('Invalid log file path');
      }

      // Ensure path is within userData directory
      const userDataPath = app.getPath('userData');
      if (!this.logFilePath.startsWith(userDataPath)) {
        throw new Error('Log file path must be within user data directory');
      }

      // Redact sensitive information from log entry
      const sanitizedEntry = this.sanitizeLogEntry(entry);
      const logLine = JSON.stringify(sanitizedEntry) + '\n';

      // Use async file write with proper error handling
      fs.appendFileSync(this.logFilePath, logLine, { mode: 0o600 }); // Read/write for owner only
    } catch (error) {
      console.error('Failed to write to log file:', error.message);
    }
  }

  
  /**
   * Sanitizes log entry to remove sensitive information
   * @param {Object} entry - Log entry to sanitize
   * @returns {Object} - Sanitized log entry
   */
  sanitizeLogEntry(entry) {
    const sensitiveKeys = [
      'password', 'token', 'secret', 'key', 'apiToken',
      'personalAccessToken', 'authorization', 'credential'
    ];

    const sanitized = { ...entry };

    // Sanitize context
    if (sanitized.context) {
      sanitized.context = this.redactSensitiveData(sanitized.context);
    }

    return sanitized;
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
          lowerKey.includes('credential')) {
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
   * Logs an error message
   * @param {string} message - Error message
   * @param {Object} context - Additional context
   */
  error(message, context = {}) {
    if (this.levels.error <= this.levels[this.logLevel]) {
      const entry = this.createLogEntry('error', message, context);
      this.addLogEntry(entry);
    }
  }

  /**
   * Logs a warning message
   * @param {string} message - Warning message
   * @param {Object} context - Additional context
   */
  warn(message, context = {}) {
    if (this.levels.warn <= this.levels[this.logLevel]) {
      const entry = this.createLogEntry('warn', message, context);
      this.addLogEntry(entry);
    }
  }

  /**
   * Logs an info message
   * @param {string} message - Info message
   * @param {Object} context - Additional context
   */
  info(message, context = {}) {
    if (this.levels.info <= this.levels[this.logLevel]) {
      const entry = this.createLogEntry('info', message, context);
      this.addLogEntry(entry);
    }
  }

  /**
   * Logs a debug message
   * @param {string} message - Debug message
   * @param {Object} context - Additional context
   */
  debug(message, context = {}) {
    if (this.levels.debug <= this.levels[this.logLevel]) {
      const entry = this.createLogEntry('debug', message, context);
      this.addLogEntry(entry);
    }
  }

  /**
   * Sets the minimum log level
   * @param {string} level - Log level (error, warn, info, debug)
   */
  setLogLevel(level) {
    if (this.levels.hasOwnProperty(level)) {
      this.logLevel = level;
      this.info(`Log level changed to: ${level}`);
    } else {
      this.error(`Invalid log level: ${level}`);
    }
  }

  /**
   * Enables or disables file logging
   * @param {boolean} enabled - Whether to enable file logging
   */
  setFileLogging(enabled) {
    this.logToFile = enabled;
    this.info(`File logging ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Retrieves logs with optional filtering
   * @param {Object} filters - Filter options
   * @returns {Array} - Filtered logs
   */
  getLogs(filters = {}) {
    let filteredLogs = [...this.logs];

    // Filter by level
    if (filters.level) {
      filteredLogs = filteredLogs.filter(log => log.level === filters.level);
    }

    // Filter by component
    if (filters.component) {
      filteredLogs = filteredLogs.filter(log => log.context.component === filters.component);
    }

    // Filter by correlation ID
    if (filters.correlationId) {
      filteredLogs = filteredLogs.filter(log => log.context.correlationId === filters.correlationId);
    }

    // Filter by time range
    if (filters.since) {
      const sinceDate = new Date(filters.since);
      filteredLogs = filteredLogs.filter(log => new Date(log.timestamp) >= sinceDate);
    }

    // Limit results
    if (filters.limit) {
      filteredLogs = filteredLogs.slice(-filters.limit);
    }

    return filteredLogs;
  }

  /**
   * Clears all logs from memory
   */
  clearLogs() {
    this.logs = [];
    this.info('Logs cleared');
  }

  /**
   * Exports logs to a file
   * @param {string} filePath - Path to export file
   */
  exportLogs(filePath) {
    try {
      const logData = this.logs.map(log => JSON.stringify(log)).join('\n');
      fs.writeFileSync(filePath, logData);
      this.info(`Logs exported to: ${filePath}`);
    } catch (error) {
      this.error(`Failed to export logs: ${error.message}`);
    }
  }

  /**
   * Rotates log file if it exceeds size limit
   * @param {number} maxSize - Maximum file size in bytes
   */
  rotateLogFile(maxSize = 10 * 1024 * 1024) {
    if (!this.logToFile) return;

    try {
      if (fs.existsSync(this.logFilePath)) {
        const stats = fs.statSync(this.logFilePath);
        if (stats.size > maxSize) {
          const rotatedPath = `${this.logFilePath}.${Date.now()}`;
          fs.renameSync(this.logFilePath, rotatedPath);
          this.info(`Log file rotated to: ${rotatedPath}`);
        }
      }
    } catch (error) {
      this.error(`Failed to rotate log file: ${error.message}`);
    }
  }
}

// Create a default logger instance
const defaultLogger = new Logger({
  maxLogs: 1000,
  logLevel: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  logToFile: true
});

module.exports = Logger;
module.exports.default = defaultLogger;