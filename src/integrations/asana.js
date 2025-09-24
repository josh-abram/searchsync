/**
 * Asana integration for SearchSync
 *
 * This module provides functionality to search for tasks in Asana.
 */

const axios = require('axios');
const Logger = require('../utils/logger');
const { createAuthError, createValidationError, wrapUnknownError } = require('../utils/integration-errors');
const { generateCorrelationId, validateRequiredFields } = require('./utils');

// Create logger instance
const logger = new Logger({
  component: 'AsanaIntegration'
});

/**
 * Search Asana for tasks matching the query
 *
 * @param {string} query - The search query
 * @param {Object} config - Configuration for the Asana API
 * @param {string} config.personalAccessToken - Asana Personal Access Token
 * @param {string} [config.workspace] - Optional workspace ID to limit search to
 * @param {string} [config.project] - Optional project ID to limit search to
 * @returns {Promise<Array>} - Promise resolving to an array of search results
 */
async function searchAsana(query, config) {
  const correlationId = generateCorrelationId();

  try {
    // Validate required fields
    const validationError = validateRequiredFields(config, ['personalAccessToken']);
    if (validationError) {
      throw createValidationError('asana', 'config', validationError);
    }

    // Validate workspace GID with user feedback
    if (config.workspace && !/^\d+$/.test(config.workspace)) {
      logger.warn('Non-numeric workspace ID detected', {
        workspace: config.workspace,
        correlationId,
        suggestion: 'Asana workspace GIDs should be numeric (e.g., "1234567890")'
      });

      // Continue with the invalid workspace ID - the API will reject it
    }

    // Prepare search parameters
    let searchParams = {
      opt_fields: 'name,notes,completed,due_on,created_at,modified_at,permalink_url,assignee.name,projects.name,workspace.name',
      limit: 100
    };

    // Add project filter if provided
    if (config.project) {
      searchParams.project = config.project;
    }

    // Make the API request to search for tasks
    // According to Asana API documentation, we need to use the workspace parameter
    // and the correct parameter for search text is 'text'
    let url = 'https://app.asana.com/api/1.0/workspaces';
    let params = { ...searchParams };

    if (config.workspace) {
      // If workspace is provided, search within that workspace
      url = `${url}/${config.workspace}/tasks/search`;
    } else {
      // If no workspace is provided, first get the user's workspaces
      const workspacesResponse = await axios({
        method: 'get',
        url: 'https://app.asana.com/api/1.0/workspaces',
        headers: {
          'Authorization': `Bearer ${config.personalAccessToken}`,
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      if (!workspacesResponse.data.data || workspacesResponse.data.data.length === 0) {
        throw new Error('No workspaces found for the user');
      }

      // Use the first workspace
      const defaultWorkspace = workspacesResponse.data.data[0].gid;
      url = `${url}/${defaultWorkspace}/tasks/search`;
    }

    // Set the search text parameter
    params.text = query;

    // Make the API request
    const response = await axios({
      method: 'get',
      url: url,
      params: params,
      headers: {
        'Authorization': `Bearer ${config.personalAccessToken}`,
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    // Process the results
    const tasks = response.data.data || [];

    logger.debug('Asana search results', {
      taskCount: tasks.length,
      correlationId
    });

    // Transform the results to the standard format with enhanced metadata
    const results = tasks.map(task => {
      // Calculate activity metrics
      const createdDate = task.created_at;
      const modifiedDate = task.modified_at;
      const dueDate = task.due_on;
      
      const daysSinceCreated = createdDate ? 
        Math.floor((new Date() - new Date(createdDate)) / (1000 * 60 * 60 * 24)) : null;
      const daysSinceModified = modifiedDate ? 
        Math.floor((new Date() - new Date(modifiedDate)) / (1000 * 60 * 60 * 24)) : null;
      const daysUntilDue = dueDate ? 
        Math.floor((new Date(dueDate) - new Date()) / (1000 * 60 * 60 * 24)) : null;
      
      // Extract project information
      const projects = task.projects || [];
      const primaryProject = projects.length > 0 ? projects[0] : null;
      
      // Extract workspace information
      const workspace = task.workspace;
      
      // Format the result with standardized fields and enhanced metadata
      return {
        title: task.name,
        description: task.notes || '',
        url: task.permalink_url,
        source: 'Asana',
        type: 'task',
        status: task.completed ? 'completed' : 'active',
        updated: task.modified_at || task.created_at,
        metadata: {
          // Basic info
          completed: task.completed,
          taskId: task.gid,
          
          // Dates
          dueOn: task.due_on,
          createdAt: task.created_at,
          modifiedAt: task.modified_at,
          completedAt: task.completed_at || null,
          
          // People
          assignee: task.assignee ? task.assignee.name : null,
          assigneeGid: task.assignee ? task.assignee.gid : null,
          
          // Project and workspace
          project: primaryProject ? primaryProject.name : null,
          projectGid: primaryProject ? primaryProject.gid : null,
          projectCount: projects.length,
          allProjects: projects.map(p => ({ name: p.name, gid: p.gid })),
          workspace: workspace ? workspace.name : null,
          workspaceGid: workspace ? workspace.gid : null,
          
          // Activity metrics
          daysSinceCreated: daysSinceCreated,
          daysSinceModified: daysSinceModified,
          daysUntilDue: daysUntilDue,
          
          // Content indicators
          hasNotes: !!(task.notes && task.notes.trim()),
          notesLength: task.notes ? task.notes.length : 0
        },
        
        // Add activity indicators
        activityIndicators: {
          hasRecentActivity: daysSinceModified !== null && daysSinceModified <= 7,
          isNew: daysSinceCreated !== null && daysSinceCreated <= 3,
          isOverdue: daysUntilDue !== null && daysUntilDue < 0 && !task.completed,
          isDueSoon: daysUntilDue !== null && daysUntilDue >= 0 && daysUntilDue <= 7 && !task.completed,
          isAssignedToMe: false, // Will be set based on user context if available
          hasMultipleProjects: projects.length > 1,
          hasDetailedNotes: task.notes && task.notes.length > 100
        }
      };
    });

    // Return results without local sorting
    return {
      results: results
    };

  } catch (error) {
    logger.error('Asana search failed', {
      error: error.message,
      correlationId
    });

    // Handle specific error cases
    if (error.response) {
      switch (error.response.status) {
        case 400:
          // Check if it's a workspace format error
          if (error.response.data?.errors?.[0]?.message?.includes('workspace')) {
            throw createValidationError(
              'asana',
              'workspace',
              'Invalid workspace ID format. Workspace GIDs should be numeric.'
            );
          }
          throw createValidationError('asana', 'request', 'Invalid request parameters');

        case 401:
        case 403:
          throw createAuthError('asana', 'Authentication failed', error);

        case 404:
          throw createValidationError('asana', 'resource', 'Workspace or project not found');

        case 429:
          const retryAfter = error.response.headers['retry-after'];
          throw new Error(`Rate limit exceeded${retryAfter ? `. Retry after ${retryAfter}s` : ''}`);

        default:
          throw wrapUnknownError('asana', error);
      }
    }

    // Handle network errors
    if (error.code === 'ECONNABORTED') {
      throw new Error('Request timeout. Please try again.');
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new Error('Network error: Unable to connect to Asana.');
    }

    throw wrapUnknownError('asana', error);
  }
}

module.exports = {
  searchAsana
};