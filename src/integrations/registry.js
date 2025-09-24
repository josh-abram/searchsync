const axios = require('axios');

const jiraSearch = require('./jira');
const confluenceSearch = require('./confluence');
const azureSearch = require('./azure-devops');
const { searchAsana } = require('./asana');

const ATLASSIAN_DOMAIN_REGEX = /^https:\/\/[a-zA-Z0-9-]+\.atlassian\.net\/?$/;

// Shared validation utilities
const validators = {
  // Check if required fields are present
  hasRequiredFields: (config, fields) => {
    return fields.every(field => config[field] && config[field].trim() !== '');
  },

  // Validate email format
  isValidEmail: (email) => {
    return !email || email.includes('@');
  },

  // Validate Atlassian URL
  isValidAtlassianUrl: (url) => {
    return ATLASSIAN_DOMAIN_REGEX.test(url);
  },

  // Format error message for missing required fields
  formatMissingFieldsError: (config, integrationName, fields) => {
    const fieldNames = {
      baseUrl: 'Base URL',
      apiToken: 'API Token',
      email: 'Email',
      organization: 'Organization',
      project: 'Project',
      personalAccessToken: 'Personal Access Token'
    };

    const missing = fields
      .filter(field => !config[field] || config[field].trim() === '')
      .map(field => fieldNames[field] || field);

    return `${integrationName} configuration is incomplete. Please provide: ${missing.join(', ')}.`;
  },

  // Common test connection error formatter
  formatTestError: (error, integrationName) => {
    let message = error?.message || 'Unknown error';

    if (message.includes('401') || message.includes('Unauthorized') ||
        message.includes('403') || message.includes('Forbidden')) {
      message = 'Authentication failed. Please check your credentials and permissions.';
    } else if (message.includes('404') || message.includes('Not Found')) {
      message = 'The resource was not found. Please verify your configuration.';
    } else if (message.includes('timeout') || message.includes('ECONNREFUSED')) {
      message = 'Connection timed out. Please check your network connection.';
    }

    return `${integrationName} error: ${message}`;
  }
};

const integrationRegistry = {
  jira: {
    id: 'jira',
    displayName: 'Jira Service Desk',
    sourceName: 'Jira',
    filterKey: 'jira',
    configDefaults: {
      enabled: true,
      baseUrl: '',
      email: '',
      apiToken: '',
      searchShortcut: 'jsd',
      productType: 'jira'
    },
    sensitiveKeys: ['apiToken'],
    allowedKeys: ['enabled', 'baseUrl', 'email', 'apiToken', 'searchShortcut', 'productType'],
    resultExtractor: (value) => (Array.isArray(value) ? value : []),
    validateSearchConfig: (config) => {
      if (!validators.hasRequiredFields(config, ['baseUrl', 'apiToken'])) {
        return validators.formatMissingFieldsError(config, 'Jira', ['baseUrl', 'apiToken']);
      }
      return null;
    },
    validateTestConfig: (config) => {
      if (!validators.hasRequiredFields(config, ['baseUrl', 'apiToken'])) {
        return validators.formatMissingFieldsError(config, 'Jira', ['baseUrl', 'apiToken']);
      }
      if (!validators.isValidAtlassianUrl(config.baseUrl)) {
        return 'URL format is invalid. It should be in the format: https://your-domain.atlassian.net';
      }
      if (!validators.isValidEmail(config.email)) {
        return 'Email format is invalid. Please provide a valid email address.';
      }
      return null;
    },
    searchHandler: jiraSearch,
    testEvent: 'test-jira-connection',
    async testConnection(config) {
      // Basic validation already done by validateTestConfig
      const baseUrl = config.baseUrl.replace(/\/$/, '');

      // Build auth header
      const token = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');

      const productType = config.productType === 'serviceDesk' ? 'serviceDesk' : 'jira';

      if (productType === 'jira') {
        // Jira platform validation
        const serverInfo = await axios.get(`${baseUrl}/rest/api/3/serverInfo`, {
          headers: { 'Accept': 'application/json', 'Authorization': `Basic ${token}` },
          timeout: 10000,
          validateStatus: false
        });

        if (serverInfo.status !== 200) {
          throw new Error(`API returned status ${serverInfo.status}: ${serverInfo.statusText || 'Server info failed'}`);
        }

        const myself = await axios.get(`${baseUrl}/rest/api/3/myself`, {
          headers: { 'Accept': 'application/json', 'Authorization': `Basic ${token}` },
          timeout: 10000,
          validateStatus: false
        });

        if (myself.status === 410) {
          throw new Error('Jira not enabled for this site.');
        }

        if (myself.status !== 200) {
          throw new Error(`API returned status ${myself.status}: ${myself.statusText || 'Authentication failed'}`);
        }

        const searchResponse = await axios.post(
          `${baseUrl}/rest/api/3/search`,
          { jql: 'issueKey IS NOT EMPTY ORDER BY updated DESC', maxResults: 1, startAt: 0, fields: ['summary'] },
          {
            headers: {
              'Authorization': `Basic ${token}`,
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            },
            timeout: 10000,
            validateStatus: false,
            params: {
              validateQuery: 'warn'
            }
          }
        );

        if (searchResponse.status === 401 || searchResponse.status === 403) {
          throw new Error('Authentication failed. Please check your credentials and permissions.');
        }

        if (searchResponse.status === 410) {
          throw new Error('Jira not enabled for this site.');
        }

        if (searchResponse.status === 404) {
          throw new Error('Jira search API not available. Ensure Jira Software is enabled.');
        }

        if (searchResponse.status !== 200) {
          throw new Error(`API returned status ${searchResponse.status}: ${searchResponse.statusText || 'Search failed'}`);
        }

        const total = Array.isArray(searchResponse.data?.issues) ? searchResponse.data.issues.length : 0;
        return { success: true, message: `Connection successful. Found ${total} test results.` };
      }

      // Service Management validation
      const servicedeskResponse = await axios.get(`${baseUrl}/rest/servicedeskapi/servicedesk`, {
        headers: {
          'Authorization': `Basic ${token}`,
          'Accept': 'application/json'
        },
        timeout: 10000,
        validateStatus: false
      });

      if (servicedeskResponse.status === 401 || servicedeskResponse.status === 403) {
        throw new Error('Authentication failed. Please check your credentials and permissions.');
      }

      if (servicedeskResponse.status === 404) {
        throw new Error('Service desk API not available. Ensure Jira Service Management is enabled.');
      }

      if (servicedeskResponse.status !== 200) {
        throw new Error(`API returned status ${servicedeskResponse.status}: ${servicedeskResponse.statusText || 'Service desk access failed'}`);
      }

      const desks = Array.isArray(servicedeskResponse.data?.values) ? servicedeskResponse.data.values.length : 0;
      return { success: true, message: `Service Management connection successful. Accessible service desks: ${desks}.` };
    },
    formatTestError(error) {
      if (error?.message && error.message.includes('Jira not enabled for this site')) {
        return 'Jira error: Jira not enabled for this site.';
      }
      return validators.formatTestError(error, 'Jira');
    }
  },
  confluence: {
    id: 'confluence',
    displayName: 'Confluence',
    sourceName: 'Confluence',
    filterKey: 'confluence',
    configDefaults: {
      enabled: true,
      baseUrl: '',
      email: '',
      apiToken: '',
      space: '',
      searchShortcut: 'con'
    },
    sensitiveKeys: ['apiToken'],
    allowedKeys: ['enabled', 'baseUrl', 'email', 'apiToken', 'space', 'searchShortcut'],
    resultExtractor: (value) => (Array.isArray(value) ? value : []),
    validateSearchConfig: (config) => {
      if (!validators.hasRequiredFields(config, ['baseUrl', 'apiToken'])) {
        return validators.formatMissingFieldsError(config, 'Confluence', ['baseUrl', 'apiToken']);
      }
      return null;
    },
    validateTestConfig: (config) => {
      if (!validators.hasRequiredFields(config, ['baseUrl', 'apiToken'])) {
        return validators.formatMissingFieldsError(config, 'Confluence', ['baseUrl', 'apiToken']);
      }
      if (!validators.isValidAtlassianUrl(config.baseUrl)) {
        return 'URL format is invalid. It should be in the format: https://your-domain.atlassian.net';
      }
      if (!validators.isValidEmail(config.email)) {
        return 'Email format is invalid. Please provide a valid email address.';
      }
      return null;
    },
    searchHandler: confluenceSearch,
    testEvent: 'test-confluence-connection',
    async testConnection(config) {
      const testResults = await confluenceSearch('test', config);
      return {
        success: true,
        message: `Connection successful. Found ${testResults.length} test results.`
      };
    },
    formatTestError(error) {
      return validators.formatTestError(error, 'Confluence');
    }
  },
  azureDevops: {
    id: 'azureDevops',
    displayName: 'Azure DevOps',
    sourceName: 'Azure DevOps',
    filterKey: 'azureDevops',
    configDefaults: {
      enabled: true,
      organization: '',
      project: '',
      personalAccessToken: '',
      searchShortcut: 'ado'
    },
    sensitiveKeys: ['personalAccessToken'],
    allowedKeys: ['enabled', 'organization', 'project', 'personalAccessToken', 'searchShortcut'],
    resultExtractor: (value) => (Array.isArray(value) ? value : []),
    validateSearchConfig: (config) => {
      if (!validators.hasRequiredFields(config, ['organization', 'project', 'personalAccessToken'])) {
        return validators.formatMissingFieldsError(config, 'Azure DevOps', ['organization', 'project', 'personalAccessToken']);
      }
      return null;
    },
    validateTestConfig: (config) => {
      if (!validators.hasRequiredFields(config, ['organization', 'project', 'personalAccessToken'])) {
        return validators.formatMissingFieldsError(config, 'Azure DevOps', ['organization', 'project', 'personalAccessToken']);
      }
      return null;
    },
    searchHandler: azureSearch,
    testEvent: 'test-azure-connection',
    async testConnection(config) {
      const token = Buffer.from(`:${config.personalAccessToken}`).toString('base64');
      const testUrl = `https://almsearch.dev.azure.com/${config.organization}/${config.project}/_apis/search/workitemsearchresults?api-version=7.1`;

      const response = await axios.post(
        testUrl,
        {
          searchText: 'test',
          $skip: 0,
          $top: 1,
          filters: {
            'System.TeamProject': [config.project]
          }
        },
        {
          headers: {
            Authorization: `Basic ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000,
          validateStatus: false
        }
      );

      if (response.status !== 200) {
        throw new Error(`API returned status ${response.status}: ${response.statusText || 'Unknown error'}`);
      }

      return {
        success: true,
        message: 'Connection successful! Your Azure DevOps integration is working properly.'
      };
    },
    formatTestError(error) {
      return validators.formatTestError(error, 'Azure DevOps');
    }
  },
  asana: {
    id: 'asana',
    displayName: 'Asana',
    sourceName: 'Asana',
    filterKey: 'asana',
    configDefaults: {
      enabled: true,
      personalAccessToken: '',
      workspace: '',
      project: '',
      searchShortcut: 'as'
    },
    sensitiveKeys: ['personalAccessToken'],
    allowedKeys: ['enabled', 'personalAccessToken', 'workspace', 'project', 'searchShortcut'],
    resultExtractor: (value) => {
      if (Array.isArray(value)) {
        return value;
      }
      if (value && Array.isArray(value.results)) {
        return value.results;
      }
      return [];
    },
    validateSearchConfig: (config) => {
      if (!validators.hasRequiredFields(config, ['personalAccessToken'])) {
        return validators.formatMissingFieldsError(config, 'Asana', ['personalAccessToken']);
      }
      return null;
    },
    validateTestConfig: (config) => {
      if (!validators.hasRequiredFields(config, ['personalAccessToken'])) {
        return validators.formatMissingFieldsError(config, 'Asana', ['personalAccessToken']);
      }
      return null;
    },
    searchHandler: searchAsana,
    testEvent: 'test-asana-connection',
    async testConnection(config) {
      const baseHeaders = {
        Authorization: `Bearer ${config.personalAccessToken}`,
        Accept: 'application/json'
      };

      const meResponse = await axios.get('https://app.asana.com/api/1.0/users/me', {
        headers: baseHeaders,
        timeout: 10000,
        validateStatus: false
      });

      if (meResponse.status !== 200) {
        throw new Error(`API returned status ${meResponse.status}: ${meResponse.statusText || 'Unknown error'}`);
      }

      let additionalMessage = '';

      if (config.workspace) {
        try {
          const workspaceResponse = await axios.get(`https://app.asana.com/api/1.0/workspaces/${config.workspace}`, {
            headers: baseHeaders,
            timeout: 5000,
            validateStatus: false
          });

          additionalMessage += workspaceResponse.status === 200
            ? ' Workspace verified.'
            : ' Warning: Could not verify workspace ID.';
        } catch (workspaceError) {
          additionalMessage += ' Warning: Could not verify workspace ID.';
        }
      }

      if (config.project) {
        try {
          const projectResponse = await axios.get(`https://app.asana.com/api/1.0/projects/${config.project}`, {
            headers: baseHeaders,
            timeout: 5000,
            validateStatus: false
          });

          additionalMessage += projectResponse.status === 200
            ? ' Project verified.'
            : ' Warning: Could not verify project ID.';
        } catch (projectError) {
          additionalMessage += ' Warning: Could not verify project ID.';
        }
      }

      return {
        success: true,
        message: `Connection successful! Your Asana integration is working properly.${additionalMessage}`
      };
    },
    formatTestError(error) {
      return validators.formatTestError(error, 'Asana');
    }
  }
};

module.exports = Object.freeze(integrationRegistry);
