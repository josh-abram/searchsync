/**
 * Centralized configuration for all integrations
 * Provides defaults and per-integration overrides
 */

/**
 * Default HTTP configuration
 */
const httpDefaults = {
  timeout: 10000,
  maxRetries: 3,
  retryDelay: 1000,
  retryBackoffFactor: 2,
  maxRetryDelay: 60000,
  retryableMethods: ['GET', 'HEAD', 'OPTIONS'],
  retryableStatusCodes: [408, 429, 500, 502, 503, 504]
};

/**
 * Default search configuration
 */
const searchDefaults = {
  defaultLimit: 50,
  maxLimit: 200,
  defaultFields: ['summary', 'description'],
  fuzzyMatch: true,
  includeArchived: false
};

/**
 * Integration-specific configurations
 */
const integrationConfigs = {
  jira: {
    http: {
      timeout: 15000, // Jira can be slower
      baseUrlPattern: /^https?:\/\/.+/,
      endpoints: {
        search: '/rest/api/3/search',
        issue: '/rest/api/3/issue/{key}',
        user: '/rest/api/3/user',
        myself: '/rest/api/3/myself'
      }
    },
    search: {
      defaultFields: ['summary', 'description', 'status', 'assignee', 'priority', 'created'],
      maxResults: 100,
      jql: {
        default: 'text ~ "{query}"',
        fields: ['project', 'status', 'assignee', 'priority']
      }
    },
    auth: {
      type: 'basic',
      headerPrefix: 'Basic '
    }
  },

  confluence: {
    http: {
      timeout: 10000
    },
    search: {
      defaultFields: ['title', 'excerpt', 'space'],
      maxResults: 50,
      cql: {
        default: 'text ~ "{query}"',
        operators: ['~', '=', '!=', '>', '>=', '<', '<=', 'IN', 'NOT IN', 'AND', 'OR', 'NOT']
      },
      space: {
        keyPattern: /^[A-Z0-9]+$/,
        keyMaxLength: 255
      }
    },
    endpoints: {
      search: '/wiki/rest/api/search',
      content: '/wiki/rest/api/content',
      space: '/wiki/rest/api/space'
    }
  },

  azure: {
    http: {
      timeout: 12000
    },
    search: {
      defaultFields: ['title', 'description', 'state', 'assignedTo'],
      maxResults: 100,
      fields: {
        workItem: [
          'System.Id',
          'System.Title',
          'System.Description',
          'System.State',
          'System.AssignedTo',
          'System.WorkItemType',
          'System.CreatedDate',
          'System.ChangedDate'
        ]
      }
    },
    validation: {
      organization: {
        pattern: /^[a-z0-9\-]{3,50}$/i,
        message: 'Organization name must be 3-50 alphanumeric characters'
      },
      project: {
        pattern: /^[a-z0-9_\-\s]{1,50}$/i,
        message: 'Project name must be 1-50 alphanumeric characters, spaces, underscores, or hyphens'
      }
    }
  },

  asana: {
    http: {
      timeout: 10000,
      baseUrl: 'https://app.asana.com/api/1.0'
    },
    search: {
      defaultFields: ['name', 'notes', 'assignee', 'due_on'],
      maxResults: 100,
      workspace: {
        gidPattern: /^\d+$/,
        message: 'Workspace GIDs should be numeric'
      }
    },
    endpoints: {
      search: '/workspaces/{workspaceId}/tasks/search',
      task: '/tasks/{taskId}',
      workspace: '/workspaces'
    }
  }
};

/**
 * Merges default configuration with integration-specific overrides
 * @param {string} integration - Integration name
 * @param {string} [section] - Configuration section to retrieve
 * @returns {Object} - Merged configuration
 */
function getConfig(integration, section) {
  const config = integrationConfigs[integration];
  if (!config) {
    throw new Error(`Unknown integration: ${integration}`);
  }

  if (section) {
    return {
      ...getDefaultConfig(section),
      ...(config[section] || {})
    };
  }

  // Deep merge all sections
  const result = {};
  const sections = ['http', 'search', 'auth', 'endpoints', 'validation'];

  for (const sec of sections) {
    result[sec] = {
      ...getDefaultConfig(sec),
      ...(config[sec] || {})
    };
  }

  return result;
}

/**
 * Gets default configuration for a section
 * @param {string} section - Configuration section
 * @returns {Object} - Default configuration
 */
function getDefaultConfig(section) {
  switch (section) {
    case 'http':
      return httpDefaults;
    case 'search':
      return searchDefaults;
    default:
      return {};
  }
}

/**
 * Validates configuration for an integration
 * @param {string} integration - Integration name
 * @param {Object} config - Configuration to validate
 * @returns {Object} - Validation result { valid, errors }
 */
function validateConfig(integration, config) {
  const errors = [];
  const integrationConfig = integrationConfigs[integration];

  if (!integrationConfig) {
    errors.push(`Unknown integration: ${integration}`);
    return { valid: false, errors };
  }

  // Validate HTTP configuration
  if (config.http) {
    if (config.http.timeout && (config.http.timeout < 1000 || config.http.timeout > 60000)) {
      errors.push('HTTP timeout must be between 1000 and 60000ms');
    }
    if (config.http.maxRetries && (config.http.maxRetries < 0 || config.http.maxRetries > 10)) {
      errors.push('Max retries must be between 0 and 10');
    }
  }

  // Validate search configuration
  if (config.search) {
    if (config.search.maxResults && (config.search.maxResults < 1 || config.search.maxResults > 500)) {
      errors.push('Max results must be between 1 and 500');
    }
    if (config.search.defaultLimit && (config.search.defaultLimit < 1 || config.search.defaultLimit > config.search.maxResults)) {
      errors.push('Default limit must be between 1 and max results');
    }
  }

  // Integration-specific validation
  if (integration === 'asana' && config.workspace) {
    if (config.workspace.gid && !/^\d+$/.test(config.workspace.gid)) {
      errors.push('Asana workspace GID must be numeric');
    }
  }

  if (integration === 'azure' && config.organization) {
    const orgPattern = integrationConfig.validation?.organization?.pattern;
    if (orgPattern && !orgPattern.test(config.organization)) {
      errors.push(integrationConfig.validation.organization.message);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Gets all available integration names
 * @returns {Array<string>} - Integration names
 */
function getAvailableIntegrations() {
  return Object.keys(integrationConfigs);
}

/**
 * Checks if an integration is available
 * @param {string} integration - Integration name
 * @returns {boolean} - True if available
 */
function isIntegrationAvailable(integration) {
  return Boolean(integrationConfigs[integration]);
}

/**
 * Gets configuration for creating an HTTP client
 * @param {string} integration - Integration name
 * @returns {Object} - HTTP client configuration
 */
function getHttpClientConfig(integration) {
  const config = getConfig(integration, 'http');

  return {
    timeout: config.timeout,
    maxRetries: config.maxRetries,
    retryDelay: config.retryDelay,
    retryBackoffFactor: config.retryBackoffFactor,
    retryableMethods: config.retryableMethods,
    retryableStatusCodes: config.retryableStatusCodes,
    provider: integration
  };
}

module.exports = {
  getConfig,
  getDefaultConfig,
  validateConfig,
  getAvailableIntegrations,
  isIntegrationAvailable,
  getHttpClientConfig,
  httpDefaults,
  searchDefaults,
  integrationConfigs
};