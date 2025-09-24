const axios = require('axios');

// Azure DevOps validation patterns - enhanced with Unicode protection
const AZURE_DEVOPS_ORG_REGEX = /^[a-zA-Z0-9](?!.*--)[a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$/;
const AZURE_DEVOPS_PROJECT_REGEX = /^[a-zA-Z0-9_](?!.*\s$)(?!.*_$)(?!.*-$)[a-zA-Z0-9_\-\s]{0,62}[a-zA-Z0-9_]$/;

// Unicode homoglyph protection
const UNICODE_HOMOGLYPHS = /[\u0250-\u02AF\u1D00-\u1D7F\u1D80-\u1DBF\u1DC0-\u1DFF\u20D0-\u20FF\u2DE0-\u2DFF\uA640-\uA69F\uA720-\uA7FF]/g;

/**
 * Validate Azure DevOps organization name
 * @param {string} organization - Organization name to validate
 * @returns {boolean} - True if valid
 */
function validateOrganization(organization) {
  if (!organization || typeof organization !== 'string') return false;

  // Remove leading/trailing whitespace and check length
  const trimmed = organization.trim();

  // Basic validation
  if (trimmed.length < 3 || trimmed.length > 64) return false;

  // Check for Unicode homoglyphs that could be used for spoofing
  if (UNICODE_HOMOGLYPHS.test(trimmed)) {
    return false;
  }

  // Prevent path traversal attempts
  if (trimmed.includes('../') || trimmed.includes('..\\') || trimmed.includes('/..') || trimmed.includes('\\..')) {
    return false;
  }

  // Enhanced regex validation - prevents consecutive hyphens
  return AZURE_DEVOPS_ORG_REGEX.test(trimmed);
}

/**
 * Validate Azure DevOps project name
 * @param {string} project - Project name to validate
 * @param {boolean} allowSpaces - Whether to allow spaces in project name
 * @returns {boolean} - True if valid
 */
function validateProject(project, allowSpaces = true) {
  if (!project || typeof project !== 'string') return false;

  // Remove leading/trailing whitespace
  const trimmed = project.trim();

  // Basic validation
  if (trimmed.length < 1 || trimmed.length > 64) return false;

  // Check for Unicode homoglyphs
  if (UNICODE_HOMOGLYPHS.test(trimmed)) {
    return false;
  }

  // Prevent path traversal and injection attempts
  if (trimmed.includes('../') || trimmed.includes('..\\') || trimmed.includes('/..') || trimmed.includes('\\..')) {
    return false;
  }

  // Project names cannot start or end with spaces, dashes, or underscores
  if (trimmed.startsWith(' ') || trimmed.endsWith(' ')) return false;
  if (trimmed.startsWith('-') || trimmed.endsWith('-')) return false;
  if (trimmed.startsWith('_') || trimmed.endsWith('_')) return false;

  // Additional checks for special characters that could cause issues
  if (/[<>:"|?*]/.test(trimmed)) {
    return false;
  }

  return AZURE_DEVOPS_PROJECT_REGEX.test(trimmed);
}

/**
 * Search for work items in Azure DevOps
 * @param {string} query - The search query
 * @param {object} config - Azure DevOps configuration
 * @returns {Promise<Array>} - Array of search results
 */
async function searchAzureDevOps(query, config) {
  if (!config.organization || !config.project || !config.personalAccessToken) {
    throw new Error('Azure DevOps configuration is incomplete');
  }

  // Validate organization and project names to prevent injection attacks
  if (!validateOrganization(config.organization)) {
    throw new Error('Invalid Azure DevOps organization name format. Please check your organization name and try again.');
  }

  if (!validateProject(config.project)) {
    throw new Error('Invalid Azure DevOps project name format. Please check your project name and try again.');
  }

  // Base64 encode the PAT with empty username (PAT is the password)
  const token = Buffer.from(`:${config.personalAccessToken}`).toString('base64');

  // Use validated and trimmed values in URL construction
  const validatedOrg = config.organization.trim();
  const validatedProject = config.project.trim();

  // Use the Work Item Search API as per the documentation
  const searchUrl = `https://almsearch.dev.azure.com/${encodeURIComponent(validatedOrg)}/${encodeURIComponent(validatedProject)}/_apis/search/workitemsearchresults?api-version=7.1`;

  
  try {
    // Extract potential keywords for client-side filtering
    const searchText = query;
    const keywords = searchText.toLowerCase().split(/\s+/).filter(word => word.length > 2);

    // Prepare the search request payload according to the API documentation
    const searchPayload = {
      searchText: searchText || "type:any",
      $skip: 0,
      $top: 50, // Limit to 50 results
      filters: {
        "System.TeamProject": [config.project]
      },
      includeFacets: false
    };

    // Make the search request
    const searchResponse = await axios.post(searchUrl, searchPayload, {
      headers: {
        'Authorization': `Basic ${token}`, // token is already sanitized before logging
        'Content-Type': 'application/json'
      },
      timeout: 10000,
      validateStatus: false
    });

    // Check for non-200 responses
    if (searchResponse.status !== 200) {
      throw new Error(`Azure DevOps API returned status ${searchResponse.status}: ${searchResponse.statusText || 'Unknown error'}`);
    }

    // Check if the response has the expected structure
    if (!searchResponse.data || !searchResponse.data.results) {
      throw new Error('Unexpected response format from Azure DevOps API');
    }

    const results = [];

    // Process the search results directly
    if (searchResponse.data.results && searchResponse.data.results.length > 0) {
      // Map the search results to our result format
      searchResponse.data.results.forEach(item => {
        // Extract additional metadata
        const priority = item.fields['microsoft.vsts.common.priority'] || item.fields['system.priority'] || 'Medium';
        const severity = item.fields['microsoft.vsts.common.severity'] || null;
        const assignedTo = item.fields['system.assignedto']?.displayName || 'Unassigned';
        const createdBy = item.fields['system.createdby']?.displayName || 'Unknown';
        const teamProject = item.fields['system.teamproject'] || config.project;
        const areaPath = item.fields['system.areapath'] || '';
        const iterationPath = item.fields['system.iterationpath'] || '';
        const tags = item.fields['system.tags'] ? item.fields['system.tags'].split(';').map(tag => tag.trim()).filter(tag => tag) : [];
        
        // Calculate activity metrics
        const createdDate = item.fields['system.createddate'];
        const changedDate = item.fields['system.changeddate'];
        const daysSinceCreated = createdDate ? 
          Math.floor((new Date() - new Date(createdDate)) / (1000 * 60 * 60 * 24)) : null;
        const daysSinceUpdated = changedDate ? 
          Math.floor((new Date() - new Date(changedDate)) / (1000 * 60 * 60 * 24)) : null;
        
        // Work item relationships
        const parentUrl = item.fields['system.parent'] || null;
        const hasChildren = item.fields['system.haschildren'] || false;
        
        // Effort estimates
        const originalEstimate = item.fields['microsoft.vsts.scheduling.originalestimate'] || null;
        const remainingWork = item.fields['microsoft.vsts.scheduling.remainingwork'] || null;
        const completedWork = item.fields['microsoft.vsts.scheduling.completedwork'] || null;
        const storyPoints = item.fields['microsoft.vsts.scheduling.storypoints'] || null;
        
        // Reason for current state
        const reason = item.fields['system.reason'] || null;
        
        results.push({
          id: item.fields['system.id'],
          title: item.fields['system.title'] || 'No title',
          description: item.fields['system.description'] ?
            stripHtml(item.fields['system.description']).substring(0, 100) + '...' :
            'No description',
          url: item.url || `https://dev.azure.com/${encodeURIComponent(validatedOrg)}/${encodeURIComponent(validatedProject)}/_workitems/edit/${item.fields['system.id']}`,
          source: 'Azure DevOps',
          type: item.fields['system.workitemtype'] || 'Unknown',
          status: item.fields['system.state'] || 'Unknown',
          updated: item.fields['system.changeddate'] || new Date().toISOString(),
          metadata: {
            // Basic info
            workItemType: item.fields['system.workitemtype'] || 'Unknown',
            state: item.fields['system.state'] || 'Unknown',
            reason: reason,
            priority: priority,
            severity: severity,
            
            // Project structure
            teamProject: teamProject,
            areaPath: areaPath,
            iterationPath: iterationPath,
            
            // People
            assignedTo: assignedTo,
            createdBy: createdBy,
            changedBy: item.fields['system.changedby']?.displayName || 'Unknown',
            
            // Classification
            tags: tags,
            
            // Hierarchy
            parentUrl: parentUrl,
            hasChildren: hasChildren,
            
            // Effort tracking
            originalEstimate: originalEstimate,
            remainingWork: remainingWork,
            completedWork: completedWork,
            storyPoints: storyPoints,
            
            // Activity metrics
            daysSinceCreated: daysSinceCreated,
            daysSinceUpdated: daysSinceUpdated,
            
            // Dates
            createdDate: createdDate,
            changedDate: changedDate
          },
          
          // Add activity indicators
          activityIndicators: {
            hasRecentActivity: daysSinceUpdated !== null && daysSinceUpdated <= 7,
            isNew: daysSinceCreated !== null && daysSinceCreated <= 3,
            hasEstimates: originalEstimate !== null || storyPoints !== null,
            isAssignedToMe: false, // Will be set based on user context if available
            hasChildren: hasChildren,
            isHighPriority: priority === '1' || priority === 'High' || priority === 'Critical'
          }
        });
      });
    }

    // If we have keywords from NLP, use them for client-side filtering
    if (keywords.length > 0 && results.length > 0) {
      
      const filteredResults = results.filter(item => {
        const title = (item.title || '').toLowerCase();
        const description = (item.description || '').toLowerCase();
        const type = (item.type || '').toLowerCase();
        const status = (item.status || '').toLowerCase();

        // Check if any keyword is found in the item fields
        return keywords.some(term =>
          title.includes(term) ||
          description.includes(term) ||
          type.includes(term) ||
          status.includes(term)
        );
      });

      return filteredResults;
    }

    // Return raw results without local relevance scoring
    return results;
  } catch (error) {
    // Provide sanitized error information to prevent information disclosure
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      const statusCode = error.response.status;
      let errorMessage = `Azure DevOps API request failed`;

      // Add generic guidance for common error codes without exposing sensitive details
      if (statusCode === 401) {
        errorMessage = "Authentication failed. Please check your Personal Access Token and ensure it has the necessary permissions.";
      } else if (statusCode === 403) {
        errorMessage = "Access denied. Your Personal Access Token may not have the required permissions.";
      } else if (statusCode === 404) {
        errorMessage = "Resource not found. Please verify your organization and project names.";
      } else if (statusCode >= 500) {
        errorMessage = "Azure DevOps service unavailable. Please try again later.";
      } else {
        errorMessage = `Azure DevOps API request failed with status ${statusCode}. Please check your configuration.`;
      }

      throw new Error(errorMessage);
    } else if (error.request) {
      // The request was made but no response was received
      throw new Error("Network error: Unable to connect to Azure DevOps. Please check your internet connection.");
    } else {
      // Something happened in setting up the request that triggered an Error
      throw new Error("Azure DevOps configuration error. Please check your settings.");
    }
  }
}

/**
 * Simple function to strip HTML tags from a string
 * @param {string} html - HTML string
 * @returns {string} - Text without HTML tags
 */
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>?/gm, '');
}

module.exports = searchAzureDevOps;