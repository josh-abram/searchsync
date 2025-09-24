const axios = require('axios');
const Logger = require('../utils/logger');
const { createAuthError, createValidationError, wrapUnknownError } = require('../utils/integration-errors');
const { generateCorrelationId, validateRequiredFields, normalizeBaseUrl, normalizeAtlassianDate } = require('./utils');

// Create logger instance
const logger = new Logger({
  component: 'JiraIntegration'
});

/**
 * Search for issues in Jira Service Desk
 * @param {string} query - The search query
 * @param {object} config - Jira configuration
 * @returns {Promise<Array>} - Array of search results
 */
async function searchJira(query, config) {
  const correlationId = generateCorrelationId();

  try {
    // Validate required fields
    const validationError = validateRequiredFields(config, ['baseUrl', 'apiToken', 'email']);
    if (validationError) {
      throw createValidationError('jira', 'config', validationError);
    }

    // Normalize base URL
    const baseUrl = normalizeBaseUrl(config.baseUrl);

    // Create Basic auth token from email and API token
    const token = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');

    if (config.productType === 'serviceDesk') {
      logger.debug('Searching Jira Service Management', {
        query,
        correlationId
      });

      const serviceDeskResponse = await axios.get(
        `${baseUrl}/rest/servicedeskapi/request`,
        {
          params: {
            search: query,
            start: 0,
            limit: Math.min(config.maxResults || 50, 100)
          },
          headers: {
            'Authorization': `Basic ${token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      const requests = Array.isArray(serviceDeskResponse.data?.values)
        ? serviceDeskResponse.data.values
        : [];

      const results = requests.map((request) => ({
        id: request.issueId || request.issueKey,
        title: `${request.issueKey || 'Request'}: ${request.requestFieldValues?.find(field => field.fieldId === 'summary')?.value || request.summary || 'No summary'}`,
        description: request.requestFieldValues?.find(field => field.fieldId === 'description')?.value || request.description || 'No description available',
        url: request._links?.web || `${baseUrl}/browse/${request.issueKey}`,
        source: 'Jira Service Management',
        updated: normalizeAtlassianDate(request.updatedDate) || normalizeAtlassianDate(request.createdDate),
        created: normalizeAtlassianDate(request.createdDate),
        type: request.requestType?.name || 'Request',
        status: request.currentStatus?.status || 'Unknown',
        metadata: {
          serviceDeskId: request.serviceDeskId,
          requestTypeId: request.requestTypeId,
          requestParticipants: request.requestParticipants || [],
          reporter: request.reporter?.displayName || request.reporter?.name || 'Unknown'
        }
      }));

      logger.info('Jira Service Management search completed', {
        resultCount: results.length,
        totalResults: serviceDeskResponse.data?.size || results.length,
        correlationId
      });

      return results;
    }

    // Build JQL query
    const searchTerms = query.split(/\s+/).filter(term => term.length > 2);
    let jql = 'issueKey IS NOT EMPTY ORDER BY updated DESC';

    if (searchTerms.length > 0) {
      const searchText = searchTerms.join(' OR ');
      jql = `text ~ "${searchText}" ORDER BY updated DESC`;
    }

    // Add project filters if specified
    if (config.projectKeys && Array.isArray(config.projectKeys) && config.projectKeys.length > 0) {
      const projectFilter = config.projectKeys.map(key => `project = "${key}"`).join(' OR ');
      const orderIndex = jql.toLowerCase().indexOf('order by');
      if (orderIndex !== -1) {
        const beforeOrder = jql.slice(0, orderIndex).trimEnd();
        const orderClause = jql.slice(orderIndex);
        jql = `${beforeOrder} AND (${projectFilter}) ${orderClause}`;
      } else {
        jql = `${jql} AND (${projectFilter})`;
      }
    }

    logger.debug('Searching Jira', {
      query,
      jql,
      projectKeys: config.projectKeys,
      correlationId
    });

    // Standard Jira Cloud search endpoint
    const searchUrl = `${baseUrl}/rest/api/3/search`;

    // Define fields to retrieve
    const fields = [
      'summary', 'description', 'status', 'issuetype', 'updated', 'project',
      'assignee', 'created', 'priority', 'reporter', 'labels', 'components',
      'resolution', 'comment', 'attachment', 'duedate', 'timeoriginalestimate',
      'timespent', 'statuscategorychangedate', 'customfield_10014', 'parent'
    ];

    const response = await axios.post(
      searchUrl,
      {
        jql: jql,
        fields: fields,
        maxResults: Math.min(config.maxResults || 50, 100),
        startAt: 0
      },
      {
        headers: {
          'Authorization': `Basic ${token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 15000,
        params: {
          validateQuery: 'warn'
        }
      }
    );

    const issues = response.data?.issues || [];
    const results = processJiraIssues(issues, baseUrl, query);

    logger.info('Jira search completed', {
      resultCount: results.length,
      totalResults: response.data?.total || 0,
      correlationId
    });

    return results;

  } catch (error) {
    logger.error('Jira search failed', {
      error: error.message,
      correlationId
    });

    // Handle specific error cases
    if (error.response) {
      switch (error.response.status) {
        case 410:
          // Endpoint or product not available (commonly Jira not enabled on the site)
          throw new Error('Jira not enabled for this site.');
        case 400:
          // Bad request - likely invalid JQL
          throw createValidationError(
            'jira',
            'jql',
            Array.isArray(error.response.data?.errorMessages)
              ? error.response.data.errorMessages.join('; ')
              : error.response.data?.message || 'Invalid search query'
          );

        case 401:
        case 403:
          throw createAuthError('jira', 'Authentication failed', error);

        case 404:
          throw createValidationError('jira', 'url', 'Jira instance not found');

        case 429:
          const retryAfter = error.response.headers['retry-after'];
          throw new Error(`Rate limit exceeded${retryAfter ? `. Retry after ${retryAfter}s` : ''}`);

        default:
          throw wrapUnknownError('jira', error);
      }
    }

    // Handle network errors
    if (error.code === 'ECONNABORTED') {
      throw new Error('Request timeout. Please try again.');
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new Error('Network error: Unable to connect to Jira.');
    }

    throw wrapUnknownError('jira', error);
  }
}

/**
 * Extract plain text from Jira description (handles both string and ADF format)
 * @param {any} description - Jira issue description (can be string or object)
 * @returns {string} - Plain text description
 */
function getPlainTextDescription(description) {
  if (!description) return '';

  if (typeof description === 'string') {
    return description;
  }

  if (description.content && Array.isArray(description.content)) {
    try {
      // Extract text from Atlassian Document Format (ADF)
      let text = '';

      // Recursive function to extract text from ADF nodes
      function extractText(node) {
        if (!node) return '';

        if (node.text) {
          return node.text;
        }

        if (node.content && Array.isArray(node.content)) {
          return node.content.map(extractText).join(' ');
        }

        return '';
      }

      // Process each top-level paragraph
      description.content.forEach(paragraph => {
        text += extractText(paragraph) + ' ';
      });

      return text.trim();
    } catch (e) {
    logger.error('Error parsing Jira description', { error: e.message });
    return '';
  }
  }

  return '';
}

/**
 * Process Jira issues into a standardized format
 * @param {Array} issues - The issues from Jira API
 * @param {string} baseUrl - The Jira base URL
 * @param {string} originalQuery - The original search query
 * @returns {Array} - Processed issues
 */
function processJiraIssues(issues, baseUrl, originalQuery = null) {
  if (!issues || !Array.isArray(issues)) {
    logger.warn('No issues provided to processJiraIssues');
    return [];
  }

  return issues.map(issue => {
    const fields = issue.fields || {};

    // Extract plain text description if available
    const description = getPlainTextDescription(fields.description);

    // Normalize key dates
    const normalizedCreated = normalizeAtlassianDate(fields.created);
    const normalizedUpdated = normalizeAtlassianDate(fields.updated);
    const normalizedStatusChange = normalizeAtlassianDate(fields.statuscategorychangedate) || normalizedUpdated;

    // Extract additional metadata
    const statusCategory = fields.status?.statusCategory?.colorName || 'gray';
    const labels = fields.labels ? fields.labels.map(label => label) : [];
    const components = fields.components ? fields.components.map(comp => comp.name) : [];
    const reporter = fields.reporter?.displayName || 'Unknown';
    const resolution = fields.resolution?.name || null;

    // Calculate time in status
    const daysSinceStatusChange = normalizedStatusChange ?
      Math.floor((Date.now() - new Date(normalizedStatusChange)) / (1000 * 60 * 60 * 24)) : null;

    // Extract epic link if available
    const epicLink = fields.customfield_10014 || fields.parent?.key || null;
    
    // Count comments and attachments
    const commentCount = fields.comment?.total || 0;
    const attachmentCount = fields.attachment ? fields.attachment.length : 0;
    
    // Return standardized result format with enhanced metadata
    return {
      id: issue.key,
      title: `${issue.key}: ${fields.summary || 'No summary'}`,
      description: description || 'No description available',
      url: `${baseUrl}/browse/${issue.key}`,
      source: 'Jira',
      updated: normalizedUpdated,
      created: normalizedCreated,
      type: fields.issuetype?.name || 'Task',
      status: fields.status?.name || 'Unknown',
      metadata: {
        // Basic info
        status: fields.status?.name || 'Unknown',
        statusCategory: statusCategory,
        issueType: fields.issuetype?.name || 'Task',
        priority: fields.priority?.name || 'Medium',
        priorityIcon: fields.priority?.iconUrl || null,
        
        // Project and hierarchy
        project: fields.project?.name || 'Unknown',
        projectKey: fields.project?.key || 'Unknown',
        epicLink: epicLink,
        
        // People
        assignee: fields.assignee?.displayName || 'Unassigned',
        assigneeAvatar: fields.assignee?.avatarUrls?.['24x24'] || null,
        reporter: reporter,
        
        // Classification
        labels: labels,
        components: components,
        resolution: resolution,
        
        // Activity metrics
        commentCount: commentCount,
        attachmentCount: attachmentCount,
        daysSinceStatusChange: daysSinceStatusChange,
        
        // Time tracking (if available)
        timeEstimate: fields.timeoriginalestimate || null,
        timeSpent: fields.timespent || null,
        
        // Dates
        dueDate: fields.duedate || null,
        createdDate: normalizedCreated,
        updatedDate: normalizedUpdated
      },
      
      // Add activity indicators
      activityIndicators: {
        hasRecentActivity: daysSinceStatusChange !== null && daysSinceStatusChange <= 7,
        hasComments: commentCount > 0,
        hasAttachments: attachmentCount > 0,
        isOverdue: fields.duedate && new Date(fields.duedate) < new Date(),
        isAssignedToMe: false // Will be set based on user context if available
      }
    };
  });
}

module.exports = searchJira;
